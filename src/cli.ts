#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  repoRoot, toRepoPath, makeAnchor, normalize, newReason, saveReason, deleteReason, loadReasons,
} from "./store.js";
import { resolveFile, relocate, readLines, type Resolved } from "./locate.js";
import { cliCmd } from "./env.js";
import { runHook } from "./hook.js";
import { runEval, formatEval, parseHunks } from "./eval.js";
import { execFileSync } from "node:child_process";

function gitOut(root: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).toString(); }
  catch { return ""; }
}

const USAGE = `reasons - pin the *why* to the code it explains

  reasons add <file>:<start>[-<end>] "<note>"   record a reason for a line range
  reasons add <file>#<symbol> "<note>"          same, anchored to the line that declares <symbol>
  reasons add <file> --match "<text>" "<note>"  same, anchored to the first line containing <text>
  reasons add --json                             same, from stdin: {"file","start","end","note","source","link"}
  reasons diff [<base>] [--check]                reasons touched by the diff vs HEAD (or <base>); --check exits 1 if any
  reasons show <file>[:<line>] [--json]          live reasons for a file, or just those covering a line
  reasons why <file>:<line>                      alias for show
  reasons list [--json]                          every reason in the repo
  reasons doctor [--fix] [--prune]               report moved/fuzzy/stale/orphaned reasons;
                                                 --fix re-pins moved, fuzzy and relocated ones; --prune deletes stale
  reasons rm <id>                                delete a reason
  reasons init                                   install the hooks + CLAUDE.md note into the current repo
  reasons hook                                   Claude Code hook entry point (reads JSON on stdin)
  reasons mcp                                    serve reasons over MCP (stdio) for other agents
  reasons eval [--repo p] [--commits N] [--samples M] [--span S] [--seed K] [-v]
                                                 measure anchor survival across a repo's git history

Options: --source <name>   who/what recorded it (default: cli)
         --link <url>      issue, PR, or doc that explains more
`;

/** `file:12`, `file:12-20`, or `file#name` (the line that declares `name`). */
function parseTarget(t: string): { file: string; start: number; end: number } {
  const sym = /^(.+?)#([\w$.]+)$/.exec(t);
  if (sym) {
    const line = findSymbolLine(readLines(sym[1]), sym[2]);
    if (!line) throw new Error(`no declaration of ${sym[2]} found in ${sym[1]}`);
    return { file: sym[1], start: line, end: line };
  }
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(t);
  if (!m) throw new Error(`expected <file>:<start>[-<end>] or <file>#<symbol>, got "${t}"`);
  const start = Number(m[2]), end = m[3] ? Number(m[3]) : start;
  if (end < start) throw new Error("end before start");
  return { file: m[1], start, end };
}

/** Line (1-based) that declares `name`: a declaration keyword before it, or `name(`/`name =`/`name:` as a fallback. */
export function findSymbolLine(lines: string[], name: string): number | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(String.raw`^\s*(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|impl|const|let|var|val|module|namespace)\s+${esc}\b`);
  const loose = new RegExp(String.raw`^\s*(?:[\w<>\[\],\s]+\s)?${esc}\s*(?:\(|=|:|<)`);
  const i = lines.findIndex((l) => decl.test(l));
  if (i >= 0) return i + 1;
  const j = lines.findIndex((l) => loose.test(l));
  return j >= 0 ? j + 1 : undefined;
}

function fmt({ reason, res, file, movedFrom }: Resolved): string {
  const where = res.startLine ? (res.startLine === res.endLine ? `L${res.startLine}` : `L${res.startLine}-${res.endLine}`) : "?";
  const status = movedFrom ? `relocated from ${movedFrom}` : res.status === "exact" ? "" : `${res.status}${res.status === "fuzzy" ? ` ${Math.round(res.score * 100)}%` : ""}`;
  const tag = status ? ` [${status}]` : "";
  const meta = [reason.commit, reason.author, reason.source].filter(Boolean).join(" | ");
  const link = reason.link ? `\n    ${reason.link}` : "";
  return `${file}:${where}${tag}  (${reason.id})\n    ${reason.note}${link}\n    -- ${meta}, ${reason.createdAt?.slice(0, 10) ?? "?"}`;
}

