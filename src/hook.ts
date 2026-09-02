/**
 * Claude Code hook dispatcher. One entry point, `reasons hook`, reads the hook
 * payload on stdin and dispatches on event + tool:
 *
 *   PostToolUse Read            -> attach live reasons for the file (push, never pull)
 *   PreToolUse  Edit/Write      -> warn when the edit touches an annotated region
 *   PostToolUse Edit/Write      -> remember what was edited; detect an edit that undoes an earlier one
 *   PostToolUse Bash            -> detect a test run going red -> green, or a revert,
 *                                  and ask for the reason at that moment
 *   Stop                        -> one last question if a red -> green fix went unrecorded
 *
 * Everything is best-effort and silent on failure: a broken hook must never
 * get in the agent's way.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toRepoPath, loadReasons } from "./store.js";
import { resolveFile, type Resolved } from "./locate.js";
import { cliCmd } from "./env.js";

interface HookInput {
  session_id?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  stop_hook_active?: unknown;
}

type Kind = "green" | "revert" | "undo";

interface Session {
  testFailedAt?: number;            // ms epoch of the last failing test run
  editsSinceFail: string[];         // "file:start-end" edited after that failure
  idsAtFail?: string[];             // reason ids that existed when tests went red
  nudges: Partial<Record<Kind, number>>; // prompts issued, per kind
  unrecordedFix?: string[];         // edits from the last red->green that went unrecorded
  stopAsked?: boolean;              // the one end-of-session question has been asked
  recentEdits?: Array<{ file: string; oldH: string; newH: string }>; // for undo detection
}

// Only match at a shell command boundary (start, or after ; && || | newline), allowing env-var
// prefixes and wrappers, so a command that merely *mentions* "git checkout --" inside a string
// or a comment does not fire.
const AT_CMD = String.raw`(?:^|[;&|]\s*|\n\s*)(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:\w+=\S*\s+)*(?:sudo\s+|env\s+|time\s+|timeout\s+\S+\s+)?`;
const TEST_CMD = new RegExp(AT_CMD + String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b|(?:npx\s+|pnpm\s+|yarn\s+|bunx\s+)?(?:jest|vitest|mocha|ava|tap|pytest|py\.test|rspec|phpunit)\b|(?:\.\/)?node_modules\/\.bin\/(?:jest|vitest|mocha|ava)\b|python3?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn\s+test\b|gradle\s+test\b|make\s+test\b|(?:npx\s+)?tsx\s+--test\b|node\s+(?:--[\w-]+(?:\s+\S+)?\s+)*(?:--test\b|\S+\s+--test\b))`);
const REVERT_CMD = new RegExp(AT_CMD + String.raw`git\s+(?:-C\s+\S+\s+)?(?:revert\b|restore\b(?!\s+--staged)|checkout\s+(?:--|\.(?=\s|$)|HEAD\S*|[0-9a-f]{7,40}\s+--)|reset\s+--hard\b|stash\s+pop\b)`);
// Test runners summarise failures with a count or a fixed token. Bare "failed" is avoided: it appears in passing test names.
const FAIL_SIGNS = /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|\bfail(?:ed|ures?)?:?\s+[1-9]|\bFAIL\b|\bFAILED\b|\bnot ok\b|\bTraceback\b|\bpanicked\b|\bAssertionError\b|✖|✗|\bERR_ASSERTION\b|npm ERR! Test failed/;
const MAX_NUDGES: Record<Kind, number> = { green: 3, revert: 2, undo: 2 };
const MAX_SHOWN = 12;            // per Read; more than this is noise, the agent can ask for the rest
const RED_TTL_MS = 60 * 60_000;  // a red run older than this is a different piece of work
const TRIVIAL_UNDO_CHARS = 6;    // `}` or `);` undone proves nothing; `const MAX = 3;` does

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const lf = (s: string) => s.replace(/\r\n/g, "\n");

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
  let s: Session = { editsSinceFail: [], nudges: {} };
  try { s = { ...s, ...JSON.parse(readFileSync(sessionPath(id), "utf8")) }; } catch { /* fresh */ }
  s.nudges ??= {}; s.editsSinceFail ??= [];
  if (s.testFailedAt !== undefined && Date.now() - s.testFailedAt > RED_TTL_MS) { s.testFailedAt = undefined; s.editsSinceFail = []; }
  return s;
}
function saveSession(id: string, s: Session) {
  // Write-then-rename so two hooks running at once cannot leave a torn file behind.
  try { const p = sessionPath(id); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, p); } catch { /* ignore */ }
}
function nudge(s: Session, kind: Kind): boolean {
  const n = s.nudges[kind] ?? 0;
  if (n >= MAX_NUDGES[kind]) return false;
  s.nudges[kind] = n + 1;
  return true;
}

function emit(event: string, context: string) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

function where(r: Resolved): string {
  const { res } = r;
  return res.startLine === res.endLine ? `line ${res.startLine}` : `lines ${res.startLine}-${res.endLine}`;
}

