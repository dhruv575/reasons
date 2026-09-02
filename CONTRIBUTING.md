# Contributing

```
npm install
npm run build        # hooks run dist/cli.js, so rebuild after every change to src/
npm test             # unit tests + an end-to-end suite that drives the built CLI in a throwaway repo
```

Two rules that keep this project honest:

**Resolver changes are measured, not argued.** Before changing anything in `src/resolve.ts` or `src/locate.ts`, run the evaluator against a real repository and include the before/after numbers in your PR:

```
git clone https://github.com/tj/commander.js /tmp/commander
node dist/cli.js eval --repo /tmp/commander --commits 60 -v
```

The number that matters is the misleading rate (wrong line or ghost). A change that tracks more edits but misleads more often is a regression.

**This repo uses itself.** When you fix something non-obvious, record why on the line it explains:

```
node dist/cli.js add src/file.ts --match "unique text on the line" "why" --source your-name
```

Hooks in `.claude/settings.json` are active for Claude Code sessions in this repo, so if you work with an agent it will see those notes and be asked to add its own.
