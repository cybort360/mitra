# Mitra Co-Developer Handoff Specification
## Phase 5 (Agent Ecosystem & Dual-Transport MCP) & Phase 7 (On-Chain Clearing)

---

### Scope & Division of Labor

> [!NOTE]
> **Baseline Status:**
> - Multi-rail EVM Canonical Vault v2 (`[principal][holder]` + `actionHash` permit, ADR-0009 invariants preserved) deployed and verified on **Base Sepolia** (`84532`, `0x9c2c2d42a1a282b665bc67f407017b7605e51e8f`) and **Tempo Moderato** (`42431`, `0xaa46c23adefed6687cb2180d8a14cf88c6688ee6`).
> - `PERMIT_TYPEHASH` verified on-chain via `eth_call 0x30adf81f`: `0xcae3f4fbf2f6d96ea9b2c34236eaafd63d622d4a5e7c33f861c116f33cff1a88`.
> - Phase 6 Distributed Sagas (`ADR-0012`) re-evidenced on-chain with automated compensation (`lockEscrow` → `refundEscrow`). Runnable via `npm run verify:saga-events`. Full un-truncated 66-character hashes verified live (`F52`).
> - All 5 Verification Gates: **PASS** (Gate 1 Typecheck: 0 errors; Gate 2 Vitest: 737 passed, 0 failed; Gate 3 Foundry: 30/30 passed; Gate 4 Sagas: 100% verified; Gate 5 Shared Context: 76 entries audited, `ok=true`, tip `d4ddcbb1fa62f26a004095ee61f0c0962425b2757076f1b4d703fabf8b3be8af`).
> - Active branch: `feat/mitra-vault-v2-reseed` (tip `e9b710f`).

This handoff specifies the implementation and live verification of **Phase 5** and **Phase 7** per `docs/product/MITRA_PRD.md` (§14, §19–§25, §52):

1. **Phase 5: Agent Ecosystem & Dual-Transport MCP Server** (`bin/mitra-mcp.ts`, `lib/mcp/server.ts`)
2. **Phase 7: On-Chain Clearing & Multilateral Netting** (`contracts/MitraClearing.sol`, `scripts/run-live-clearing-epoch.mjs`)

---

## 1. Ground Rules & Invariants (Non-Negotiable)

1. **Repository files are the source of truth** (`AGENTS.md`). Prior chat summaries are not authoritative.
2. **The Mechanism to Protect:**
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   **An `ALLOW` decision is never permission to move value.** The execution guard or on-chain contract independently re-derives whether *this exact instruction* may move capital.
3. **No Direct Capital Verbs in MCP Surface:**
   External agents must never hold raw transfer or key verbs (`lib/mcp/surface.ts`). All exposed MCP tools must be verbs on commercial intent.
4. **Evidence Discipline (BUILD_FOUNDRY §2):**
   Every claim requires `evidence` and `blocker`. Never truncate transaction hashes in logs or evidence ledgers (`F52`).

---

## 2. Work Package 1: Phase 5 — Dual-Transport MCP Server

### 2.1 Objective
External agents (Cursor, Claude Desktop, LangChain, AutoGPT) must be able to participate in Mitra-governed commerce without holding keys or direct capital access (PRD §22, §24, §52 Phase 5).

### 2.2 Dual-Transport Architecture
Implement a single core MCP server class with switchable transports:
- **`stdio` Transport (Default)**: Direct pipe for local tools and IDE extensions (e.g. Cursor, Claude Desktop).
- **`SSE / HTTP` Transport**: Server-Sent Events over HTTP (configurable `--port`) for remote/cloud agents.

```text
                    ┌────────────────────────────┐
                    │      MitraMcpServer        │
                    │ (Core 17 Intent-Only Tools)│
                    └─────────────┬──────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
       ┌─────────────────────┐         ┌─────────────────────┐
       │   StdioTransport    │         │    SseTransport     │
       │ (Cursor, Claude CLI)│         │(Remote Agents / K8s)│
       └─────────────────────┘         └─────────────────────┘
```

### 2.3 Implementation Details
1. **Core Server (`lib/mcp/server.ts` or `bin/mitra-mcp.ts`)**:
   - Initialize `@modelcontextprotocol/sdk` (Server, StdioServerTransport, SSEServerTransport).
   - Enforce `assertNoCapitalVerb(mcpTools)` at server startup.
   - Register all 17 tools from [`lib/mcp/surface.ts`](../lib/mcp/surface.ts):
     `mitra_register_agent`, `mitra_get_agent`, `mitra_find_agents`, `mitra_create_intent`, `mitra_get_intent`, `mitra_request_authorization`, `mitra_create_agreement`, `mitra_fund_agreement`, `mitra_submit_deliverable`, `mitra_accept_deliverable`, `mitra_reject_deliverable`, `mitra_get_obligations`, `mitra_get_exposure`, `mitra_get_recovery`, `mitra_request_clearing`, `mitra_get_settlement`, `mitra_get_receipt`, `mitra_get_timeline`.
2. **Dispatch Wiring**:
   Connect tool calls to `getStore()` (`lib/store/provider.ts`) and kernel functions (`evaluateProposal`, `applyAgreementOpWithSaga`).
