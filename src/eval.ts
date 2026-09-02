/**
 * Anchor-survival evaluator.
 *
 * Walks a git history, plants anchors on random content lines at an older
 * commit, and checks whether the resolver finds them again at a newer commit.
 * Ground truth comes from the unified diff between the two revisions, so no
 * human labelling is needed.
 *
 * Every sampled line ends up in one of these outcomes:
 *   hit        survived unchanged; resolver found the right line
 *   near       survived unchanged; resolver found an identical copy within 2 rows (ambiguous alignment)
 *   drift      survived unchanged; resolver found the wrong line       (bad: misleading)
 *   miss       survived unchanged; resolver said stale                 (bad: reason lost)
 *   edit-hit   line was modified in place; resolver found its new form
 *   edit-miss  line was modified in place; resolver said stale or landed elsewhere
 *   gone-ok    line was deleted; resolver said stale
 *   ghost      line was deleted; resolver still "found" it             (bad: misleading)
 */
import { execFileSync } from "node:child_process";
import { makeAnchor, normalize } from "./store.js";
import { resolveAnchor } from "./resolve.js";

export type Outcome = "hit" | "near" | "drift" | "miss" | "edit-hit" | "edit-miss" | "gone-ok" | "ghost";

export interface EvalOptions {
  repo: string;
  commits: number;    // how many commits back from HEAD to sample from
  samples: number;    // anchors per (file, revision) pair
  span: number;       // resolve N commits later than the anchor commit
  seed: number;
  verbose?: boolean;
}

export interface EvalResult {
  counts: Record<Outcome, number>;
  total: number;
  pairs: number;
  examples: string[];
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Hunk { oldStart: number; oldLen: number; newStart: number; newLen: number }

export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4] });
  }
  return out;
}

type Truth = { kind: "same"; lines: number[] } | { kind: "edited"; lines: number[] } | { kind: "deleted" };

function toks(l: string): Set<string> { return new Set(normalize(l).split(/[^\w]+/).filter(Boolean)); }
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const t of a) if (b.has(t)) i++;
  return i / (a.size + b.size - i);
}

/**
 * Where does 1-based old line `l` end up? Outside hunks the answer is arithmetic.
 * Inside a hunk the diff can't say whether a line was edited, moved, or replaced,
 * so we look at every line the diff *added* anywhere in the file: an identical
 * line means it survived (possibly moved, possibly to several places), the most
 * similar line (if similar enough) means it was edited, otherwise it was deleted.
 */
export function mapLine(hunks: Hunk[], oldLines: string[], newLines: string[], l: number): Truth {
  let delta = 0, inside = false;
  for (const h of hunks) {
    const oldEnd = h.oldStart + h.oldLen; // exclusive
    // A pure insertion reports the old line it was inserted *after*, so that line is untouched.
    if (l < h.oldStart || (h.oldLen === 0 && l === h.oldStart)) return { kind: "same", lines: [l + delta] };
    if (l < oldEnd) { inside = true; break; }
    delta += h.newLen - h.oldLen;
  }
  if (!inside) return { kind: "same", lines: [l + delta] };

  const target = normalize(oldLines[l - 1]);
  const tt = toks(oldLines[l - 1]);
  const same: number[] = [];
  let bestSim = 0, best: number[] = [];
  for (const h of hunks) {
    for (let n = h.newStart; n < h.newStart + h.newLen; n++) {
      const cand = newLines[n - 1] ?? "";
      if (normalize(cand) === target) { same.push(n); continue; }
      const sm = jaccard(tt, toks(cand));
      if (sm > bestSim + 1e-9) { bestSim = sm; best = [n]; } else if (Math.abs(sm - bestSim) < 1e-9 && sm > 0) best.push(n);
    }
  }
  if (same.length) return { kind: "same", lines: same };
  return bestSim >= 0.5 ? { kind: "edited", lines: best } : { kind: "deleted" };
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|sh|md|json|yml|yaml|toml|css|scss|html)$/i;

const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

