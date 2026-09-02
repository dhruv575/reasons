import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAnchor } from "./store.ts";
import { resolveAnchor } from "./resolve.ts";

const src = [
  "import x from 'x';",
  "",
  "export function retry(fn) {",
  "  const MAX = 3; // not 5",
  "  for (let i = 0; i < MAX; i++) {",
  "    try { return fn(); } catch {}",
  "  }",
  "}",
];
const anchor = makeAnchor(src, 4, 4);

test("exact at hint", () => {
  assert.equal(resolveAnchor(src, anchor).status, "exact");
});

test("moved when lines inserted above", () => {
  const moved = ["// header", "// header2", ...src];
  const r = resolveAnchor(moved, anchor);
  assert.equal(r.status, "moved");
  assert.equal(r.startLine, 6);
});

test("fuzzy when line edited slightly", () => {
  const edited = src.map((l) => l.replace("const MAX = 3;", "const MAX = 3 as const;"));
  const r = resolveAnchor(edited, anchor);
  assert.equal(r.status, "fuzzy");
  assert.equal(r.startLine, 4);
});

test("stale when line removed", () => {
  const gone = src.filter((_, i) => i !== 3).map((l) => l.replace("MAX", "5"));
  assert.equal(resolveAnchor(gone, anchor).status, "stale");
});

test("whitespace changes still exact", () => {
  const reindented = src.map((l) => l.replace(/^  /, "\t"));
  assert.equal(resolveAnchor(reindented, anchor).status, "exact");
});

test("moved short anchor picks the occurrence with matching context", () => {
  const file = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}"];
  const a = makeAnchor(file, 7, 7); // the closing brace of b
  const grown = ["function a() {", "  return 1;", "}", "", "// new", "// new", "function b() {", "  return 2;", "}"];
  const r = resolveAnchor(grown, a);
  assert.equal(r.status, "moved");
  assert.equal(r.startLine, 9);
});