function liveReasons(root: string, filePath: string): { repoFile: string; live: Resolved[] } | undefined {
  let repoFile: string;
  try { repoFile = toRepoPath(root, filePath); } catch { return; } // outside this repo
  const live = resolveFile(root, repoFile).filter((r) => r.res.status !== "stale");
  return { repoFile, live };
}

function onRead(root: string, ti: Record<string, unknown>) {
  const filePath = str(ti.file_path);
  if (!filePath) return;
  const found = liveReasons(root, filePath);
  if (!found?.live.length) return;
  // A windowed Read only gets the reasons inside the window, plus a count of the rest.
  const offset = Number(ti.offset ?? 0) || 0, limit = Number(ti.limit ?? 0) || 0;
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

/** 1-based line range that `needle` occupies in `haystack` (both LF-normalised), or undefined. */
function rangeOf(haystack: string, needle: string): [number, number] | undefined {
  needle = lf(needle);
  const idx = needle ? haystack.indexOf(needle) : -1;
  if (idx < 0) return;
  const start = haystack.slice(0, idx).split("\n").length;
  return [start, start + needle.split("\n").length - 1];
}

/** old/new string pairs from an Edit, MultiEdit, or Write payload. */
function editPairs(tool: string, ti: Record<string, unknown>): Array<{ o: string; n: string }> {
  const pairs: Array<{ o: string; n: string }> = [];
  const o = str(ti.old_string), n = str(ti.new_string);
  if (o !== undefined && n !== undefined) pairs.push({ o, n });
  if (Array.isArray(ti.edits)) for (const e of ti.edits) {
    const eo = str(obj(e).old_string), en = str(obj(e).new_string);
    if (eo !== undefined && en !== undefined) pairs.push({ o: eo, n: en });
  }
  if (tool === "Write" && str(ti.content) !== undefined) pairs.push({ o: "", n: str(ti.content)! });
  return pairs;
}

function onPreEdit(root: string, tool: string, ti: Record<string, unknown>) {
  const filePath = str(ti.file_path);
  if (!filePath || !existsSync(filePath)) return;
  const found = liveReasons(root, filePath);
  if (!found?.live.length) return;
  const text = lf(readFileSync(filePath, "utf8"));
  const ranges: Array<[number, number]> = tool === "Write"
    ? [[1, text.split("\n").length]]
    : editPairs(tool, ti).map((p) => rangeOf(text, p.o)).filter((r): r is [number, number] => !!r);
  const touched = found.live.filter((r) => ranges.some(([s, e]) => r.res.startLine! <= e && r.res.endLine! >= s));
  if (!touched.length) return;
  const body = touched.map((r) => `- ${where(r)}: ${r.reason.note}  [id ${r.reason.id}]`).join("\n");
  emit("PreToolUse",
    `Heads up: this edit touches code with a recorded reason in ${found.repoFile}:\n${body}\n` +
    `If your change honours the reason, carry on. If the reason no longer applies, say so and run \`${cliCmd()} rm <id>\`. ` +
    `If the reason changes, re-record it with \`${cliCmd()} add\`.`);
}

const h = (s: string) => createHash("sha1").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

function onPostEdit(root: string, tool: string, ti: Record<string, unknown>, id: string | undefined) {
  const filePath = str(ti.file_path);
  if (!id || !filePath) return;
  let repoFile: string;
  try { repoFile = toRepoPath(root, filePath); } catch { return; }
  const s = loadSession(id);
  const pairs = editPairs(tool, ti).filter((p) => tool !== "Write");

  // Undo detection: an edit that is the exact reverse of an earlier edit in the same file (old<->new
  // swapped) is the agent backing out its own change. Agents almost never `git revert`; this is their revert.
  s.recentEdits ??= [];
  let undone: string | undefined;
  for (const { o, n } of pairs) {
    const oh = h(o), nh = h(n);
    const trivial = n.replace(/\s+/g, "").length < TRIVIAL_UNDO_CHARS;
    if (!trivial && oh !== nh && s.recentEdits.some((e) => e.file === repoFile && e.oldH === nh && e.newH === oh)) undone = n;
    s.recentEdits.push({ file: repoFile, oldH: oh, newH: nh });
  }
  s.recentEdits = s.recentEdits.slice(-40);

  if (s.testFailedAt !== undefined) { // edits made while red are what the red->green prompt reports
    let range = "";
    try {
      const text = lf(readFileSync(filePath, "utf8"));
      const r = pairs.map((p) => rangeOf(text, p.n)).find(Boolean);
      if (r) range = `:${r[0]}-${r[1]}`;
    } catch { /* ignore */ }
    const entry = `${repoFile}${range}`;
    if (!s.editsSinceFail.includes(entry)) s.editsSinceFail.push(entry);
  }

  if (undone && nudge(s, "undo")) {
    saveSession(id, s);
    const snippet = undone.trim().split("\n")[0].slice(0, 60);
    emit("PostToolUse",
      `You just restored earlier code in ${repoFile} (\`${snippet}\`), undoing your own change. ` +
      `If the attempt failed for a reason the code doesn't show, pin it to the line so nobody retries it: ` +
      `\`${cliCmd()} add ${repoFile} --match "<text on the line>" "tried X; failed because Y" --source claude-code\`. Skip if it was a typo.`);
    return;
  }
  saveSession(id, s);
}

function responseText(resp: unknown): string {
  if (typeof resp === "string") return resp;
  const r = obj(resp);
  return [r.stdout, r.stderr, r.output, r.content].filter((x): x is string => typeof x === "string").join("\n");
}

/** Quoted strings, heredoc bodies and comments are data, not commands; an apostrophe inside a word is not a quote. */
export function stripQuotes(raw: string): string {
  return raw
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, "<<HEREDOC")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/(^|[^\w])'[^']*'/g, '$1""')
    .replace(/(^|\s)#[^\n]*/g, "$1");
}

