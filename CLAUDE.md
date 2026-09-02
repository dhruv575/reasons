# reasons

A git-native annotation layer. Each file in `.reasons/` pins a short *why* to a region of code by content, not line number. Hooks in `.claude/settings.json` surface live reasons when you Read a file, warn before you edit an annotated line, and ask for a reason after tests go red-to-green or after a revert. Treat those notes as authoritative: do not simplify or remove an annotated line without addressing the note.

Commands: `npm run build`, `npm test`, `node dist/cli.js <add|show|doctor|rm|init|eval|hook>`.

Always rebuild after editing `src/`; the hooks run `dist/cli.js`, so a stale build means stale hooks.

When you discover a non-obvious reason for code (a fix after a failing test, a revert, a "so that's why"), record it:

    node dist/cli.js add <file>:<start>-<end> "one line on why" --source claude-code

Evaluate resolver changes against real history before committing them:

    node dist/cli.js eval --repo <path-to-any-git-repo> --commits 60 -v
