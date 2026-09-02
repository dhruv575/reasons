# reasons

Pin the *why* to the code it explains. Reasons live in `.reasons/` as plain JSON, travel with the repo, anchor to code by content rather than line number, follow files through moves and renames, and surface automatically when a human or an agent touches that code.

Every repo has decisions that live only in someone's head: why the retry count is 3, why the migration was split, why the obvious refactor was reverted in 2023. Git blame gives you *who* and a commit message gives you a sentence. Then the person leaves and the reason is gone. This tool records the reason at the moment it is discovered and hands it back at the moment it is needed.

## Quick start

```
npm install && npm run build && npm link     # puts `reasons` on PATH
cd ~/some/repo && reasons init               # installs hooks + a CLAUDE.md note

reasons add src/retry.ts:14 "3 not 5: 5 tripped the upstream rate limit in prod" --link https://github.com/o/r/issues/412
reasons add src/retry.ts#retry "..."         # anchor to the line that declares `retry`
reasons show src/retry.ts                    # live reasons for a file (--json for machines)
reasons diff origin/main                     # reasons touched by a diff; --check exits 1 for CI
reasons why src/retry.ts:14                  # just the ones covering a line
reasons list                                 # every reason in the repo
reasons doctor                               # moved / fuzzy / relocated / stale; exit 1 if fuzzy or stale
reasons doctor --fix                         # re-pin moved, fuzzy and relocated anchors
reasons doctor --prune                       # delete stale ones
reasons rm <id>
```

Agents can pipe a record in, which sidesteps shell quoting:

```
echo '{"file":"src/retry.ts","start":14,"note":"...","source":"claude-code"}' | reasons add --json
```

## What a good reason looks like

Name the constraint and what breaks without it, not what the code does.

- good: `3 not 5: 5 retries tripped the upstream rate limit in prod (#412)`
- good: `must run before loadConfig(); it reads the env var this sets`
- bad: `retry loop`, `fixed the bug`, anything the code already says

Anchor the line someone would be tempted to change, not the whole function. Adding the same note to the same lines twice is a no-op.

## How agents meet it

Telling an agent "remember to run the CLI" does not work. Agents forget the way humans do, only faster. So everything here is structural: reasons reach the agent without it asking, and capture is prompted by hooks at the moment a reason is discovered.

`reasons init` registers Claude Code hooks, all served by one `reasons hook` entry point:

| when | what happens |
| --- | --- |
| after `Read` | live reasons for that file are appended to the tool result, marked authoritative. A windowed read gets only the notes in range plus a count of the rest |
| before `Edit` / `Write` | if the edit overlaps an annotated region, the note is shown first, with the id to remove it if it no longer applies |
| after `Bash` runs tests | if tests went red, then you edited, then they went green, a one-line prompt asks for the why. Skippable, capped at three per session |
| after `Bash` reverts | `git revert`, `git restore`, `git checkout --`, `git reset --hard` trigger a prompt to record why the backed-out approach failed |
| after an `Edit` that undoes an earlier edit | agents rarely run `git revert`; they edit the old text back. That is detected and prompts the same way |
| on `Stop` | if a red-to-green fix went unrecorded, one final question before the session ends. Asked once, never repeated |

Both `Bash` patterns match only at a shell command boundary and ignore quoted strings, so a command that merely mentions `git checkout --` does not fire.

For agents that are not Claude Code, `reasons mcp` serves the same data over MCP on stdio with no SDK dependency: `reasons_for_file`, `reasons_add`, `reasons_list`, `reasons_rm`. Register it with `claude mcp add reasons -- reasons mcp` or the equivalent in Cursor or Codex.

## How anchoring works

Each reason stores the anchored lines plus three lines of context on either side. On every read it is re-located:

| status | meaning |
| --- | --- |
| exact | still at the original line |
| moved | same text, different line, and its neighbours came with it |
| fuzzy | text edited but still recognisable: similarity above 0.6, or above 0.5 when the surrounding lines still match |
| relocated | the recorded file is gone, but text and neighbours match in another file. `doctor --fix` follows it |
| stale | no longer found; hidden from agents, reported by `doctor` |

Whitespace changes never affect matching. Blank-only anchors are refused. Exact matches are ranked by how well their surroundings agree, so a `});` that stayed put while the code above it moved does not win by default. A moved or relocated match must keep some of its neighbours, otherwise it is a coincidental copy and the resolver falls through to fuzzy matching.

## Measuring it

`reasons eval --repo <path>` plants anchors on random lines at an older commit and checks whether they resolve correctly at a newer one. Ground truth comes from the diff, so any git history is a test set. It reports the outcomes that matter separately: a reason that lands on the wrong line is worse than one that goes missing.

Planting anchors one commit before HEAD-n and resolving one commit later, over the last 60 commits of commander.js and 150 of execa:

| | commander.js | execa |
| --- | --- | --- |
| unchanged line found | 99.0% | 99.6% |
| edited line tracked | 85% | 92% |
| deleted line correctly expired | 96% | 79% |
| misleading (wrong line or ghost) | 0.8% | 0.8% |

(Last 60 commits of each, 5 anchors per changed file. The execa deleted-line sample is small, 38 lines.) Twenty commits apart on commander the misleading rate is about 2%, nearly all of it inside the lockfile, which the evaluator now skips.

The evaluator found four resolver and evaluator bugs in its first hour. They are recorded in this repo's own `.reasons/`, on the lines they explain, which is the point.

## Tests

`npm test` runs resolver unit tests, hook pattern tests, evaluator line-mapping tests, and an end-to-end suite that drives the built CLI through add, symbol targets, move, rename, hooks, red-to-green capture, undo detection, diff, Stop, prune, init, and MCP in a throwaway git repo.

## Not yet built

- Symbol-aware anchoring via tree-sitter so a reason can follow a function through a rename of the anchored line itself.
- An editor gutter marker for humans.
- Multi-file reasons: one note that spans a caller and a callee.
