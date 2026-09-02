# Changelog

## 0.3.0 (2026-09-02)

First public release.

- Content-anchored reasons in `.reasons/` with exact / moved / fuzzy / relocated / stale resolution
- Reasons follow files through moves and renames
- Claude Code hooks: notes on Read, guard before Edit, capture after red-to-green tests, reverts, undo-edits, and once on Stop
- `reasons init` installs hooks into any repo without touching other hooks
- `add` by line range, `--match "text"`, or `#symbol`; echoes the anchored line
- `show`, `why`, `list`, `diff [base] [--check]`, `doctor [--fix] [--prune]`, `rm`
- MCP server over stdio for agents other than Claude Code
- `eval`: anchor-survival benchmark over any git history
