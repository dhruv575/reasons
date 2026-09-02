/**
 * Where is each reason *now*? Resolves anchors against the working tree,
 * including reasons whose recorded file has since been moved or renamed.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadReasons, normalize, type Reason } from "./store.js";
import { resolveAnchor, MOVED_CTX_FLOOR, type Resolution } from "./resolve.js";

export interface Resolved {
  reason: Reason;
  res: Resolution;
  /** Where the reason lives now (differs from reason.file only for relocated orphans). */
  file: string;
  /** Set when the reason was recorded against a file that no longer exists and was found in this one. */
  movedFrom?: string;
}

export function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

/** A cross-file claim needs identical text *and* familiar neighbours; a lone `return null;` proves nothing. */
function convincingElsewhere(res: Resolution): boolean {
  return (res.status === "exact" || res.status === "moved") && res.context >= MOVED_CTX_FLOOR;
}

/** Reasons for `repoFile`: its own, plus orphans (recorded file gone) that resolve convincingly here. */
export function resolveFile(root: string, repoFile: string): Resolved[] {
  const abs = join(root, repoFile);
  const lines = existsSync(abs) ? readLines(abs) : [];
  const own: Resolved[] = loadReasons(root, repoFile).map((reason) => ({ reason, res: resolveAnchor(lines, reason.anchor), file: repoFile }));
  const orphans: Resolved[] = lines.length
    ? loadReasons(root)
        .filter((r) => r.file !== repoFile && !existsSync(join(root, r.file)))
        .map((reason) => ({ reason, res: resolveAnchor(lines, reason.anchor), file: repoFile, movedFrom: reason.file }))
        .filter((x) => convincingElsewhere(x.res))
    : [];
  return [...own, ...orphans].sort((a, b) => (a.res.startLine ?? 1e9) - (b.res.startLine ?? 1e9));
}

function git(root: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).toString(); }
  catch { return ""; }
}

/**
 * For a reason whose file is gone: look for the file's new home. Same basename
 * first (a move), then any tracked file containing the anchor's first content
 * line (a rename). Returns the best convincing match.
 */
export function relocate(root: string, reason: Reason): { file: string; res: Resolution } | undefined {
  const tracked = git(root, ["ls-files"]).split("\n").filter(Boolean);
  const base = basename(reason.file);
  const firstContent = reason.anchor.lines.find((l) => normalize(l).length >= 8) ?? reason.anchor.lines[0];
  const grepHits = firstContent ? git(root, ["grep", "-lF", "--", normalize(firstContent).slice(0, 80)]).split("\n").filter(Boolean) : [];
  const candidates = [...new Set([...tracked.filter((f) => basename(f) === base), ...grepHits])].filter((f) => f !== reason.file);
  let best: { file: string; res: Resolution } | undefined;
  for (const file of candidates) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const res = resolveAnchor(readLines(abs), reason.anchor);
    if (!convincingElsewhere(res)) continue;
    if (!best || res.context > best.res.context) best = { file, res };
  }
  return best;
}