function onBash(root: string, ti: Record<string, unknown>, resp: unknown, id: string | undefined) {
  const raw = str(ti.command);
  if (!id || !raw) return;
  const cmd = stripQuotes(raw);
  const s = loadSession(id);

  if (REVERT_CMD.test(cmd)) {
    if (nudge(s, "revert")) {
      saveSession(id, s);
      emit("PostToolUse",
        `You just reverted or restored code (\`${raw.slice(0, 80)}\`). Reverts are where reasons get lost: ` +
        `if the approach you backed out is one a future reader (or you, next session) might retry, record why it didn't work ` +
        `on the line that would tempt them: \`${cliCmd()} add <file> --match "<text on the line>" "tried X; failed because Y" --source claude-code\`. Skip if it was a typo.`);
    }
    return;
  }

  if (!TEST_CMD.test(cmd)) return;
  // Claude Code's Bash response carries no exit code, so the summary lines at the end of the output decide.
  const r = obj(resp);
  const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : undefined;
  const tail = responseText(resp).split("\n").slice(-40).join("\n");
  const failed = exit !== undefined ? exit !== 0 : FAIL_SIGNS.test(tail);

  if (failed) {
    if (s.testFailedAt === undefined) { s.testFailedAt = Date.now(); s.editsSinceFail = []; s.idsAtFail = loadReasons(root).map((x) => x.id); }
    saveSession(id, s);
    return;
  }
  // Green. Was it red before, with edits in between?
  if (s.testFailedAt !== undefined && s.editsSinceFail.length) {
    const before = new Set(s.idsAtFail ?? []);
    const recorded = loadReasons(root).some((x) => !before.has(x.id));
    const edits = s.editsSinceFail.slice(0, 6).map((e) => `  ${e}`).join("\n");
    if (!recorded) s.unrecordedFix = s.editsSinceFail;
    s.testFailedAt = undefined; s.editsSinceFail = [];
    if (!recorded && nudge(s, "green")) {
      saveSession(id, s);
      emit("PostToolUse",
        `Tests went red -> green after you edited:\n${edits}\n` +
        `If the fix was non-obvious (a value that has to be exactly this, an ordering constraint, a workaround for an upstream quirk), ` +
        `record the why now while you still know it: \`${cliCmd()} add <file> --match "<text on the line>" "one line" --source claude-code\`. ` +
        `If it was a plain bug with an obvious fix, skip this.`);
      return;
    }
  } else if (s.testFailedAt !== undefined) {
    s.testFailedAt = undefined; // green with no edits: the red was noise
  }
  saveSession(id, s);
}

/**
 * Session end. One question, once, only if a red->green fix went unrecorded
 * and nothing was added since. Anything else would train the agent to skip it.
 */
function onStop(root: string, id: string | undefined, active: boolean) {
  if (!id || active) return; // never loop
  const s = loadSession(id);
  if (s.stopAsked || !s.unrecordedFix?.length) return;
  const before = new Set(s.idsAtFail ?? []);
  const recorded = loadReasons(root).some((x) => !before.has(x.id));
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
export const patterns = { TEST_CMD, REVERT_CMD, FAIL_SIGNS, stripQuotes };

export function runHook(root: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(0, "utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const input = parsed as HookInput;
    const ev = str(input.hook_event_name), tool = str(input.tool_name) ?? "";
    const ti = obj(input.tool_input), id = str(input.session_id);
    const isEdit = /^(Edit|MultiEdit|Write)$/.test(tool);
    if (ev === "PostToolUse" && tool === "Read") return onRead(root, ti);
    if (ev === "PreToolUse" && isEdit) return onPreEdit(root, tool, ti);
    if (ev === "PostToolUse" && isEdit) return onPostEdit(root, tool, ti, id);
    if (ev === "PostToolUse" && tool === "Bash") return onBash(root, ti, input.tool_response, id);
    if (ev === "Stop") return onStop(root, id, input.stop_hook_active === true);
    if (!ev && tool === "Read") return onRead(root, ti); // older payloads without hook_event_name
  } catch { /* never break the agent */ }
}
