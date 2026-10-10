# Handoff Specification: Complete Loop Deployment & Daemon Orchestration

**Date:** 2026-10-10  
**Author:** Lead Agent / Antigravity  
**Target:** Coding Agent (Implementation & Verification)  
**Repository Branch:** `feat/mitra-vault-v2-reseed`  
**Applicable Standards:** [`AGENTS.md`](./AGENTS.md), [`BUILD_FOUNDRY.md`](./forge/standards/BUILD_FOUNDRY.md), [`INVARIANTS.md`](./forge/INVARIANTS.md)

---

## 1. Executive Summary & Objective

The core contracts, kernel, SDK, and APIs are verified. To run a **complete, living, unattended loop**, we must transition from ephemeral test executions to **standing background services and automated runners**.

This packet delivers:
1. **Task 1: Standing Autonomous Keeper Daemon (`scripts/keeper-daemon.ts`)** — Continuously monitors on-chain escrows, executes deadline `refundJob` sweeps, and drives auto-reconciliation.
2. **Task 2: Streamable HTTP MCP Server Runner (`scripts/mcp-server-daemon.ts`)** — Dedicated network listener exposing the 21 MCP tools over Streamable HTTP (`/mcp`) and SSE.
3. **Task 3: Unified Stack Supervisor (`scripts/stack.ts`, `npm run stack:up|down|status`)** — Production process manager orchestrating Core API, MCP Gateway, Webhook Worker, and Keeper Daemon with PID tracking and health checks.
4. **Task 4: Continuous Autonomous Agent Runner (`scripts/run-autonomous-agents.ts`, `npm run agents:run`)** — Runs Buyer, Provider, and Evaluator agents operating continuously over the live MCP/SDK sockets.

---

## 2. Task 1: Standing Autonomous Keeper Daemon (`scripts/keeper-daemon.ts`)

### 2.1 Problem & Requirements
* PRD §28.5 requires an autonomous Keeper to sweep expired escrows without relying on human interaction or party cooperation.
* F97 implemented read-path reconciliation so Mitra notices when an escrow is refunded on-chain. What is missing is a **standing daemon** that proactively executes on-chain refunds when deadlines expire.

### 2.2 Prescribed Implementation (`scripts/keeper-daemon.ts`)
Create `scripts/keeper-daemon.ts`:
```typescript
/**
 * Autonomous Keeper Daemon (PRD §28.5, F97).
 *
 * Scans active agreements with on-chain escrows. When block.timestamp >= timeout
 * and the escrow is still Funded, calls refundJob on the contract, restoring
 * capital to the client and triggering state reconciliation.
 *
 * Usage:
 *   npx tsx scripts/keeper-daemon.ts          # continuous loop (KEEPER_POLL_MS, default 5000)
 *   npx tsx scripts/keeper-daemon.ts --once   # single sweep, then exit
 */
import { getStore } from "@/lib/store/provider";
import { reconcileAgreementEscrow } from "@/lib/commerce/escrow-reconcile";
import { executeEscrowRefund } from "@/lib/commerce/onchain-escrow";
import { recordEvent } from "@/lib/store/events";

const POLL_MS = Math.max(1000, Number(process.env.KEEPER_POLL_MS ?? 5000) || 5000);
const ONCE = process.argv.includes("--once");

export async function sweepExpiredEscrows(): Promise<{ checked: number; refunded: number }> {
  const { repo } = await getStore();
  const agreements = await repo.listAgreements?.() ?? [];
  const nowMs = Date.now();
  let refundedCount = 0;

  for (const agreement of agreements) {
    if (agreement.status !== "EXECUTING" && agreement.status !== "FUNDED") continue;
    if (!agreement.escrowChain || !agreement.escrowContract || !agreement.escrowTimeout) continue;

    // Check if timeout has expired
    const timeoutMs = Number(agreement.escrowTimeout) * 1000;
    if (nowMs < timeoutMs) continue;

    try {
      // Reconcile and refund if needed
      const reconciled = await reconcileAgreementEscrow(repo, agreement);
      if (reconciled.agreement.status === "REFUNDED") {
        refundedCount++;
        console.log(`[keeper] Reconciled expired escrow for ${agreement.agreementId} -> REFUNDED`);
      }
    } catch (e) {
      console.error(`[keeper] Failed to refund ${agreement.agreementId}:`, e);
    }
  }

  return { checked: agreements.length, refunded: refundedCount };
}

async function main() {
  console.log(`[keeper] Autonomous Keeper Daemon started (interval: ${POLL_MS}ms)`);
  do {
    const stats = await sweepExpiredEscrows();
    if (stats.refunded > 0) {
      console.log(`[keeper] Sweep complete: ${stats.refunded} escrows refunded.`);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  } while (true);
}

if (process.argv[1]?.endsWith("keeper-daemon.ts")) {
  main().catch(console.error);
}
```

