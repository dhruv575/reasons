/**
 * Claude Code hook dispatcher. One entry point, `reasons hook`, reads the hook
 * payload on stdin and dispatches on event + tool:
 *
 *   PostToolUse Read            -> attach live reasons for the file (push, never pull)
 *   PreToolUse  Edit/Write      -> warn when the edit touches an annotated region
 *   PostToolUse Edit/Write      -> remember what was edited this session
 *   PostToolUse Bash            -> detect a test run going red -> green, or a revert,
 *                                  and ask for the reason at that moment
 *
 * Everything is best-effort and silent on failure: a broken hook must never
 * get in the agent's way.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toRepoPath, loadReasons } from "./store.js";
import { resolveFile, type Resolved } from "./locate.js";
import { cliCmd } from "./env.js";

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

interface Session {
  testFailedAt?: number;            // ms epoch of the last failing test run
  editsSinceFail: string[];         // "file:start-end" edited after that failure
  reasonsAtFail?: number;           // how many reasons existed when tests went red
  nudged: number;                   // how many red->green prompts we've issued
  unrecordedFix?: string[];         // edits from the last red->green that went unrecorded
  recentEdits?: Array<{ file: string; oldH: string; newH: string }>; // for undo detection
  stopAsked?: boolean;              // the one end-of-session question has been asked
}

// Both patterns only match at a shell command boundary (start, or after ; && || | newline),
// otherwise a command that merely *mentions* "git checkout --" inside a string sets them off.
const AT_CMD = String.raw`(?:^|[;&|]\s*|\n\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?`;
const TEST_CMD = new RegExp(AT_CMD + String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx\s+)?(?:jest|vitest|mocha|ava|tap|pytest|py\.test|cargo\s+test|go\s+test|dotnet\s+test|rspec|phpunit|mvn\s+test|gradle\s+test)\b|node\s+(?:--test|\S+\s+--test)\b|tsx\s+--test\b)`);
const REVERT_CMD = new RegExp(AT_CMD + String.raw`git\s+(?:revert|restore|checkout\s+(?:--|HEAD)|reset\s+--hard|stash\s+pop)(?=\s|$)`);
const FAIL_SIGNS = /\b(FAIL|failed|failing|not ok|AssertionError|Error:|✖|✗|Traceback|panicked|FAILED)\b|\bfail\s+[1-9]/;
const MAX_NUDGES = 3;
const MAX_SHOWN = 12; // per Read; more than this is noise, the agent can ask for the rest

function sessionPath(id: string) {
  const dir = join(tmpdir(), "reasons-sessions");
  mkdirSync(dir, { recursive: true });
  // Housekeeping: session files older than a week are from sessions that no longer exist.
  try {
    const cutoff = Date.now() - 7 * 86400_000;
    for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).mtimeMs < cutoff) unlinkSync(p); }
  } catch { /* ignore */ }
  return join(dir, `${id.replace(/[^\w-]/g, "_")}.json`);
}
function loadSession(id: string): Session {
  try { return JSON.parse(readFileSync(sessionPath(id), "utf8")); } catch { return { editsSinceFail: [], nudged: 0 }; }
}
function saveSession(id: string, s: Session) { try { writeFileSync(sessionPath(id), JSON.stringify(s)); } catch { /* ignore */ } }

function emit(event: string, context: string) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

function where(r: Resolved): string {
  const { res } = r;
  return res.startLine === res.endLine ? `line ${res.startLine}` : `lines ${res.startLine}-${res.endLine}`;
}

function liveReasons(root: string, filePath: string): { repoFile: string; live: Resolved[] } | undefined {
  const repoFile = toRepoPath(root, filePath);
  if (repoFile.startsWith("..")) return; // outside this repo
  const live = resolveFile(root, repoFile).filter((r) => r.res.status !== "stale");
  return { repoFile, live };
}

function onRead(root: string, input: HookInput) {
  const filePath = input.tool_input?.file_path as string | undefined;
  if (!filePath) return;
  const found = liveReasons(root, filePath);
  if (!found?.live.length) return;
  // A windowed Read only gets the reasons inside the window, plus a count of the rest.
  const offset = Number(input.tool_input?.offset ?? 0) || 0, limit = Number(input.tool_input?.limit ?? 0) || 0;
  const lo = offset > 0 ? offset : 1, hi = limit > 0 ? lo + limit - 1 : Infinity;
  const inWindow = found.live.filter((r) => r.res.startLine! <= hi && r.res.endLine! >= lo);
  const shown = inWindow.slice(0, MAX_SHOWN);
  const outside = found.live.length - shown.length;
  const showCmd = `\`${cliCmd()} show ${found.repoFile}\``;
  if (!shown.length) {
    emit("PostToolUse", `${found.repoFile} has ${outside} recorded reason(s) outside the lines you read; ${showCmd} lists them.`);
    return;
  }
  const body = shown.map((r) => {
    const conf = r.res.status === "fuzzy" ? " (approximate location)" : "";
    const link = r.reason.link ? ` (${r.reason.link})` : "";
    return `- ${where(r)}${conf}: ${r.reason.note}${link}  [id ${r.reason.id}]`;
  }).join("\n");
  const more = outside ? `\n(${outside} more not shown; ${showCmd} lists all)` : "";
  emit("PostToolUse",
    `Recorded reasons for ${found.repoFile} (from .reasons/, authoritative; do not "clean up" these lines without addressing the note):\n${body}${more}`);
}

