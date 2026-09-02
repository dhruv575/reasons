/** End-to-end: drives the built CLI (dist/cli.js) inside a throwaway git repo. Run `npm run build` first. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
let repo: string;

function cli(args: string[], stdin?: string): { out: string; code: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, input: stdin, encoding: "utf8" });
  return { out: (r.stdout + r.stderr).trim(), code: r.status ?? -1 };
}
function git(...args: string[]) { execFileSync("git", args, { cwd: repo, stdio: "ignore" }); }
function hook(payload: object): string {
  const { out } = cli(["hook"], JSON.stringify(payload));
  return out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? JSON.parse(out).reason ?? "" : "";
}
const abs = (f: string) => join(repo, f);

before(() => {
  assert.ok(existsSync(CLI), "build first: npm run build");
  repo = mkdtempSync(join(tmpdir(), "reasons-e2e-"));
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/retry.ts"), "export function retry(fn) {\n  const MAX = 3; // not 5\n  for (let i = 0; i < MAX; i++) {\n    try { return fn(); } catch {}\n  }\n}\n");
  git("add", "-A"); git("commit", "-qm", "init");
});

test("add, duplicate, show, why", () => {
  assert.match(cli(["add", "src/retry.ts:2", "3 not 5: rate limit", "--link", "https://x/412"]).out, /^recorded/);
  assert.match(cli(["add", "src/retry.ts:2", "3 not 5:  rate limit"]).out, /already recorded/);
  assert.match(cli(["add", "src/retry.ts:1-6", "whole function"]).out, /^recorded/);
  assert.match(cli(["show", "src/retry.ts"]).out, /L2 .*\n.*3 not 5.*\n.*https:\/\/x\/412/);
  assert.match(cli(["why", "src/retry.ts:4"]).out, /whole function/);
  assert.doesNotMatch(cli(["why", "src/retry.ts:4"]).out, /3 not 5/);
  assert.match(cli(["add", "src/retry.ts:7", "x"]).out, /only 6 lines/);
  assert.match(cli(["add", "src/retry.ts:0", "x"]).out, /1-based/);
  const j = cli(["add", "--json"], '{"file":"src/retry.ts","start":3,"note":"via json","source":"t"}').out;
  assert.match(j, /^recorded/);
  const m = cli(["add", "src/retry.ts", "--match", "catch {}", "matched"]).out;
  assert.match(m, /recorded[^\n]*\n\s+L4: try/);
  assert.match(cli(["show", "src/retry.ts", "--json"]).out, /"via json"/);
  writeFileSync(join(repo, ".reasons/bad.json"), '{"file":"src/retry.ts","note":"no anchor"}');
  assert.match(cli(["show", "src/retry.ts"]).out, /via json/); // malformed record is skipped, not fatal
  rmSync(join(repo, ".reasons/bad.json"));
  for (const out of [j, m]) assert.match(cli(["rm", /recorded (\w+)/.exec(out)![1]]).out, /^deleted/);
});

test("Read hook pushes notes; windowed reads filter", () => {
  const ctx = hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs("src/retry.ts") } });
  assert.match(ctx, /line 2: 3 not 5/);
  assert.match(ctx, /lines 1-6: whole function/);
  const win = hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs("src/retry.ts"), offset: 4, limit: 2 } });
  assert.match(win, /whole function/);
  assert.match(win, /1 more not shown/);
  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs("nope.ts") } }), "");
});

test("pre-edit guard fires only on overlap", () => {
  const on = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: abs("src/retry.ts"), old_string: "const MAX = 3;", new_string: "const MAX = 5;" } });
  assert.match(on, /3 not 5/);
  const off = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: abs("src/retry.ts"), old_string: "export function retry", new_string: "export function retry2" } });
  assert.doesNotMatch(off, /3 not 5/); // the whole-function note still overlaps, the MAX one must not
  assert.match(off, /whole function/);
});

test("file move: reasons relocate, doctor --fix follows", () => {
  mkdirSync(join(repo, "src/net"));
  git("mv", "src/retry.ts", "src/net/retry.ts"); git("commit", "-qam", "move");
  assert.match(cli(["show", "src/net/retry.ts"]).out, /relocated from src\/retry\.ts/);
  assert.match(hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs("src/net/retry.ts") } }), /3 not 5/);
  const d = cli(["doctor"]);
  assert.match(d.out, /2 relocated/);
  assert.equal(d.code, 0, "relocated is not an error");
  assert.match(cli(["doctor", "--fix"]).out, /re-pinned 2/);
  assert.match(cli(["doctor"]).out, /anchored exactly/);
  assert.match(cli(["list"]).out, /^src\/net\/retry\.ts:L2/m);
});

test("red -> green capture and Stop, once", () => {
  const sid = "e2e-" + Date.now();
  const bash = (command: string, stdout: string, exit_code: number) =>
    hook({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout, exit_code } });
  assert.equal(bash("npm test", "1 failing", 1), "");
  hook({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs("src/net/retry.ts"), old_string: "x", new_string: "const MAX = 3;" } });
  assert.match(bash("npm test", "all passing", 0), /red -> green after you edited:\n\s+src\/net\/retry\.ts:2-2/);
  assert.equal(bash("npm test", "all passing", 0), "");
  assert.match(hook({ session_id: sid, hook_event_name: "Stop" }), /Before you finish/);
  assert.equal(hook({ session_id: sid, hook_event_name: "Stop" }), "");
});

test("stale: hidden from hooks, reported, pruned", () => {
  writeFileSync(join(repo, "src/net/retry.ts"), "export const nothing = 1;\n");
  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs("src/net/retry.ts") } }), "");
  const d = cli(["doctor"]);
  assert.match(d.out, /2 stale/);
  assert.equal(d.code, 1);
  assert.match(cli(["doctor", "--prune"]).out, /pruned 2/);
  assert.equal(readdirSync(join(repo, ".reasons")).length, 0);
});

test("symbol targets, diff, undo detection", () => {
  writeFileSync(join(repo, "src/net/retry.ts"), "import x from 'x';\n\nexport async function retry(fn) {\n  const MAX = 3;\n  return fn();\n}\n\nconst helper = () => 1;\n");
  git("add", "-A"); git("commit", "-qm", "restore");
  assert.match(cli(["add", "src/net/retry.ts#retry", "sym note"]).out, /^recorded/);
  assert.match(cli(["show", "src/net/retry.ts"]).out, /L3 .*\n\s+sym note/);
  assert.match(cli(["add", "src/net/retry.ts#helper", "arrow note"]).out, /^recorded/);
  assert.match(cli(["show", "src/net/retry.ts:8"]).out, /arrow note/);
  assert.match(cli(["add", "src/net/retry.ts#nope", "x"]).out, /no declaration/);
  // diff: touch the helper line only
  assert.match(cli(["diff"]).out, /no annotated lines touched/);
  writeFileSync(join(repo, "src/net/retry.ts"), "import x from 'x';\n\nexport async function retry(fn) {\n  const MAX = 3;\n  return fn();\n}\n\nconst helper = () => 2;\n");
  const d = cli(["diff"]);
  assert.match(d.out, /arrow note/);
  assert.doesNotMatch(d.out, /sym note/);
  assert.equal(cli(["diff", "--check"]).code, 1);
  git("checkout", "--", "src/net/retry.ts");
  // undo: edit A->B, then B->A in the same session
  const sid = "undo-" + Date.now();
  const edit = (o: string, n: string) => hook({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs("src/net/retry.ts"), old_string: o, new_string: n } });
  assert.equal(edit("const MAX = 3;", "const MAX = 5;"), "");
  assert.match(edit("const MAX = 5;", "const MAX = 3;"), /undoing your own change/);
  assert.equal(edit("return fn();", "return await fn();"), "");
});

test("init is idempotent and mcp answers", () => {
  cli(["init"]); cli(["init"]);
  const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(readFileSync(join(repo, "CLAUDE.md"), "utf8"), /## reasons/);
  const { out } = cli(["mcp"], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  assert.match(out, /reasons_for_file/);
  rmSync(repo, { recursive: true, force: true });
});
