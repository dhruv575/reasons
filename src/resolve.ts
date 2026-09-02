import type { Anchor } from "./store.js";
import { normalize } from "./store.js";

export type Status = "exact" | "moved" | "fuzzy" | "stale";

export interface Resolution {
  status: Status;
  startLine?: number;   // 1-based
  endLine?: number;
  score: number;        // 0..1 similarity of matched region to anchor
  context: number;      // 0..1 how well the neighbours at the match agree with the recorded context
}

const FUZZY_THRESHOLD = 0.6;
const STRONG_CTX = 0.8, WEAK_CORE = 0.5;
/** A "moved" exact match must keep some of its neighbours, or it's a coincidental copy elsewhere. */
export const MOVED_CTX_FLOOR = 0.2;
/** Trivial anchors (`}`, `});`, `return;`) recur everywhere, so they need a stronger neighbourhood. */
const TRIVIAL_CHARS = 16;
const TRIVIAL_CTX_FLOOR = 0.34;

interface Prepared { norm: string; toks: Set<string> }

function prepare(line: string): Prepared {
  const norm = normalize(line);
  return { norm, toks: new Set(norm.split(/[^\w]+/).filter(Boolean)) };
}

/** 1 if equal after whitespace normalisation, else token Jaccard. */
function sim(a: Prepared, b: Prepared): number {
  if (a.norm === b.norm) return 1;
  if (!a.norm || !b.norm || !a.toks.size || !b.toks.size) return 0;
  let inter = 0;
  for (const t of a.toks) if (b.toks.has(t)) inter++;
  return inter / (a.toks.size + b.toks.size - inter);
}

const EMPTY: Prepared = { norm: "", toks: new Set() };

class Matcher {
  file: Prepared[];
  lines: Prepared[]; before: Prepared[]; after: Prepared[];
  constructor(fileLines: string[], anchor: Anchor) {
    this.file = fileLines.map(prepare);
    this.lines = anchor.lines.map(prepare);
    this.before = anchor.before.map(prepare);
    this.after = anchor.after.map(prepare);
  }
  at(i: number): Prepared { return this.file[i] ?? EMPTY; }
  core(at: number): number {
    let s = 0;
    for (let i = 0; i < this.lines.length; i++) s += sim(this.at(at + i), this.lines[i]);
    return s / this.lines.length;
  }
  exact(at: number): boolean {
    if (at < 0 || at + this.lines.length > this.file.length) return false;
    for (let i = 0; i < this.lines.length; i++) if (this.at(at + i).norm !== this.lines[i].norm) return false;
    return true;
  }
  ctx(at: number): number {
    let s = 0, n = 0;
    this.before.forEach((l, i) => { n++; s += sim(this.at(at - this.before.length + i), l); });
    this.after.forEach((l, i) => { n++; s += sim(this.at(at + this.lines.length + i), l); });
    return n ? s / n : 1;
  }
  /** Context is a tie-breaker worth at most 15% so it can't rescue a bad core match. */
  region(at: number): number { return this.core(at) * 0.85 + this.ctx(at) * 0.15; }
}

export function resolveAnchor(fileLines: string[], anchor: Anchor): Resolution {
  const n = anchor.lines.length;
  if (n === 0 || fileLines.length === 0) return { status: "stale", score: 0, context: 0 };
  const m = new Matcher(fileLines, anchor);
  const hint = anchor.startLine - 1;
  const trivial = anchor.lines.map(normalize).join("").length < TRIVIAL_CHARS;

  // 1+2. Every exact occurrence, ranked by how well its neighbours agree, then by
  //      distance from the hint. The hint only wins if nothing else fits better;
  //      a `});` that stayed put while the code above it moved is the classic trap.
  let best = -1, bestCtx = -1;
  for (let at = 0; at + n <= m.file.length; at++) {
    if (!m.exact(at)) continue;
    const c = m.ctx(at);
    if (c > bestCtx + 1e-9 || (Math.abs(c - bestCtx) < 1e-9 && Math.abs(at - hint) < Math.abs(best - hint))) { best = at; bestCtx = c; }
  }
  if (best >= 0) {
    if (best === hint) return { status: "exact", startLine: hint + 1, endLine: hint + n, score: 1, context: bestCtx };
    if (bestCtx >= (trivial ? TRIVIAL_CTX_FLOOR : MOVED_CTX_FLOOR)) return { status: "moved", startLine: best + 1, endLine: best + n, score: 1, context: bestCtx };
    // Identical text in unfamiliar surroundings is a coincidence, not a match. Fall through to fuzzy,
    // which may still find the edited original near its old neighbours.
  }

  // 3. Fuzzy sliding window over the file.
  let bestScore = 0, bestAt = -1;
  for (let at = 0; at + n <= m.file.length; at++) {
    const sc = m.region(at);
    if (sc > bestScore || (sc === bestScore && Math.abs(at - hint) < Math.abs(bestAt - hint))) { bestScore = sc; bestAt = at; }
  }
  if (bestAt >= 0) {
    const ctx = m.ctx(bestAt);
    // A short line with a small edit (`=> 1` to `=> 2`) scores badly on tokens alone, but if all
    // six neighbours still match it is the same line. Strong context lowers the bar for the core.
    if (bestScore >= FUZZY_THRESHOLD || (ctx >= STRONG_CTX && m.core(bestAt) >= WEAK_CORE)) {
      return { status: "fuzzy", startLine: bestAt + 1, endLine: bestAt + n, score: bestScore, context: ctx };
    }
  }
  return { status: "stale", score: bestScore, context: 0 };
}
