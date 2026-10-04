/**
 * Mitra MCP server (sprint item 4; network transport: Phase 5).
 *
 *   MITRA_API_URL=http://localhost:3000 npx tsx scripts/mitra-mcp.ts                       # stdio
 *   MITRA_API_URL=http://localhost:3000 npx tsx scripts/mitra-mcp.ts --transport sse --port 3001
 *
 * `--transport sse` (alias `http`) serves both network wire formats on one port —
 * `GET /sse` + `POST /messages` and Streamable HTTP at `/mcp` (`lib/mcp/http.ts`).
 * It binds 127.0.0.1 unless `--host` says otherwise, and any non-loopback host needs a
 * bearer token: `MITRA_MCP_TOKEN_FILE` (preferred) or `MITRA_MCP_TOKEN`. Browser
 * origins are refused unless listed in `MITRA_MCP_ALLOWED_ORIGINS` (comma-separated).
 *
 * Every tool is a call to the API (`lib/mcp/server.ts`); this process holds no store
 * and no keys. On stdio, stdout carries the protocol, so diagnostics go to stderr.
 */
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMitraMcpServer, httpApi, servedToolNames } from "@/lib/mcp/server";
import { startMcpHttpServer } from "@/lib/mcp/http";

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1];
}

function token(): string | undefined {
  const file = process.env.MITRA_MCP_TOKEN_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return process.env.MITRA_MCP_TOKEN || undefined;
}

async function main() {
  const base = process.env.MITRA_API_URL;
  if (!base) {
    console.error("MITRA_API_URL is required (e.g. http://localhost:3000). Refusing to start without an API to govern the tools.");
    process.exit(2);
  }
  const transport = flag("transport") ?? "stdio";
  if (transport === "stdio") {
    const server = createMitraMcpServer(httpApi(base));
    await server.connect(new StdioServerTransport());
    console.error(`mitra mcp: ${servedToolNames().length} tools served over stdio, API ${base}`);
    return;
  }
  if (transport !== "sse" && transport !== "http") {
    console.error(`unknown --transport ${transport}: use stdio or sse`);
    process.exit(2);
  }
  const port = Number(flag("port") ?? "3001");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port ${flag("port")}`);
    process.exit(2);
  }
  const http = await startMcpHttpServer({
    api: httpApi(base), port, host: flag("host"), token: token(),
    allowedOrigins: (process.env.MITRA_MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  console.error(`mitra mcp: ${servedToolNames().length} tools at ${http.url}/sse and ${http.url}/mcp, API ${base}`);
  const stop = () => { void http.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
