#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  repoRoot, toRepoPath, makeAnchor, normalize, newReason, saveReason, deleteReason, loadReasons, type Reason,
} from "./store.js";
import { resolveAnchor, type Resolution } from "./resolve.js";
import { runHook } from "./hook.js";
import { runEval, formatEval } from "./eval.js";

const USAGE = `reasons - pin the *why* to the code it explains

  reasons add <file>:<start>[-<end>] "<note>"   record a reason for a line range
  reasons add --json                             same, from stdin: {"file","start","end","note","source"}
  reasons show <file> [--json]                   print live reasons for a file
  reasons list [--json]                          print every reason in the repo
  reasons doctor [--fix]                         list moved/fuzzy/stale reasons; --fix re-pins moved and fuzzy ones
  reasons rm <id>                                delete a reason
  reasons hook                                   Claude Code hook entry point (reads JSON on stdin)
  reasons init                                   install the hooks + CLAUDE.md note into the current repo
  reasons eval [--repo p] [--commits N] [--samples M] [--span S] [--seed K] [-v]
                                                 measure anchor survival across a repo's git history

Options: --source <name>   who/what recorded it (default: cli)
`;

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

function parseTarget(t: string): { file: string; start: number; end: number } {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(t);
  if (!m) throw new Error(`expected <file>:<start>[-<end>], got "${t}"`);
  const start = Number(m[2]), end = m[3] ? Number(m[3]) : start;
  if (end < start) throw new Error("end before start");
  return { file: m[1], start, end };
}

export interface Resolved { reason: Reason; res: Resolution }

export function resolveFile(root: string, repoFile: string): Resolved[] {
  const abs = join(root, repoFile);
  const lines = existsSync(abs) ? readLines(abs) : [];
  return loadReasons(root, repoFile).map((reason) => ({ reason, res: resolveAnchor(lines, reason.anchor) }));
}

function fmt({ reason, res }: Resolved): string {
  const where = res.startLine ? (res.startLine === res.endLine ? `L${res.startLine}` : `L${res.startLine}-${res.endLine}`) : "?";
  const tag = res.status === "exact" ? "" : ` [${res.status}${res.status === "fuzzy" ? ` ${Math.round(res.score * 100)}%` : ""}]`;
  const meta = [reason.commit, reason.author, reason.source].filter(Boolean).join(" | ");
  return `${reason.file}:${where}${tag}  (${reason.id})\n    ${reason.note}\n    -- ${meta}, ${reason.createdAt.slice(0, 10)}`;
}

const claudeMdNote = () => `
## reasons

This repo records the *why* behind non-obvious code in \`.reasons/\`, anchored to content rather than line numbers.
Hooks surface live reasons when you Read a file and warn before you edit an annotated line. Treat those notes as
authoritative: do not simplify or remove an annotated line without addressing the note.

When you discover a non-obvious reason (a fix after a failing test, a revert, a "so that's why"), record it in one line:

    ${cliCmd()} add <file>:<start>-<end> "why" --source claude-code
`;

/** How to invoke this CLI from a shell in any repo: the bare name if linked, else node + absolute path. */
export function cliCmd(): string {
  if (process.env.REASONS_CLI) return process.env.REASONS_CLI;
  const self = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  return `node "${self}"`;
}