export function runEval(opts: EvalOptions): EvalResult {
  const rand = mulberry32(opts.seed);
  const revs = git(opts.repo, ["rev-list", "--first-parent", "-n", String(opts.commits + opts.span), "HEAD"]).trim().split("\n");
  const counts: Record<Outcome, number> = { hit: 0, near: 0, drift: 0, miss: 0, "edit-hit": 0, "edit-miss": 0, "gone-ok": 0, ghost: 0 };
  const examples: string[] = [];
  let total = 0, pairs = 0;

  // revs[0] is HEAD. Anchor at revs[i + span], resolve at revs[i].
  for (let i = 0; i + opts.span < revs.length; i++) {
    const newRev = revs[i], oldRev = revs[i + opts.span];
    const changed = git(opts.repo, ["diff", "--name-only", "--diff-filter=M", oldRev, newRev]).trim().split("\n").filter((f) => f && TEXT_EXT.test(f));
    for (const file of changed) {
      let oldText: string, newText: string;
      try {
        oldText = git(opts.repo, ["show", `${oldRev}:${file}`]);
        newText = git(opts.repo, ["show", `${newRev}:${file}`]);
      } catch { continue; }
      if (oldText.length > 400_000 || LOCKFILE.test(file)) continue; // nobody annotates a lockfile
      const oldLines = oldText.split(/\r?\n/), newLines = newText.split(/\r?\n/);
      const hunks = parseHunks(git(opts.repo, ["diff", "-U0", oldRev, newRev, "--", file]));
      const candidates = oldLines.map((l, idx) => idx + 1).filter((n) => normalize(oldLines[n - 1]).length >= 3);
      if (!candidates.length) continue;
      pairs++;

      for (let s = 0; s < opts.samples; s++) {
        const line = candidates[Math.floor(rand() * candidates.length)];
        const truth = mapLine(hunks, oldLines, newLines, line);
        const res = resolveAnchor(newLines, makeAnchor(oldLines, line, line));
        let outcome: Outcome;
        if (truth.kind === "same") {
          const at = res.startLine!;
          const nearDup = truth.lines.some((t) => Math.abs(at - t) <= 2) && normalize(newLines[at - 1] ?? "") === normalize(oldLines[line - 1]);
          outcome = res.status === "stale" ? "miss" : truth.lines.includes(at) ? "hit" : nearDup ? "near" : "drift";
        } else if (truth.kind === "edited") {
          outcome = res.status !== "stale" && truth.lines.some((t) => Math.abs(res.startLine! - t) <= 1) ? "edit-hit" : "edit-miss";
        } else {
          outcome = res.status === "stale" ? "gone-ok" : "ghost";
        }
        counts[outcome]++; total++;
        if (opts.verbose && (outcome !== "hit" && outcome !== "near" && outcome !== "gone-ok" && outcome !== "edit-hit") && examples.length < 25) {
          examples.push(`${outcome.padEnd(6)} ${file}:${line} -> ${res.status}${res.startLine ? `@${res.startLine}` : ""} (${Math.round(res.score * 100)}%)  ${normalize(oldLines[line - 1]).slice(0, 70)}`);
        }
      }
    }
  }
  return { counts, total, pairs, examples };
}

export function formatEval(r: EvalResult, opts: EvalOptions): string {
  const c = r.counts;
  const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "n/a";
  const unchanged = c.hit + c.near + c.drift + c.miss, edited = c["edit-hit"] + c["edit-miss"], deleted = c["gone-ok"] + c.ghost;
  const misleading = c.drift + c.ghost;
  const lines = [
    `anchors: ${r.total} across ${r.pairs} file pairs, span ${opts.span} commit(s), seed ${opts.seed}`,
    ``,
    `unchanged lines (${unchanged}):  found ${pct(c.hit, unchanged)}   near-dup ${pct(c.near, unchanged)}   drifted ${pct(c.drift, unchanged)}   lost ${pct(c.miss, unchanged)}`,
    `edited lines    (${edited}):  tracked ${pct(c["edit-hit"], edited)}   lost ${pct(c["edit-miss"], edited)}`,
    `deleted lines   (${deleted}):  expired ${pct(c["gone-ok"], deleted)}   ghosted ${pct(c.ghost, deleted)}`,
    ``,
    `misleading (drift+ghost): ${pct(misleading, r.total)}   <- the number that matters; a wrong note is worse than no note`,
  ];
  if (r.examples.length) lines.push(``, `failures:`, ...r.examples.map((e) => "  " + e));
  return lines.join("\n");
}
