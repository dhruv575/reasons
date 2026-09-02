/**
 * Claude Code PostToolUse hook. Reads the hook payload on stdin; if the tool
 * read a file with live reasons, returns them as additionalContext so they
 * arrive stapled to the code without the agent having to ask.
 */
import { readFileSync } from "node:fs";
import { toRepoPath } from "./store.js";
import { resolveFile } from "./cli.js";

interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string };
}

export function runHook(root: string): void {
  let input: HookInput = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return; }

  const filePath = input.tool_input?.file_path ?? input.tool_input?.path;
  if (!filePath || input.tool_name !== "Read") return;

  const repoFile = toRepoPath(root, filePath);
  if (repoFile.startsWith("..")) return; // outside this repo

  const live = resolveFile(root, repoFile).filter((r) => r.res.status !== "stale");
  if (!live.length) return;

  const body = live.map(({ reason, res }) => {
    const where = res.startLine === res.endLine ? `line ${res.startLine}` : `lines ${res.startLine}-${res.endLine}`;
    const conf = res.status === "fuzzy" ? " (approximate location)" : "";
    return `- ${where}${conf}: ${reason.note}`;
  }).join("\n");

  const context =
    `Recorded reasons for ${repoFile} (from .reasons/, authoritative; do not "clean up" these lines without addressing the note):\n${body}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
  }));
}
