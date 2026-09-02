import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHunks, mapLine } from "./eval.ts";

test("parseHunks handles single-line and zero-length forms", () => {
  const h = parseHunks("@@ -1,0 +2,2 @@ x\n@@ -5 +7 @@ y\n@@ -9,3 +11,0 @@ z");
  assert.deepEqual(h, [
    { oldStart: 1, oldLen: 0, newStart: 2, newLen: 2 },
    { oldStart: 5, oldLen: 1, newStart: 7, newLen: 1 },
    { oldStart: 9, oldLen: 3, newStart: 11, newLen: 0 },
  ]);
});

test("pure insertion leaves the line it was inserted after untouched", () => {
  const old = ["a", "b", "c"], neu = ["a", "x", "y", "b", "c"];
  const hunks = parseHunks("@@ -1,0 +2,2 @@");
  assert.deepEqual(mapLine(hunks, old, neu, 1), { kind: "same", lines: [1] });
  assert.deepEqual(mapLine(hunks, old, neu, 2), { kind: "same", lines: [4] });
});

test("deletion, edit, and cross-hunk move", () => {
  const old = ["a", "const MAX = 3;", "c", "d"];
  const neu = ["a", "const MAX = 3 as const;", "d", "c"];
  // line 2 edited in place; line 3 (c) moved after d: diff shows hunk -2,2 +2,3
  const hunks = parseHunks("@@ -2,2 +2,3 @@");
  assert.deepEqual(mapLine(hunks, old, neu, 2), { kind: "edited", lines: [2] });
  assert.deepEqual(mapLine(hunks, old, neu, 3), { kind: "same", lines: [4] });
  const gone = parseHunks("@@ -2,1 +1,0 @@");
  assert.deepEqual(mapLine(gone, old, ["a", "c", "d"], 2), { kind: "deleted" });
});