---

## 3. Task 2: Streamable HTTP MCP Server Runner (`scripts/mcp-server-daemon.ts`)

### 3.1 Requirements
* Expose the 21 MCP tools over HTTP on a dedicated port (`PORT=3006`), utilizing `lib/mcp/http.ts` (`startMcpHttpServer`).
* Connect directly to the Mitra Core API running on `http://127.0.0.1:3005`.

### 3.2 Prescribed Implementation (`scripts/mcp-server-daemon.ts`)
Create `scripts/mcp-server-daemon.ts`:
```typescript
/**
 * Streamable HTTP & SSE MCP Gateway Daemon (PRD Phase 5).
 *
 * Serves all 21 Mitra MCP tools over Streamable HTTP (/mcp) and Legacy SSE (/sse)
 * bound to loopback for external agents.
 */
import { startMcpHttpServer } from "@/lib/mcp/http";
import { httpApi } from "@/lib/mcp/server";

const API_URL = process.env.MITRA_API_URL ?? "http://127.0.0.1:3005";
const PORT = Number(process.env.MCP_PORT ?? 3006);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

async function main() {
  const api = httpApi(API_URL);
  const server = await startMcpHttpServer({
    api,
    port: PORT,
    host: HOST,
  });

  console.log(`[mcp-daemon] Mitra MCP Gateway listening on http://${HOST}:${PORT}`);
  console.log(`[mcp-daemon] Streamable HTTP: http://${HOST}:${PORT}/mcp`);
  console.log(`[mcp-daemon] Legacy SSE:      http://${HOST}:${PORT}/sse`);
  console.log(`[mcp-daemon] Connected API:   ${API_URL}`);
}

main().catch(console.error);
```

---

## 4. Task 3: Unified Stack Supervisor (`scripts/stack.ts`)

### 4.1 Requirements
* Must manage all 4 services with PID tracking in `.stack/pids.json`:
  1. **Core API Server:** Next.js on port `3005` with `DATABASE_URL` set.
  2. **MCP Gateway:** `scripts/mcp-server-daemon.ts` on port `3006`.
  3. **Webhook Worker:** `scripts/webhook-worker.ts`.
  4. **Keeper Daemon:** `scripts/keeper-daemon.ts`.
* Must provide 3 commands:
  * `npm run stack:up` — Boots all 4 daemons, verifies `/api/v1/health` on port 3005, reports readiness.
  * `npm run stack:status` — Checks process liveness and port responsiveness.
  * `npm run stack:down` — Sends `SIGTERM` to all managed PIDs and cleans up `.stack/`.

### 4.2 Prescribed Implementation (`scripts/stack.ts`)
Create `scripts/stack.ts`:
* Uses `node:child_process.spawn` with `detached: true` and `stdio: "ignore"`.
* Writes `.stack/pids.json` containing `{ api: pid, mcp: pid, webhook: pid, keeper: pid }`.
* Implements health-check polling with timeout before declaring `stack:up` success.

Add scripts to `package.json`:
```json
"stack:up": "tsx scripts/stack.ts up",
"stack:down": "tsx scripts/stack.ts down",
"stack:status": "tsx scripts/stack.ts status"
```

---

## 5. Task 4: Continuous Autonomous Agent Runner (`scripts/run-autonomous-agents.ts`)

### 5.1 Requirements
* Demonstrates live continuous agent operation across roles.
* Instantiates 3 distinct agents with individual wallets:
  1. **Buyer Agent (`agent_buyer_live`)**
  2. **Provider Agent (`agent_provider_live`)**
  3. **Evaluator Agent (`agent_evaluator_live`)**
* Connects through `@mitra/sdk` pointed at `http://127.0.0.1:3005`.
* Runs in a non-terminating loop:
  * Every cycle, Buyer opens a task.
  * Provider polls inbox, starts execution, and submits deliverable.
  * Evaluator polls inbox, verifies criteria, and accepts or rejects.
  * Emits live events streamable to `http://localhost:3005/overview`.

Add script to `package.json`:
```json
"agents:run": "tsx scripts/run-autonomous-agents.ts"
```

---

## 6. Execution Order & Verification Protocol

- [ ] **Step 1:** Implement `scripts/keeper-daemon.ts` and verify with `--once`.
- [ ] **Step 2:** Implement `scripts/mcp-server-daemon.ts`.
- [ ] **Step 3:** Implement `scripts/stack.ts` with `up`, `down`, and `status`.
- [ ] **Step 4:** Implement `scripts/run-autonomous-agents.ts`.
- [ ] **Step 5:** Add npm scripts to `package.json`.
- [ ] **Step 6:** Verification Commands:
  ```bash
  npm run typecheck
  forge test
  cargo test --manifest-path programs/mitra-vault/Cargo.toml
  npx vitest run
  npm run stack:up
  npm run stack:status
  npm run stack:down
  ```