/** 1-based line range that `needle` occupies in `haystack`, or undefined. */
function rangeOf(haystack: string, needle: string): [number, number] | undefined {
  const idx = haystack.indexOf(needle);
  if (idx < 0 || !needle) return;
  const start = haystack.slice(0, idx).split("\n").length;
  return [start, start + needle.split("\n").length - 1];
}

function editedRanges(input: HookInput, fileText: string): Array<[number, number]> {
  const ti = input.tool_input ?? {};
  const olds: string[] = [];
  if (typeof ti.old_string === "string") olds.push(ti.old_string);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof e?.old_string === "string") olds.push(e.old_string);
  if (input.tool_name === "Write") return [[1, fileText.split("\n").length]];
  return olds.map((o) => rangeOf(fileText, o)).filter((r): r is [number, number] => !!r);
}

function onPreEdit(root: string, input: HookInput) {
  const filePath = input.tool_input?.file_path as string | undefined;
  if (!filePath || !existsSync(filePath)) return;
  const found = liveReasons(root, filePath);
  if (!found?.live.length) return;
  const text = readFileSync(filePath, "utf8");
  const ranges = editedRanges(input, text);
  const touched = found.live.filter((r) => ranges.some(([s, e]) => r.res.startLine! <= e && r.res.endLine! >= s));
  if (!touched.length) return;
  const body = touched.map((r) => `- ${where(r)}: ${r.reason.note}  [id ${r.reason.id}]`).join("\n");
  emit("PreToolUse",
    `Heads up: this edit touches code with a recorded reason in ${found.repoFile}:\n${body}\n` +
    `If your change honours the reason, carry on. If the reason no longer applies, say so and run \`${cliCmd()} rm <id>\`. ` +
    `If the reason changes, re-record it with \`${cliCmd()} add\`.`);
}

const h = (s: string) => createHash("sha1").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

function onPostEdit(root: string, input: HookInput) {
  const id = input.session_id; const filePath = input.tool_input?.file_path as string | undefined;
  if (!id || !filePath) return;
  const repoFile = toRepoPath(root, filePath);
  if (repoFile.startsWith("..")) return;
  const s = loadSession(id);
  const ti = input.tool_input ?? {};
  const pairs: Array<{ o: string; n: string }> = [];
  if (typeof ti.old_string === "string" && typeof ti.new_string === "string") pairs.push({ o: ti.old_string, n: ti.new_string });
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof e?.old_string === "string" && typeof e?.new_string === "string") pairs.push({ o: e.old_string, n: e.new_string });

  // Undo detection: an edit whose new text equals the *old* text of an earlier edit in the same file
  // is the agent backing out its own change. Agents almost never `git revert`; this is their revert.
  s.recentEdits ??= [];
  let undone: string | undefined;
  for (const { o, n } of pairs) {
    const oh = h(o), nh = h(n);
    if (n.trim() && s.recentEdits.some((e) => e.file === repoFile && e.oldH === nh && e.newH !== nh)) undone = n;
    s.recentEdits.push({ file: repoFile, oldH: oh, newH: nh });
  }
  s.recentEdits = s.recentEdits.slice(-40);

  if (s.testFailedAt !== undefined) { // edits made while red are what the red->green prompt reports
    let range = "";
    try {
      const text = readFileSync(filePath, "utf8");
      const r = pairs.map((p) => rangeOf(text, p.n)).find(Boolean);
      if (r) range = `:${r[0]}-${r[1]}`;
    } catch { /* ignore */ }
    const entry = `${repoFile}${range}`;
    if (!s.editsSinceFail.includes(entry)) s.editsSinceFail.push(entry);
  }
  saveSession(id, s);

  if (undone && s.nudged < MAX_NUDGES) {
    s.nudged++; saveSession(id, s);
    const snippet = undone.trim().split("\n")[0].slice(0, 60);
    emit("PostToolUse",
      `You just restored earlier code in ${repoFile} (\`${snippet}\`), undoing your own change. ` +
      `If the attempt failed for a reason the code doesn't show, pin it to the line so nobody retries it: ` +
      `\`${cliCmd()} add ${repoFile} --match "<text on the line>" "tried X; failed because Y" --source claude-code\`. Skip if it was a typo.`);
  }
}

