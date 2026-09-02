# reasons

Pin the *why* to the code it explains. Reasons live in `.reasons/` as plain JSON, travel with the repo, anchor to code by content rather than line number, and surface automatically when a human or an agent touches that code.

Every repo has decisions that live only in someone's head: why the retry count is 3, why the migration was split, why the obvious refactor was reverted in 2023. Git blame gives you *who* and a commit message gives you a sentence. Then the person leaves and the reason is gone. This tool records the reason at the moment it is discovered and hands it back at the moment it is needed.

## Quick start

```
npm install && npm run build
node dist/cli.js init                    # in any repo: installs hooks + a CLAUDE.md note
node dist/cli.js add src/retry.ts:14 "3 not 5: 5 tripped the upstream rate limit in prod, see #412"
node dist/cli.js show src/retry.ts       # add --json for machines
node dist/cli.js list                    # every reason in the repo
node dist/cli.js doctor                  # exits 1 if any reason has moved, drifted, or gone stale
node dist/cli.js rm <id>
```

Agents can also pipe a record in, which sidesteps shell quoting:

```
echo '{"file":"src/retry.ts","start":14,"note":"...","source":"claude-code"}' | node dist/cli.js add --json
```

## How agents meet it

Telling an agent "remember to run the CLI" does not work. Agents forget the way humans do, only faster. So everything here is structural: reasons reach the agent without it asking, and capture is prompted by hooks at the moment a reason is discovered.

`reasons init` registers four Claude Code hooks, all served by one `reasons hook` entry point:

| when | what happens |
| --- | --- |
| after `Read` | live reasons for that file are appended to the tool result, marked authoritative |
| before `Edit` / `Write` | if the edit overlaps an annotated region, the note is shown first, with the id to remove it if it no longer applies |
| after `Bash` runs tests | if tests went red, then you edited, then they went green, a one-line prompt asks for the why. Skippable, capped at three per session |
| after `Bash` reverts | `git revert`, `git restore`, `git checkout --`, `git reset --hard` trigger a prompt to record why the backed-out approach failed |
| on `Stop` | if a red-to-green fix went unrecorded, one final question before the session ends. Asked once, never repeated |

Both `Bash` patterns match only at a shell command boundary and ignore quoted strings, so a command that merely mentions `git checkout --` does not fire.

## How anchoring works

Each reason stores the anchored lines plus three lines of context on either side. On every read it is re-located:

| status | meaning |
| --- | --- |
| exact | still at the original line |
| moved | same text, different line, and its neighbours came with it |
| fuzzy | text edited but still recognisable (similarity above 0.6) |
| stale | no longer found; hidden from agents, reported by `doctor` |

Whitespace changes never affect matching. Blank-only anchors are refused. Exact matches are ranked by how well their surroundings agree, so a `});` that stayed put while the code above it moved does not win by default. A moved match must keep some of its neighbours, otherwise it is a coincidental copy and the resolver falls through to fuzzy matching.

## Measuring it

`reasons eval --repo <path>` plants anchors on random lines at an older commit and checks whether they resolve correctly at a newer one. Ground truth comes from the diff, so any git history is a test set. It reports the outcomes that matter separately: a reason that lands on the wrong line is worse than one that goes missing.

Planting anchors on random lines one commit before HEAD-n and resolving one commit later, over the last 60 commits of commander.js and 150 of execa:

| | commander.js | execa |
| --- | --- | --- |
| unchanged line found | 98.9% | 99.7% |
| edited line tracked | 62% | 79% |
| deleted line correctly expired | 97% | 89% |
| misleading (wrong line or ghost) | 0.9% | 0.6% |

The evaluator found four resolver and evaluator bugs in its first hour. Three of them are recorded in this repo's own `.reasons/`, on the lines they explain.

## Not yet built

- Symbol-aware anchoring via tree-sitter so a reason can follow a function through a rename.
- An MCP server for agents other than Claude Code, and an editor gutter marker for humans.
- Multi-file reasons: one note that spans a caller and a callee.
