/**
 * Mitra MCP server over stdio (sprint item 4).
 *
 *   MITRA_API_URL=http://localhost:3000 npx tsx scripts/mitra-mcp.ts
 *
 * Every tool is a call to that API (`lib/mcp/server.ts`); this process holds no
 * store and no keys. stdout carries the protocol, so diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMitraMcpServer, httpApi, servedToolNames } from "@/lib/mcp/server";

async function main() {
  const base = process.env.MITRA_API_URL;
  if (!base) {
    console.error("MITRA_API_URL is required (e.g. http://localhost:3000). Refusing to start without an API to govern the tools.");
    process.exit(2);
  }
  const server = createMitraMcpServer(httpApi(base));
  await server.connect(new StdioServerTransport());
  console.error(`mitra mcp: ${servedToolNames().length} tools served over stdio, API ${base}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