function toJson(items: Resolved[]) {
  return JSON.stringify(items.map(({ reason, res, file, movedFrom }) => ({ ...reason, anchor: undefined, file, recordedFile: reason.file, resolved: res, movedFrom })), null, 2);
}

const claudeMdNote = () => `
## reasons

This repo records the *why* behind non-obvious code in \`.reasons/\`, anchored to content rather than line numbers.
Hooks surface live reasons when you Read a file and warn before you edit an annotated line. Treat those notes as
authoritative: do not simplify or remove an annotated line without addressing the note.

When you discover a non-obvious reason (a fix after a failing test, a revert, a "so that's why"), record it in one line.
Anchor by text or symbol rather than counting lines; the command echoes the anchored line so you can check it:

    ${cliCmd()} add <file> --match "<unique text on the line>" "why" --source claude-code
    ${cliCmd()} add <file>#<functionName> "why" --source claude-code

A good reason names the constraint and what breaks without it, not what the code does:
  good: "3 not 5: 5 retries tripped the upstream rate limit in prod (#412)"
  good: "must run before loadConfig(); it reads the env var this sets"
  bad:  "retry loop"   bad: "fixed the bug"   bad: anything the code already says
Anchor the line someone would be tempted to change, not the whole function.
`;

/** Install hooks + CLAUDE.md note into the repo at `root`. Idempotent. */
function init(root: string) {
  const cmd = `${cliCmd()} hook`;
  const dir = join(root, ".claude"); mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  // Only ever touch our own hook command. A user's other hooks in the same group, and a matcher they
  // trimmed on purpose (e.g. dropping Bash), are left exactly as they are.
  const isOurs = (c: string): boolean => {
    c = c.trim();
    if (c === cmd || /^(?:npx\s+)?(?:git-)?reasons\s+hook$/.test(c) || /[\\/](?:git-)?reasons[\\/]dist[\\/]cli\.js"?\s+hook$/.test(c)) return true;
    // `node "<anywhere>/dist/cli.js" hook`: ours if that file is this tool (the checkout may be named anything).
    const m = /^node\s+"?((?:.+?[\\/])?dist[\\/]cli\.js)"?\s+hook$/.exec(c);
    if (!m) return false;
    const p = isAbsolute(m[1]) ? m[1] : join(root, m[1]);
    try { return readFileSync(p, "utf8").includes("pin the *why*"); } catch { return false; }
  };
  const want: Record<string, string | undefined> = { PreToolUse: "Edit|MultiEdit|Write", PostToolUse: "Read|Edit|MultiEdit|Write|Bash", Stop: undefined };
  for (const [event, matcher] of Object.entries(want)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const list: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }> = settings.hooks[event];
    let found = false;
    for (const group of list) for (const hk of group.hooks ?? []) {
      if (typeof hk.command === "string" && isOurs(hk.command)) { hk.type = "command"; hk.command = cmd; found = true; }
    }
    if (!found) list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const md = join(root, "CLAUDE.md");
  const existing = existsSync(md) ? readFileSync(md, "utf8") : "";
  if (!/## reasons/.test(existing)) appendFileSync(md, (existing && !existing.endsWith("\n") ? "\n" : "") + claudeMdNote());
  mkdirSync(join(root, ".reasons"), { recursive: true });
  console.log(`installed hooks (${cmd}) in ${toRepoPath(root, settingsPath)} and a note in CLAUDE.md`);
}

function takeOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  const [, v] = args.splice(i, 2);
  return v;
}

async function main(argv: string[]) {
  const args = argv.slice();
  let source = takeOpt(args, "--source") ?? "cli";
  let link = takeOpt(args, "--link");
  const match = takeOpt(args, "--match");
  const json = args.includes("--json");
  const [cmd, ...rest] = args.filter((a) => a !== "--json");
  const root = repoRoot();

  switch (cmd) {
    case "add": {
      let file: string, start: number, end: number, note: string;
      if (json) {
        const j = JSON.parse(readFileSync(0, "utf8"));
        file = String(j.file); start = Number(j.start); end = Number(j.end ?? j.start); note = String(j.note ?? "").trim();
        if (j.source) source = String(j.source);
        if (j.link) link = String(j.link);
        if (!file || !start || !note) throw new Error("--json needs file, start, note");
      } else if (match) {
        // `add <file> --match "<text>" "<note>"`: anchor the first line containing <text>. No line counting.
        const [target, ...noteParts] = rest;
        note = noteParts.join(" ").trim();
        if (!target || !note) throw new Error(USAGE);
        file = target.replace(/:\d+(-\d+)?$/, "");
        const idx = readLines(file).findIndex((l) => l.includes(match));
        if (idx < 0) throw new Error(`no line in ${file} contains "${match}"`);
        start = end = idx + 1;
      } else {
        const [target, ...noteParts] = rest;
        note = noteParts.join(" ").trim();
        if (!target || !note) throw new Error(USAGE);
        ({ file, start, end } = parseTarget(target));
      }
      const lines = readLines(file);
      const count = lines.length - (lines.at(-1) === "" ? 1 : 0); // trailing newline is not a line
      if (start < 1 || end < start) throw new Error(`bad range ${start}-${end}; lines are 1-based`);
      if (end > count) throw new Error(`${file} has only ${count} lines`);
      const anchor = makeAnchor(lines, start, end);
      if (!anchor.lines.some((l) => normalize(l))) throw new Error("refusing to anchor blank lines; pick a line with content");
      const repoFile = toRepoPath(root, file);
      const dup = resolveFile(root, repoFile).find((x) =>
        x.res.status !== "stale" && x.res.startLine! <= end && x.res.endLine! >= start && normalize(x.reason.note) === normalize(note));
      if (dup) { console.log(`already recorded as ${dup.reason.id}; nothing added`); return; }
      const r = newReason(root, repoFile, note, anchor, source);
      if (link) r.link = link;
      const path = saveReason(root, r);
      // Echo the anchored text: line numbers are easy to get wrong by one, and a note on the wrong line is worse than none.
      const preview = anchor.lines.slice(0, 3).map((l, i) => `    L${start + i}: ${l.trim().slice(0, 100)}`).join("\n") + (anchor.lines.length > 3 ? `\n    ... (${anchor.lines.length} lines)` : "");
      console.log(`recorded ${r.id} -> ${toRepoPath(root, path)}\n${preview}`);
      return;
    }
    case "show":
    case "why": {
      const [target] = rest;
      if (!target) throw new Error(USAGE);
      const m = /^(.+?):(\d+)$/.exec(target);
      const file = m ? m[1] : target, line = m ? Number(m[2]) : undefined;
      let items = resolveFile(root, toRepoPath(root, file));
      if (line) items = items.filter((x) => x.res.status !== "stale" && x.res.startLine! <= line && x.res.endLine! >= line);
      if (json) { console.log(toJson(items)); return; }
      if (!items.length) { console.log(line ? `no reasons cover ${file}:${line}` : "no reasons recorded for this file"); return; }
      for (const it of items) console.log(fmt(it) + "\n");
      return;
    }
    case "list": {
      const files = [...new Set(loadReasons(root).map((r) => r.file))].sort();
      const all = files.flatMap((f) => resolveFile(root, f));
      if (json) { console.log(toJson(all)); return; }
      if (!all.length) { console.log("no reasons recorded"); return; }
      for (const it of all) console.log(fmt(it) + "\n");
      return;
    }
    case "doctor": {
      // moved: fine, code shifted; re-pin with --fix.  fuzzy: the line changed; re-pin or re-read the note.
      // orphan: the file is gone; --fix follows it if it can be found.  stale: gone; hidden from agents; --prune deletes.
      const fix = rest.includes("--fix"), prune = rest.includes("--prune");
      const files = [...new Set(loadReasons(root).map((r) => r.file))];
      const n = { moved: 0, fuzzy: 0, stale: 0, orphan: 0, fixed: 0, pruned: 0 };
      for (const f of files) {
        const fileGone = !existsSync(join(root, f));
        for (const it of resolveFile(root, f)) {
          const { reason, res } = it;
          if (res.status === "exact" || it.movedFrom) continue; // orphans are handled under their own (gone) file
          let target: { file: string; res: typeof res } | undefined;
          if (fileGone) {
            target = relocate(root, reason);
            if (target) { n.orphan++; console.log(fmt({ reason, res: target.res, file: target.file, movedFrom: f }) + "\n"); }
            else { n.stale++; console.log(fmt(it) + "\n"); }
          } else {
            if (res.status === "moved") n.moved++; else if (res.status === "fuzzy") n.fuzzy++; else n.stale++;
            console.log(fmt(it) + "\n");
            if (res.status !== "stale") target = { file: f, res };
          }
          if (fix && target?.res.startLine && target.res.endLine) {
            reason.file = target.file;
            reason.anchor = makeAnchor(readLines(join(root, target.file)), target.res.startLine, target.res.endLine);
            saveReason(root, reason); n.fixed++;
          } else if (prune && !target) {
            deleteReason(root, reason.id); n.pruned++;
          }
        }
      }
      const parts = [n.moved && `${n.moved} moved`, n.fuzzy && `${n.fuzzy} fuzzy`, n.orphan && `${n.orphan} relocated`, n.stale && `${n.stale} stale`].filter(Boolean);
      if (!parts.length) console.log("all reasons anchored exactly");
      else {
        const did = [fix && `re-pinned ${n.fixed}`, prune && `pruned ${n.pruned}`].filter(Boolean).join(", ");
        const hint = !fix && n.moved + n.fuzzy + n.orphan ? "run doctor --fix to re-pin" : !prune && n.stale ? "doctor --prune deletes stale ones" : "";
        console.log(parts.join(", ") + (did ? `; ${did}` : hint ? `; ${hint}` : ""));
      }
      process.exitCode = n.fuzzy + n.stale - (prune ? n.pruned : 0) ? 1 : 0;
      return;
    }
    case "diff": {
      // Reasons whose anchored lines are touched by a diff: working tree vs HEAD by default, or vs a base ref.
      // For review and CI: "this change touches 3 annotated lines" is the whole point of recording them.
      const base = rest.find((a) => !a.startsWith("-")) ?? "HEAD";
      const changed = gitOut(root, ["diff", "--name-only", base, "--"]).split("\n").filter(Boolean);
      const hits: Array<Resolved & { hunk: string }> = [];
      for (const f of changed) {
        const hunks = parseHunks(gitOut(root, ["diff", "-U0", base, "--", f]));
        for (const it of resolveFile(root, f)) {
          if (it.res.status === "stale") continue;
          const hunk = hunks.find((hk) => {
            const lo = hk.newStart, hi = hk.newLen ? hk.newStart + hk.newLen - 1 : hk.newStart;
            return it.res.startLine! <= hi && it.res.endLine! >= lo;
          });
          if (hunk) hits.push({ ...it, hunk: `-${hunk.oldStart},${hunk.oldLen} +${hunk.newStart},${hunk.newLen}` });
        }
      }
      if (json) { console.log(toJson(hits)); return; }
      if (!hits.length) { console.log(`no annotated lines touched (vs ${base})`); return; }
      for (const it of hits) console.log(fmt(it) + "\n");
      console.log(`${hits.length} annotated region(s) touched vs ${base}. Each note is either honoured, re-recorded, or removed with rm.`);
      process.exitCode = rest.includes("--check") ? 1 : 0;
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
    case "mcp": {
      const { serveMcp } = await import("./mcp.js");
      return serveMcp(root);
    }
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

main(process.argv.slice(2)).catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
