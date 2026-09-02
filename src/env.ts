import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * How to invoke this CLI from a shell in any repo. Prefer the bare `reasons`
 * when it is on PATH (npm link / global install), so hook commands written
 * into a shared settings.json work for every collaborator; otherwise fall
 * back to node + this file's absolute path.
 */
export function cliCmd(): string {
  if (process.env.REASONS_CLI) return process.env.REASONS_CLI;
  if (cached) return cached;
  try {
    execSync(process.platform === "win32" ? "where reasons" : "command -v reasons", { stdio: "ignore" });
    return (cached = "reasons");
  } catch { /* not linked */ }
  const self = fileURLToPath(new URL("./cli.js", import.meta.url)).replace(/\\/g, "/");
  return (cached = `node "${self}"`);
}
