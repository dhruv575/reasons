# reasons

A git-native annotation layer. Each file in `.reasons/` pins a short *why* to a region of code by content, not line number. When you Read a file, a hook appends any live reasons for it as context. Treat those notes as authoritative: do not simplify or remove an annotated line without addressing the note.

Commands: `npm run build`, `npm test`, `node dist/cli.js <add|show|doctor|rm|hook>`.

When you discover a non-obvious reason for code (a fix after a failing test, a revert, a "so that's why"), record it:

    node dist/cli.js add <file>:<start>-<end> "one line on why" --source claude-code
