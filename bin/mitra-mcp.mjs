#!/usr/bin/env node
/**
 * `mitra-mcp` — run the MCP server from an installed copy of this repository.
 *
 * ## Why this shim exists
 *
 * `scripts/mitra-mcp.ts` cannot itself be the `bin` target, for two independent reasons that
 * are easy to miss:
 *
 * 1. **It is TypeScript.** A `bin` entry is executed by `node`, which does not strip types.
 * 2. **It imports through the `@/` path alias.** `node` does not resolve those either — only
 *    `tsx` does. So even `node scripts/mitra-mcp.ts` fails with `MODULE_NOT_FOUND`, before
 *    any syntax question is reached.
 *
 * A `bin` pointing directly at the `.ts` would therefore install successfully and then fail on
 * first run, which is the worst shape a command can have.
 *
 * ## stdio is load-bearing
 *
 * MCP over stdio speaks JSON-RPC on fd 0 and fd 1. The child inherits this process's stdio
 * *exactly* — no pipes, no buffering, no re-encoding. Anything that captured and re-emitted
 * stdout would corrupt the protocol stream, so stdio is inherited rather than piped.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const server = join(repoRoot, "scripts", "mitra-mcp.ts");

if (!existsSync(server)) {
  process.stderr.write(`mitra-mcp: cannot find ${server}\n`);
  process.exit(1);
}

const tsx = join(repoRoot, "node_modules", ".bin", "tsx");

const child = spawn(tsx, [server, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

// Forward the signals an MCP host uses to shut a server down, so the child is not orphaned
// when a client disconnects.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", e => {
  process.stderr.write(`mitra-mcp: could not start tsx (${e.message}). Did you run \`npm install\`?\n`);
  process.exit(1);
});