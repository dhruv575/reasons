#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  repoRoot, toRepoPath, makeAnchor, normalize, newReason, saveReason, deleteReason, loadReasons, type Reason,
} from "./store.js";
import { resolveAnchor, type Resolution } from "./resolve.js";
import { runHook } from "./hook.js";

const USAGE = `reasons - pin the *why* to the code it explains

  reasons add <file>:<start>[-<end>] "<note>"   record a reason for a line range
  reasons show <file>                            print live reasons for a file
  reasons doctor                                 list moved/fuzzy/stale reasons repo-wide
  reasons rm <id>                                delete a reason
  reasons hook                                   Claude Code PostToolUse hook (reads JSON on stdin)

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

function main(argv: string[]) {
  const args = argv.slice();
  let source = "cli";
  const si = args.indexOf("--source");
  if (si >= 0) { source = args[si + 1] ?? "cli"; args.splice(si, 2); }
  const [cmd, ...rest] = args;
  const root = repoRoot();

  switch (cmd) {
    case "add": {
      const [target, ...noteParts] = rest;
      const note = noteParts.join(" ").trim();
      if (!target || !note) throw new Error(USAGE);
      const { file, start, end } = parseTarget(target);
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
      if (!items.length) { console.log("no reasons recorded for this file"); return; }
      for (const it of items) console.log(fmt(it) + "\n");
      return;
    }
    case "doctor": {
      const files = [...new Set(loadReasons(root).map((r) => r.file))];
      let bad = 0;
      for (const f of files) for (const it of resolveFile(root, f)) {
        if (it.res.status !== "exact") { bad++; console.log(fmt(it) + "\n"); }
      }
      console.log(bad ? `${bad} reason(s) need attention` : "all reasons anchored exactly");
      process.exitCode = bad ? 1 : 0;
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
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

try { main(process.argv.slice(2)); }
catch (e) { console.error((e as Error).message); process.exitCode = 1; }