3. **CLI Options**:
   - `npx tsx bin/mitra-mcp.ts --transport stdio`
   - `npx tsx bin/mitra-mcp.ts --transport sse --port 3001`
4. **Integration Test (`tests/mcp-server.test.ts`)**:
   Verify tool enumeration, prohibition enforcement, and intent creation across both stdio and SSE modes.

---

## 3. Work Package 2: Phase 7 — On-Chain Clearing (`MitraClearing.sol`)

### 3.1 Objective
Move clearing from purely local graph reduction to on-chain verifiable epoch commitments and settled residual transfers (PRD §14, §19, §20, §21, §52 Phase 7).

### 3.2 Why Option B (Dedicated On-Chain Contract) is Mandated
1. **Non-Repudiation (PRD §14.8):** `inputsRoot` and `resultHash` are anchored on-chain with immutable block timestamps, preventing the clearing engine from behaving as an opaque private database.
2. **Challenge Window Enforcement (PRD §14.5):** Contract enforces `block.timestamp >= challengeExpiresAt` before finalization.
3. **Single-Epoch Guarantee (F47):** Smart contract enforces that an `epochId` cannot be finalized or settled twice.
4. **Decoupled Settlement (PRD §4.6):** `MitraClearing` manages epoch states; `BaseSettlementAdapter` and `TempoSettlementAdapter` execute residual transfers.

### 3.3 Implementation Details
1. **Solidity Contract (`contracts/MitraClearing.sol`)**:
   ```solidity
   // SPDX-License-Identifier: MIT
   pragma solidity ^0.8.24;

   contract MitraClearing {
       enum EpochStatus { UNKNOWN, OPEN, CHALLENGE, FINALIZED, SETTLED }

       struct EpochRecord {
           bytes32 inputsRoot;
           bytes32 resultHash;
           uint64 challengeExpiresAt;
           EpochStatus status;
           bytes32 settlementReceiptHash;
       }

       mapping(bytes32 => EpochRecord) public epochs;

       event EpochCommitted(bytes32 indexed epochId, bytes32 inputsRoot, bytes32 resultHash, uint64 challengeExpiresAt);
       event EpochFinalized(bytes32 indexed epochId, bytes32 resultHash);
       event EpochSettled(bytes32 indexed epochId, bytes32 settlementReceiptHash);

       function commitEpoch(bytes32 epochId, bytes32 inputsRoot, bytes32 resultHash, uint64 challengeDuration) external {
           require(epochs[epochId].status == EpochStatus.UNKNOWN, "EPOCH_EXISTS");
           epochs[epochId] = EpochRecord({
               inputsRoot: inputsRoot,
               resultHash: resultHash,
               challengeExpiresAt: uint64(block.timestamp + challengeDuration),
               status: EpochStatus.CHALLENGE,
               settlementReceiptHash: bytes32(0)
           });
           emit EpochCommitted(epochId, inputsRoot, resultHash, uint64(block.timestamp + challengeDuration));
       }

       function finalizeEpoch(bytes32 epochId) external {
           EpochRecord storage e = epochs[epochId];
           require(e.status == EpochStatus.CHALLENGE, "INVALID_STATUS");
           require(block.timestamp >= e.challengeExpiresAt, "CHALLENGE_WINDOW_OPEN");
           e.status = EpochStatus.FINALIZED;
           emit EpochFinalized(epochId, e.resultHash);
       }

       function recordSettlement(bytes32 epochId, bytes32 receiptHash) external {
           EpochRecord storage e = epochs[epochId];
           require(e.status == EpochStatus.FINALIZED, "NOT_FINALIZED");
           e.status = EpochStatus.SETTLED;
           e.settlementReceiptHash = receiptHash;
           emit EpochSettled(epochId, receiptHash);
       }
   }
   ```
2. **Deploy to Testnets**:
   Deploy `MitraClearing.sol` to Base Sepolia (`84532`) and Tempo Moderato (`42431`) using `.dev-keys/evm-testnet.json`.
3. **Live Harness (`scripts/run-live-clearing-epoch.mjs`)**:
   - Construct a 3-party netting cycle (Alice, Bob, Carol).
   - Execute deterministic netting via `lib/kernel/clearing.ts` (`netObligations`).
   - Call `commitEpoch` on-chain.
   - Finalize after challenge window.
   - Settle residual obligations via `BaseSettlementAdapter` / `TempoSettlementAdapter`.
   - Call `recordSettlement` and print full 66-character tx hashes.

---

## 4. Working Agreement & Commands for Purple

```bash
# 1. Pull latest tip on active branch
git pull origin feat/mitra-vault-v2-reseed

# 2. Sync shared context & verify hash chain
node shared-context-mcp/dist/cli.js sync
node shared-context-mcp/dist/cli.js audit
node shared-context-mcp/dist/cli.js digest

# 3. Verify baseline before changes
npm run typecheck
npm test
forge test

# 4. Announce starting work package
node shared-context-mcp/dist/cli.js say \
  --author "agent:claude-purple" \
  --kind task \
  --title "Starting Phase 5 Dual-Transport MCP Server" \
  --scope "ecosystem"

# 5. Push progress and sync
git add -A && git commit -m "..." && git push origin feat/mitra-vault-v2-reseed
node shared-context-mcp/dist/cli.js sync
```
