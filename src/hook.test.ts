import { test } from "node:test";
import assert from "node:assert/strict";
import { patterns } from "./hook.ts";

const { TEST_CMD, REVERT_CMD, FAIL_SIGNS, stripQuotes } = patterns;
const isRevert = (c: string) => REVERT_CMD.test(stripQuotes(c));
const isTest = (c: string) => TEST_CMD.test(stripQuotes(c));

test("revert commands at a boundary", () => {
  for (const c of [
    "git checkout -- a.ts", "cd x && git restore b", "npm run build; git reset --hard HEAD~1", "git revert abc123",
    "git stash pop", "git checkout .", "git checkout HEAD~1 -- f", "git -C sub checkout -- f", "git checkout 0123abcd -- f",
  ]) assert.ok(isRevert(c), c);
});

test("non-reverts and mentions do not count", () => {
  for (const c of [
    `printf '%s' '{"command":"git checkout -- x"}' | node cli.js hook`, `echo "run git restore later"`, "git checkout feature-branch",
    "git restore --staged f", "cat <<EOF\ngit checkout -- x\nEOF", "echo don't && git status", "# git checkout -- x",
  ]) assert.equal(isRevert(c), false, c);
});

test("test commands, including prefixes and wrappers", () => {
  for (const c of [
    "npm test", "npm t", "npm run test -- --watch", "npx vitest run", "pytest tests/", "python -m pytest", "cargo test", "go test ./...",
    "node --test src/", "tsx --test src/*.test.ts", "npx tsx --test src/a.test.ts", "CI=true npm test", "make test", "pnpm vitest",
    "./node_modules/.bin/jest", "timeout 60 npm test", "cd pkg && npm test 2>&1 | tail -20",
  ]) assert.ok(isTest(c), c);
  for (const c of ["npm run build", `grep "npm test" README.md`, "echo don't && echo 'npm test'"]) assert.equal(isTest(c), false, c);
});

test("failure signs come from summaries, not test names", () => {
  for (const out of ["1 failing", "Tests: 2 failed, 5 passed", "FAIL src/a.test.ts", "not ok 3", "ℹ fail 1", "✖ retries (2ms)", "Traceback (most recent call last)", "AssertionError [ERR_ASSERTION]"]) {
    assert.ok(FAIL_SIGNS.test(out), out);
  }
  // A logged "Error:" inside a passing run is common; it must not count, or red becomes sticky.
  for (const out of ["✔ returns error when request failed (1ms)", "ℹ pass 12\nℹ fail 0", "12 passed", "ok 1 - handles failed login", "Error: expected, logged by the test\n12 passed"]) {
    assert.equal(FAIL_SIGNS.test(out), false, out);
  }
});
