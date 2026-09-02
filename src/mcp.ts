/**
 * Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited), no SDK
 * dependency. Exposes reasons to any MCP-speaking agent:
 *
 *   reasons_for_file   live reasons for a file (optionally just one line)
 *   reasons_add        record a reason
 *   reasons_list       every reason in the repo
 *   reasons_rm         delete a reason by id
 *
 * Register with e.g.  claude mcp add reasons -- reasons mcp
 * or the equivalent in Cursor / Codex / any MCP client.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { makeAnchor, newReason, normalize, saveReason, deleteReason, loadReasons, toRepoPath } from "./store.js";
import { resolveFile, readLines } from "./locate.js";

const TOOLS = [
  {
    name: "reasons_for_file",
    description: "Live reasons (the recorded *why* behind non-obvious code) for a file, with current line numbers. Treat them as authoritative. Optionally restrict to reasons covering one line.",
    inputSchema: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" } }, required: ["file"] },
  },
  {
    name: "reasons_add",
    description: "Record why a region of code is the way it is. One line: name the constraint and what breaks without it. Anchor the line someone would be tempted to change.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, note: { type: "string" }, link: { type: "string" }, source: { type: "string" } },
      required: ["file", "start", "note"],
    },
  },
  { name: "reasons_list", description: "Every reason in the repo with its current location and status.", inputSchema: { type: "object", properties: {} } },
  { name: "reasons_rm", description: "Delete a reason that no longer applies.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

function describe(items: ReturnType<typeof resolveFile>): string {
  const live = items.filter((x) => x.res.status !== "stale");
  if (!live.length) return "no live reasons";
  return live.map(({ reason, res, file, movedFrom }) => {
    const where = res.startLine === res.endLine ? `line ${res.startLine}` : `lines ${res.startLine}-${res.endLine}`;
    const tags = [res.status === "fuzzy" ? "approximate" : "", movedFrom ? `recorded on ${movedFrom}` : ""].filter(Boolean).join(", ");
    return `${file}:${where}${tags ? ` (${tags})` : ""}: ${reason.note}${reason.link ? ` (${reason.link})` : ""}  [id ${reason.id}]`;
  }).join("\n");
}

function call(root: string, name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "reasons_for_file": {
      const repoFile = toRepoPath(root, String(a.file));
      let items = resolveFile(root, repoFile);
      if (a.line) items = items.filter((x) => x.res.status !== "stale" && x.res.startLine! <= Number(a.line) && x.res.endLine! >= Number(a.line));
      return describe(items);
    }
    case "reasons_add": {
      const file = String(a.file), start = Number(a.start), end = Number(a.end ?? a.start), note = String(a.note ?? "").trim();
      if (!note) throw new Error("note is required");
      const abs = join(root, toRepoPath(root, file));
      const lines = readLines(abs);
      const count = lines.length - (lines.at(-1) === "" ? 1 : 0);
      if (end > count || start < 1 || end < start) throw new Error(`bad range for ${file} (${count} lines)`);
      const anchor = makeAnchor(lines, start, end);
      if (!anchor.lines.some((l) => normalize(l))) throw new Error("refusing to anchor blank lines");
      const r = newReason(root, toRepoPath(root, file), note, anchor, String(a.source ?? "mcp"));
      if (a.link) r.link = String(a.link);
      saveReason(root, r);
      return `recorded ${r.id}`;
    }
    case "reasons_list": {
      const files = [...new Set(loadReasons(root).map((r) => r.file))].sort();
      return describe(files.flatMap((f) => resolveFile(root, f)));
    }
    case "reasons_rm":
      return deleteReason(root, String(a.id)) ? `deleted ${a.id}` : `no reason ${a.id}`;
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export function serveMcp(root: string): void {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = req;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (method) {
        case "initialize":
          return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "reasons", version: "0.2.0" } });
        case "notifications/initialized":
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          const p = params as { name: string; arguments?: Record<string, unknown> };
          try { return reply({ content: [{ type: "text", text: call(root, p.name, p.arguments ?? {}) }] }); }
          catch (e) { return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true }); }
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    } catch (e) { fail(-32603, (e as Error).message); }
  });
}
