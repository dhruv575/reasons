import type { Anchor } from "./store.js";
import { normalize } from "./store.js";

export type Status = "exact" | "moved" | "fuzzy" | "stale";

export interface Resolution {
  status: Status;
  startLine?: number;   // 1-based
  endLine?: number;
  score: number;        // 0..1 similarity of matched region to anchor
}

const FUZZY_THRESHOLD = 0.6;

/** Similarity between two lines: 1 if equal after whitespace normalisation, else token Jaccard. */
function lineSim(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const ta = new Set(na.split(/[^\w]+/).filter(Boolean));
  const tb = new Set(nb.split(/[^\w]+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function regionScore(file: string[], at: number, anchor: Anchor): number {
  const n = anchor.lines.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += lineSim(file[at + i] ?? "", anchor.lines[i]);
  let core = s / n;
  // Context is a tie-breaker worth at most 15% so it can't rescue a bad core match.
  let ctx = 0, ctxN = 0;
  anchor.before.forEach((l, i) => { ctxN++; ctx += lineSim(file[at - anchor.before.length + i] ?? "", l); });
  anchor.after.forEach((l, i) => { ctxN++; ctx += lineSim(file[at + n + i] ?? "", l); });
  return ctxN ? core * 0.85 + (ctx / ctxN) * 0.15 : core;
}

export function resolveAnchor(fileLines: string[], anchor: Anchor): Resolution {
  const n = anchor.lines.length;
  if (n === 0 || fileLines.length === 0) return { status: "stale", score: 0 };

  const exactAt = (at: number) =>
    at >= 0 && at + n <= fileLines.length &&
    anchor.lines.every((l, i) => normalize(fileLines[at + i]) === normalize(l));

  // 1. Still where we left it.
  const hint = anchor.startLine - 1;
  if (exactAt(hint)) return { status: "exact", startLine: hint + 1, endLine: hint + n, score: 1 };

  // 2. Exact text somewhere else. Short anchors like `}` recur, so rank by
  //    surrounding context and only then by distance from the hint.
  let best: number | undefined, bestCtx = -1;
  for (let at = 0; at + n <= fileLines.length; at++) {
    if (!exactAt(at)) continue;
    const ctx = regionScore(fileLines, at, anchor);
    if (ctx > bestCtx || (ctx === bestCtx && best !== undefined && Math.abs(at - hint) < Math.abs(best - hint))) { best = at; bestCtx = ctx; }
  }
  if (best !== undefined) return { status: "moved", startLine: best + 1, endLine: best + n, score: 1 };

  // 3. Fuzzy sliding window over the file.
  let bestScore = 0, bestAt = -1;
  for (let at = 0; at + n <= fileLines.length; at++) {
    const sc = regionScore(fileLines, at, anchor);
    if (sc > bestScore || (sc === bestScore && Math.abs(at - hint) < Math.abs(bestAt - hint))) { bestScore = sc; bestAt = at; }
  }
  if (bestScore >= FUZZY_THRESHOLD) {
    return { status: "fuzzy", startLine: bestAt + 1, endLine: bestAt + n, score: bestScore };
  }
  return { status: "stale", score: bestScore };
}
