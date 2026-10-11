/**
 * The MCP surface, as an importable entry point.
 *
 * `./mcp` in `package.json` points here, so this file had to exist before the export could —
 * an `exports` entry pointing at a missing module installs cleanly and fails on first import,
 * which is a considerably worse failure than a build error.
 *
 * Deliberately a narrow surface: the server, its HTTP transport, and the tool declaration.
 * Not exported are the internals — `createMitraMcpServer`'s per-tool wiring, the session
 * bookkeeping, or anything that would let a caller widen what the gateway serves. The served
 * tool list stays a property of `server.ts`, so an import from outside cannot change what an
 * agent is offered.
 */
export { createMitraMcpServer, httpApi, servedToolNames, type MitraApi } from "./server";
export { startMcpHttpServer, isLoopbackHost, type McpHttpOptions, type McpHttpServer } from "./http";
export { mcpTools, prohibitedDirectTools, A2A_TRANSITIONS, type McpToolName } from "./surface";