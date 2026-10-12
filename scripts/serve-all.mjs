#!/usr/bin/env node
/**
 * One container, the whole engine: the entrypoint for the Fly deployment (fly.toml).
 *
 * `npm run stack:up` (scripts/stack.ts) is the supervisor for a developer machine: it
 * detaches its children and tracks them by PID file. A container wants the opposite: one
 * foreground process that owns its children and dies when any of them does, so the
 * platform restarts the machine instead of leaving a half-running engine that answers
 * health checks while its keeper or gateway is gone.
 *
 * ## Secrets arrive as environment variables, the engine reads key FILES
 *
 * Fly secrets are env vars. The engine's settlement code reads keys from files
 * (`MITRA_EVM_SETTLEMENT_KEY_FILE`, `MITRA_RECEIPT_SIGNER_KEY_FILE`,
 * `MITRA_SOLANA_ENGINE_KEY_FILE`). For each `<NAME>` below that is set and whose `_FILE`
 * is not, the value is written to a 0600 file under a private tmp directory and `<NAME>_FILE`
 * points at it. The value is never logged.
 *
 * ## What runs
 *
 *   core-api        next start on $PORT (3005), all interfaces
 *   mcp-gateway     scripts/mcp-server-daemon.ts on 3006; public only with MCP_TOKEN set,
 *                   which the gateway itself enforces (it refuses a non-loopback host without one)
 *   webhook-worker  scripts/webhook-worker.ts
 *   keeper-daemon   scripts/keeper-daemon.ts, ONLY when a settlement key is configured: without
 *                   one it refuses to start by design, and that refusal must not take the API
 *                   down with it. Its absence is logged, not hidden.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };

// A hosted engine without a database keeps its whole ledger in memory and loses it on
// every restart while still answering 200s. Refuse instead. MITRA_ALLOW_MEMORY_STORE=1 is
// for trying this runner on a laptop only.
if (!env.DATABASE_URL && env.MITRA_ALLOW_MEMORY_STORE !== "1") {
  console.error("[serve-all] DATABASE_URL is not set. Refusing to start: an in-memory engine loses everything on restart.");
  process.exit(2);
}
const keyDir = mkdtempSync(join(tmpdir(), "mitra-keys-"));

for (const name of ["MITRA_EVM_SETTLEMENT_KEY", "MITRA_RECEIPT_SIGNER_KEY", "MITRA_SOLANA_ENGINE_KEY"]) {
  if (env[name] && !env[`${name}_FILE`]) {
    const file = join(keyDir, name.toLowerCase());
    writeFileSync(file, env[name].trim(), { mode: 0o600 });
    env[`${name}_FILE`] = file;
    console.log(`[serve-all] ${name}_FILE set from the ${name} secret`);
  }
  delete env[name];
}

const API_PORT = env.PORT ?? "3005";
const MCP_PORT = env.MCP_GATEWAY_PORT ?? "3006";
const bin = (b) => join(process.cwd(), "node_modules", ".bin", b);
// The TypeScript daemons run in Node with tsx loaded in-process (`node --import tsx`), not
// through the tsx CLI, which keeps a wrapper process (~50 MB each) alive beside every daemon.
const ts = (script) => ({ cmd: process.execPath, args: ["--import", "tsx", script] });

const services = [
  { name: "core-api", cmd: bin("next"), args: ["start", "-p", API_PORT, "-H", "0.0.0.0"], env: { PORT: API_PORT } },
  {
    name: "mcp-gateway",
    ...ts("scripts/mcp-server-daemon.ts"),
    env: {
      MITRA_API_URL: `http://127.0.0.1:${API_PORT}`,
      MCP_GATEWAY_PORT: MCP_PORT,
      // Public only with a token; loopback otherwise, so the gateway never binds openly.
      MCP_GATEWAY_HOST: env.MCP_TOKEN ? "0.0.0.0" : "127.0.0.1",
      PORT: MCP_PORT,
    },
  },
];

// The worker needs the database (it delivers from the shared store). Exit 3 means another
// worker holds the lease: one worker per database is the design, so that is not a crash.
if (env.DATABASE_URL) {
  services.push({ name: "webhook-worker", ...ts("scripts/webhook-worker.ts"), env: {}, okExitCodes: [3] });
} else {
  console.log("[serve-all] webhook-worker NOT started: no DATABASE_URL (memory store, laptop only).");
}

if (env.MITRA_EVM_SETTLEMENT_KEY_FILE) {
  services.push({ name: "keeper-daemon", ...ts("scripts/keeper-daemon.ts"), env: {} });
} else {
  console.log("[serve-all] keeper-daemon NOT started: no MITRA_EVM_SETTLEMENT_KEY. Escrow timeouts are not swept.");
}
if (!env.MCP_TOKEN) console.log("[serve-all] mcp-gateway on loopback only: set MCP_TOKEN to serve agents publicly.");

const children = new Map();
let stopping = false;
let exitCode = 0;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  // Each child leads its own process group (detached), so this reaches the grandchildren too:
  // tsx and next both run the real server in a child process that a plain kill would orphan.
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(code), 5000).unref();
}

for (const s of services) {
  const child = spawn(s.cmd, s.args, { env: { ...env, ...s.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.set(s.name, child);
  const prefix = (stream, out) =>
    stream.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line) out.write(`[${s.name}] ${line}\n`);
    });
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    children.delete(s.name);
    if (!stopping && s.okExitCodes?.includes(code)) {
      console.log(`[serve-all] ${s.name} stood down (exit ${code}); that is expected, carrying on`);
      return;
    }
    if (stopping) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    console.error(`[serve-all] ${s.name} exited (code ${code}, signal ${signal}); stopping the machine so it restarts whole`);
    stopAll(1);
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[serve-all] ${sig}: stopping`);
    stopAll(0);
  });
}