function responseText(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    return [r.stdout, r.stderr, r.output, r.content].filter((x) => typeof x === "string").join("\n");
  }
  return "";
}

function onBash(root: string, input: HookInput) {
  const id = input.session_id; const raw = String(input.tool_input?.command ?? "");
  if (!id || !raw) return;
  // Quoted strings are data, not commands: a payload that mentions `git checkout --` must not count.
  const cmd = raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  const s = loadSession(id);

  if (REVERT_CMD.test(cmd)) {
    if (s.nudged < MAX_NUDGES) {
      s.nudged++; saveSession(id, s);
      emit("PostToolUse",
        `You just reverted or restored code (\`${cmd.slice(0, 80)}\`). Reverts are where reasons get lost: ` +
        `if the approach you backed out is one a future reader (or you, next session) might retry, record why it didn't work ` +
        `on the line that would tempt them: \`${cliCmd()} add <file> --match "<text on the line>" "tried X; failed because Y" --source claude-code\`. Skip if it was a typo.`);
    }
    return;
  }

  if (!TEST_CMD.test(cmd)) return;
  const out = responseText(input.tool_response);
  const resp = (input.tool_response ?? {}) as Record<string, unknown>;
  const nonZero = typeof resp.exit_code === "number" ? resp.exit_code !== 0 : typeof resp.exitCode === "number" ? resp.exitCode !== 0 : undefined;
  const failed = nonZero ?? FAIL_SIGNS.test(out);

  if (failed) {
    if (s.testFailedAt === undefined) { s.testFailedAt = Date.now(); s.editsSinceFail = []; s.reasonsAtFail = loadReasons(root).length; }
    saveSession(id, s);
    return;
  }
  // Green. Was it red before, with edits in between?
  if (s.testFailedAt !== undefined && s.editsSinceFail.length) {
    const recorded = loadReasons(root).length > (s.reasonsAtFail ?? 0);
    const edits = s.editsSinceFail.slice(0, 6).map((e) => `  ${e}`).join("\n");
    if (!recorded) s.unrecordedFix = s.editsSinceFail;
    s.testFailedAt = undefined; s.editsSinceFail = [];
    if (!recorded && s.nudged < MAX_NUDGES) {
      s.nudged++;
      emit("PostToolUse",
        `Tests went red -> green after you edited:\n${edits}\n` +
        `If the fix was non-obvious (a value that has to be exactly this, an ordering constraint, a workaround for an upstream quirk), ` +
        `record the why now while you still know it: \`${cliCmd()} add <file> --match "<text on the line>" "one line" --source claude-code\`. ` +
        `If it was a plain bug with an obvious fix, skip this.`);
    }
  }
  saveSession(id, s);
}

/**
 * Session end. One question, once, only if a red->green fix went unrecorded
 * and nothing was added since. Anything else would train the agent to skip it.
 */
function onStop(root: string, input: HookInput & { stop_hook_active?: boolean }) {
  const id = input.session_id;
  if (!id || input.stop_hook_active) return; // never loop
  const s = loadSession(id);
  if (s.stopAsked || !s.unrecordedFix?.length) return;
  const recorded = loadReasons(root).length > (s.reasonsAtFail ?? 0);
  s.stopAsked = true; saveSession(id, s);
  if (recorded) return;
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason:
      `Before you finish: tests went red -> green after edits to\n` +
      s.unrecordedFix.slice(0, 6).map((e) => `  ${e}`).join("\n") + `\n` +
      `and no reason was recorded. If the fix depends on something a future reader wouldn't guess, record it now: ` +
      `\`${cliCmd()} add <file> --match "<text on the line>" "why" --source claude-code\`. If it was obvious, just say so and stop. This is asked once.`,
  }));
}

/** Exposed for tests. */
export const patterns = { TEST_CMD, REVERT_CMD, stripQuotes: (raw: string) => raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""') };

export function runHook(root: string): void {
  let input: HookInput = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return; }
  const ev = input.hook_event_name, tool = input.tool_name ?? "";
  try {
    if (ev === "PostToolUse" && tool === "Read") return onRead(root, input);
    if (ev === "PreToolUse" && /^(Edit|MultiEdit|Write)$/.test(tool)) return onPreEdit(root, input);
    if (ev === "PostToolUse" && /^(Edit|MultiEdit|Write)$/.test(tool)) return onPostEdit(root, input);
    if (ev === "PostToolUse" && tool === "Bash") return onBash(root, input);
    if (ev === "Stop") return onStop(root, input);
    // Older payloads without hook_event_name: treat a Read as the read hook.
    if (!ev && tool === "Read") return onRead(root, input);
  } catch { /* never break the agent */ }
}
