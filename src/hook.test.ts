import { test } from "node:test";
import assert from "node:assert/strict";
import { patterns } from "./hook.ts";

const { TEST_CMD, REVERT_CMD, stripQuotes } = patterns;
const isRevert = (c: string) => REVERT_CMD.test(stripQuotes(c));
const isTest = (c: string) => TEST_CMD.test(stripQuotes(c));

test("revert commands at a boundary", () => {
  for (const c of ["git checkout -- a.ts", "cd x && git restore b", "npm run build; git reset --hard HEAD~1", "git revert abc123", "git stash pop"]) {
    assert.ok(isRevert(c), c);
  }
});

test("mentions of revert commands inside strings do not count", () => {
  assert.equal(isRevert(`printf '%s' '{"command":"git checkout -- x"}' | node cli.js hook`), false);
  assert.equal(isRevert(`echo "run git restore later"`), false);
  assert.equal(isRevert("git checkout feature-branch"), false);
});

test("test commands", () => {
  for (const c of ["npm test", "npm run test -- --watch", "npx vitest run", "pytest tests/", "cargo test", "go test ./...", "node --test src/", "tsx --test src/*.test.ts"]) {
    assert.ok(isTest(c), c);
  }
  assert.equal(isTest("npm run build"), false);
  assert.equal(isTest(`grep "npm test" README.md`), false);
});
