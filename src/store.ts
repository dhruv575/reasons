import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

export interface Reason {
  id: string;
  file: string;            // repo-relative, forward slashes
  note: string;
  anchor: Anchor;
  createdAt: string;       // ISO
  commit?: string;         // HEAD at creation, if in git
  author?: string;         // git user.name, or an agent identifier
  source?: string;         // e.g. "cli", "claude-code", a session URL
  link?: string;           // issue, PR, or doc with the longer story
}

export interface Anchor {
  lines: string[];         // the anchored region, exact text
  before: string[];        // up to 3 lines of leading context
  after: string[];         // up to 3 lines of trailing context
  startLine: number;       // 1-based line where it was when created (hint only)
  hash: string;            // sha1 of normalized `lines`
}

export const REASONS_DIR = ".reasons";
const CONTEXT = 3;

export function repoRoot(from = process.cwd()): string {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, REASONS_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** Repo-relative forward-slash path; throws for anything outside the repo (other dir, other drive). */
export function toRepoPath(root: string, file: string): string {
  const rel = relative(root, resolve(file));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${file} is outside ${root}`);
  return rel.split(sep).join("/");
}

export function normalize(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

export function hashLines(lines: string[]): string {
  return createHash("sha1").update(lines.map(normalize).join("\n")).digest("hex").slice(0, 12);
}

export function makeAnchor(fileLines: string[], start: number, end: number): Anchor {
  const s = start - 1, e = end; // to 0-based, exclusive end
  const lines = fileLines.slice(s, e);
  return {
    lines,
    before: fileLines.slice(Math.max(0, s - CONTEXT), s),
    after: fileLines.slice(e, e + CONTEXT),
    startLine: start,
    hash: hashLines(lines),
  };
}

function git(root: string, args: string): string | undefined {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch { return undefined; }
}

export function newReason(root: string, file: string, note: string, anchor: Anchor, source = "cli"): Reason {
  return {
    id: randomBytes(4).toString("hex"),
    file,
    note,
    anchor,
    createdAt: new Date().toISOString(),
    commit: git(root, "rev-parse --short HEAD"),
    author: process.env.REASONS_AUTHOR ?? git(root, "config user.name"),
    source,
  };
}

function dirFor(root: string) { return join(root, REASONS_DIR); }

export function saveReason(root: string, r: Reason): string {
  const dir = dirFor(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${r.id}.json`);
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
  return path;
}

export function deleteReason(root: string, id: string): boolean {
  const path = join(dirFor(root), `${id}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function loadReasons(root: string, file?: string): Reason[] {
  const dir = dirFor(root);
  if (!existsSync(dir)) return [];
  const out: Reason[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as Reason;
      if (!file || r.file === file) out.push(r);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.anchor.startLine - b.anchor.startLine);
}
