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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toRepoPath, loadReasons } from "./store.js";
import { resolveFile, cliCmd, type Resolved } from "./cli.js";

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
  stopAsked?: boolean;              // the one end-of-session question has been asked
}

// Both patterns only match at a shell command boundary (start, or after ; && || | newline),
// otherwise a command that merely *mentions* "git checkout --" inside a string sets them off.
const AT_CMD = String.raw`(?:^|[;&|]\s*|\n\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?`;
const TEST_CMD = new RegExp(AT_CMD + String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx\s+)?(?:jest|vitest|mocha|ava|tap|pytest|py\.test|cargo\s+test|go\s+test|dotnet\s+test|rspec|phpunit|mvn\s+test|gradle\s+test)\b|node\s+(?:--test|\S+\s+--test)\b|tsx\s+--test\b)`);
const REVERT_CMD = new RegExp(AT_CMD + String.raw`git\s+(?:revert|restore|checkout\s+(?:--|HEAD)|reset\s+--hard|stash\s+pop)(?=\s|$)`);
const FAIL_SIGNS = /\b(FAIL|failed|failing|not ok|AssertionError|Error:|✖|✗|Traceback|panicked|FAILED)\b|\bfail\s+[1-9]/;
const MAX_NUDGES = 3;

function sessionPath(id: string) {
  const dir = join(tmpdir(), "reasons-sessions");
  mkdirSync(dir, { recursive: true });
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
  const body = found.live.map((r) => {
    const conf = r.res.status === "fuzzy" ? " (approximate location)" : "";
    return `- ${where(r)}${conf}: ${r.reason.note}  [id ${r.reason.id}]`;
  }).join("\n");
  emit("PostToolUse",
    `Recorded reasons for ${found.repoFile} (from .reasons/, authoritative; do not "clean up" these lines without addressing the note):\n${body}`);
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

function onPostEdit(root: string, input: HookInput) {
  const id = input.session_id; const filePath = input.tool_input?.file_path as string | undefined;
  if (!id || !filePath) return;
  const s = loadSession(id);
  if (s.testFailedAt === undefined) return; // only care about edits made while red
  const repoFile = toRepoPath(root, filePath);
  if (repoFile.startsWith("..")) return;
  let range = "";
  try {
    const text = readFileSync(filePath, "utf8");
    const ti = input.tool_input ?? {};
    const news: string[] = [];
    if (typeof ti.new_string === "string") news.push(ti.new_string);
    if (Array.isArray(ti.edits)) for (const e of ti.edits) if (typeof e?.new_string === "string") news.push(e.new_string);
    const r = news.map((n) => rangeOf(text, n)).find(Boolean);
    if (r) range = `:${r[0]}-${r[1]}`;
  } catch { /* ignore */ }
  const entry = `${repoFile}${range}`;
  if (!s.editsSinceFail.includes(entry)) s.editsSinceFail.push(entry);
  saveSession(id, s);
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
        `on the line that would tempt them: \`${cliCmd()} add <file>:<line> "tried X; failed because Y" --source claude-code\`. Skip if it was a typo.`);
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
        `record the why now while you still know it: \`${cliCmd()} add <file>:<start>-<end> "one line" --source claude-code\`. ` +
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
      `\`${cliCmd()} add <file>:<start>-<end> "why" --source claude-code\`. If it was obvious, just say so and stop. This is asked once.`,
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