/** Install hooks + CLAUDE.md note into the repo at `root`. Idempotent. */
function init(root: string) {
  const cmd = `${cliCmd()} hook`;
  const dir = join(root, ".claude"); mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  const want: Record<string, string | undefined> = { PreToolUse: "Edit|MultiEdit|Write", PostToolUse: "Read|Edit|MultiEdit|Write|Bash", Stop: undefined };
  for (const [event, matcher] of Object.entries(want)) {
    const list: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> = (settings.hooks[event] ??= []);
    const ours = list.find((h) => h.hooks?.some((x) => /cli\.js" hook|reasons hook/.test(x.command)));
    const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] };
    if (ours) Object.assign(ours, entry);
    else list.push(entry);
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const md = join(root, "CLAUDE.md");
  const existing = existsSync(md) ? readFileSync(md, "utf8") : "";
  if (!/## reasons/.test(existing)) appendFileSync(md, (existing && !existing.endsWith("\n") ? "\n" : "") + claudeMdNote());
  mkdirSync(join(root, ".reasons"), { recursive: true });
  console.log(`installed hooks in ${toRepoPath(root, settingsPath)} and a note in CLAUDE.md`);
}

function main(argv: string[]) {
  const args = argv.slice();
  let source = "cli";
  const si = args.indexOf("--source");
  if (si >= 0) { source = args[si + 1] ?? "cli"; args.splice(si, 2); }
  const [cmd, ...rest] = args;
  const root = repoRoot();

  switch (cmd) {
    case "add": {
      let file: string, start: number, end: number, note: string;
      if (rest[0] === "--json") {
        const j = JSON.parse(readFileSync(0, "utf8"));
        file = String(j.file); start = Number(j.start); end = Number(j.end ?? j.start); note = String(j.note ?? "").trim();
        if (j.source) source = String(j.source);
        if (!file || !start || !note) throw new Error("--json needs file, start, note");
      } else {
        const [target, ...noteParts] = rest;
        note = noteParts.join(" ").trim();
        if (!target || !note) throw new Error(USAGE);
        ({ file, start, end } = parseTarget(target));
      }
      const lines = readLines(file);
      if (end > lines.length) throw new Error(`${file} has only ${lines.length} lines`);
      const anchor = makeAnchor(lines, start, end);
      if (!anchor.lines.some((l) => normalize(l))) throw new Error("refusing to anchor blank lines; pick a line with content");
      const r = newReason(root, toRepoPath(root, file), note, anchor, source);
      const path = saveReason(root, r);
      console.log(`recorded ${r.id} -> ${toRepoPath(root, path)}`);
      return;
    }
    case "show": {
      const [file] = rest;
      if (!file) throw new Error(USAGE);
      const items = resolveFile(root, toRepoPath(root, file));
      if (rest.includes("--json")) { console.log(JSON.stringify(items.map(({ reason, res }) => ({ ...reason, anchor: undefined, resolved: res })), null, 2)); return; }
      if (!items.length) { console.log("no reasons recorded for this file"); return; }
      for (const it of items) console.log(fmt(it) + "\n");
      return;
    }
    case "doctor": {
      // moved: fine, code shifted; re-pin with --fix.  fuzzy: the line changed; re-pin or re-read the note.
      // stale: gone; the note is hidden from agents until someone deletes or re-anchors it.
      const fix = rest.includes("--fix");
      const files = [...new Set(loadReasons(root).map((r) => r.file))];
      let moved = 0, fuzzy = 0, stale = 0, fixed = 0;
      for (const f of files) for (const it of resolveFile(root, f)) {
        const { status, startLine, endLine } = it.res;
        if (status === "exact") continue;
        if (status === "moved") moved++; else if (status === "fuzzy") fuzzy++; else stale++;
        console.log(fmt(it) + "\n");
        if (fix && status !== "stale" && startLine && endLine) {
          const abs = join(root, f);
          it.reason.anchor = makeAnchor(readLines(abs), startLine, endLine);
          saveReason(root, it.reason); fixed++;
        }
      }
      const parts = [moved && `${moved} moved`, fuzzy && `${fuzzy} fuzzy`, stale && `${stale} stale`].filter(Boolean);
      if (!parts.length) console.log("all reasons anchored exactly");
      else console.log(parts.join(", ") + (fix ? `; re-pinned ${fixed}` : moved + fuzzy ? "; run doctor --fix to re-pin the moved/fuzzy ones" : ""));
      process.exitCode = fuzzy + stale ? 1 : 0;
      return;
    }
    case "list": {
      const files = [...new Set(loadReasons(root).map((r) => r.file))].sort();
      const all = files.flatMap((f) => resolveFile(root, f));
      if (rest.includes("--json")) { console.log(JSON.stringify(all.map(({ reason, res }) => ({ ...reason, anchor: undefined, resolved: res })), null, 2)); return; }
      if (!all.length) { console.log("no reasons recorded"); return; }
      for (const it of all) console.log(fmt(it) + "\n");
      return;
    }
    case "rm": {
      const [id] = rest;
      if (!id) throw new Error(USAGE);
      console.log(deleteReason(root, id) ? `deleted ${id}` : `no reason ${id}`);
      return;
    }
    case "hook":
      return runHook(root);
    case "init":
      return init(root);
    case "eval": {
      const opt = (name: string, dflt: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
      const opts = {
        repo: opt("--repo", root), commits: +opt("--commits", "50"), samples: +opt("--samples", "5"),
        span: +opt("--span", "1"), seed: +opt("--seed", "1"), verbose: rest.includes("-v"),
      };
      console.log(formatEval(runEval(opts), opts));
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

try { main(process.argv.slice(2)); }
catch (e) { console.error((e as Error).message); process.exitCode = 1; }
