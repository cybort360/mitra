#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContextStore } from "./store.js";
import { DEFAULT_DB, createServer } from "./server.js";
import { SyncAgent } from "./sync.js";

const dbPath = process.env.SHARED_CONTEXT_DB ?? DEFAULT_DB;
const store = new ContextStore({
  path: dbPath,
  // A stable node id keeps one bundle per participant. Left random, every fresh
  // clone would mint a new id and slowly fill the shared folder with bundles
  // from nodes that no longer exist.
  ...(process.env.SHARED_CONTEXT_NODE_ID ? { nodeId: process.env.SHARED_CONTEXT_NODE_ID } : {}),
});

// Auto-sync is opt-in via a shared directory. Without it the server still works
// fully; peers exchange bundles manually via context_export/context_merge.
const syncDir = process.env.SHARED_CONTEXT_SYNC_DIR;
const sync = syncDir
  ? new SyncAgent({
      store,
      dir: syncDir,
      intervalMs: Number(process.env.SHARED_CONTEXT_SYNC_INTERVAL_MS ?? 3000),
    })
  : undefined;

const { server } = createServer(store, sync);
sync?.start();

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the MCP transport, so all diagnostics go to stderr.
const log = (m: string) => process.stderr.write(`[shared-context] ${m}\n`);
log(`ready node=${store.nodeId} db=${dbPath}`);
log(sync ? `auto-sync dir=${syncDir}` : "auto-sync off (set SHARED_CONTEXT_SYNC_DIR to enable)");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Publish one last time so peers are not left waiting for the next tick.
    try { sync?.tick(); } catch { /* best effort on shutdown */ }
    sync?.stop();
    store.close();
    process.exit(0);
  });
}

