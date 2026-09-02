# reasons

Pin the *why* to the code it explains. Reasons live in `.reasons/` as plain JSON, travel with the repo, anchor to code by content rather than line number, and surface automatically when a human or an agent touches that code.

## Quick start

```
npm install && npm run build
node dist/cli.js add src/retry.ts:14 "3 not 5: 5 tripped the upstream rate limit in prod, see #412"
node dist/cli.js show src/retry.ts
node dist/cli.js doctor        # exits 1 if any reason has moved, drifted, or gone stale
node dist/cli.js rm <id>
```

## How anchoring works

Each reason stores the anchored lines plus three lines of context on either side. On every read it is re-located:

| status | meaning |
| --- | --- |
| exact | still at the original line |
| moved | same text, different line (ranked by surrounding context) |
| fuzzy | text edited but still recognisable (similarity above 0.6) |
| stale | no longer found; hidden from agents, reported by `doctor` |

Whitespace changes never affect matching. Blank-only anchors are refused.

## Agent integration

`.claude/settings.json` registers a `PostToolUse` hook on `Read`. When Claude Code reads a file with live reasons, the hook returns them as `additionalContext`, so they arrive stapled to the file contents without the agent asking. `CLAUDE.md` tells the agent the notes are authoritative and how to record new ones.

## Not yet built

- Capture triggers: fail-then-pass tests, reverts, and undo-edits detected from hooks, prompting for a one-line reason at the moment of discovery.
- Symbol-aware anchoring via tree-sitter so a reason can follow a function through a rename.
- An MCP server for agents other than Claude Code, and an editor gutter marker for humans.
