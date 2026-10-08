# Mitra Co-Developer Handoff Specification
## Sprint Wave 3: Developer SDK (@mitra/sdk), Agent Inbox, Sandbox Simulation, & Cognitive Skills

**Date:** 2026-10-08  
**Active Branch:** `feat/mitra-vault-v2-reseed` (Pushed & In-Sync with `origin`)  
**Shared Context Tip:** Seq 118+  
**Next Free Defect Identifier:** `F78`  

---

### Executive State & Convergence

All prior collaborative packages (PP-1 through PP-4 and LP-1 through LP-5) are **completed, merged, and verified on-chain**:
- **PP-1 (MCP Surface)**: All 19 tools served over stdio and Streamable HTTP (`/mcp`), verified in `tests/external-agent-e2e.test.ts`.
- **PP-2 (Virtuals Adapter)**: `lib/adapters/virtuals.ts` verified with 60/60 tests against real ACP schemas.
- **PP-3 (Webhooks Outbox)**: `lib/webhooks/` and `scripts/webhook-worker.ts` with HMAC-SHA256 and SSRF defense (80/80 tests).
- **PP-4 (Circuit Breakers)**: `POST /api/v1/admin/pause` and emergency pause halting value movements while preserving reads and recovery.
- **LP-1 & LP-2 (Decoupled Escrow)**: `MitraJobEscrow.sol` deployed on Base Sepolia (`0xc49c93f0...`) and Tempo Moderato (`0x95ca2170...`).
- **LP-3 (Tempo Parity)**: Settlement parity caller suite live on Tempo Moderato (tx `0x80cccf78...`, block `38398243`).
- **LP-4 (Solana Job Escrow)**: Upgraded program `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` on devnet with autonomous stranger timeout refunds.
- **LP-5 (Arcium MPC Cluster)**: 13/13 policy evaluations live on Arcium localnet MPC cluster closing FR-VAULT-008.
- **F65 / F68 / F70 / F76 Resolved**: Intent first-write-wins idempotency, polymorphic `externalJobRefs`, held lamport reservation invariant, and pre-committed refund route derivation all landed.
- **Baselines**: `tsc` clean (0 errors), `forge test` (57/57 pass), `cargo test` (147/147 pass), `vitest` (1,125+ pass).

---

### 1. Ground Rules & Invariants (Non-Negotiable)

1. **Repository files are the source of truth** (`AGENTS.md`). Prior chat summaries are non-authoritative.
2. **The Mechanism to Protect:**
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   **An `ALLOW` decision is never permission to move value.** The execution guard or on-chain contract independently re-derives whether *this exact instruction* may move capital.
3. **Intent-Only Verbs**:
   The SDK, Sandbox, and Skills must only expose commercial intent verbs (`createAgreement`, `fund`, `submitDeliverable`). Never expose raw capital-moving verbs (`raw_arbitrary_transfer`, `raw_key_access`, `raw_policy_mutation`).
4. **Pre-Committed Recovery (PRD §15.5)**:
   Never invent compensation calldata post-failure. Every saga compensation route must be committed at agreement funding time.
5. **Zero-Mock Policy in Production**:
   Production routes must never mock success. The Sandbox announces itself explicitly as a simulation harness and never claims real on-chain settlement occurred.

---

### 2. File Ownership Boundaries (Zero Collision Guarantee)

| Area | Lead Ownership (Do NOT touch) | Purple Ownership (Active Queue) |
|---|---|---|
| **Smart Contracts & Programs** | `contracts/`, `programs/mitra-vault/`, `programs/arcium-policy-circuit/` | *None* |
| **Storage & Data** | `lib/store/`, `lib/kernel/` | `lib/sdk/` (or `packages/sdk/`), `app/api/v1/inbox/` |
| **MCP & Ecosystem** | *None* | `lib/mcp/surface.ts`, `lib/mcp/server.ts` (additive `mitra_get_inbox`) |
| **Tooling, Sandbox & Skills** | `scripts/vault-devnet.mjs`, `scripts/escrow-devnet.mjs` | `scripts/sandbox.ts`, `skills/`, `tests/sdk.test.ts`, `tests/inbox.test.ts`, `tests/sandbox.test.ts` |

---

### 3. PurpleDNA Active Queue (Sprint Wave 3: Work Packages PP-5 to PP-8)

#### 📦 Package PP-5: Mitra Core Client & Developer SDK (`@mitra/sdk` / `lib/sdk/`)
- **Context**: PRD §20 ("Developer SDK"). Eliminates manual EIP-712 typing, domain separators, and raw headers for callers.
- **Deliverables**:
  1. **Core Client (`lib/sdk/client.ts` & `lib/sdk/index.ts`)**:
     - Class `MitraClient`: takes `{ baseUrl, signer, chainId }`.
     - Automatically constructs and signs EIP-712 `MitraRequest` typed data via `lib/identity/signed-request.ts`.
     - Exposes PRD §20 namespaces:
       - `mitra.commerce`: `createAgreement()`, `fund()`, `startExecution()`, `submitDeliverable()`, `acceptDeliverable()`, `rejectDeliverable()`.
       - `mitra.authority`: `getMandate()`, `getHeadroom()`, `requestAuthorization()`.
       - `mitra.agents`: `register()`, `getAgent()`, `findAgents()`.
       - `mitra.clearing`: `getEpoch()`, `requestClearing()`, `listResiduals()`.
       - `mitra.recovery`: `getSaga()`, `refundEscrow()`.
  2. **Tests (`tests/sdk.test.ts`)**:
     - Verify typed client calls against real in-memory route handlers.
     - Verify automated EIP-712 signing matches server verification with 0 boilerplate.

---

#### 📦 Package PP-6: Mitra Agent Inbox API & MCP Tool (Phase 4/5)
- **Context**: In agentic commerce, agents need an actionable work queue addressable to their identity (`agentId` / wallet) rather than polling raw tables.
- **Deliverables**:
  1. **REST Route (`app/api/v1/inbox/route.ts` and `app/api/v1/inbox/[agentId]/route.ts`)**:
     - Aggregates actionable commercial items for an agent:
       - `WORK_REQUIRED`: Agreements where `provider === agentId` and status is `EXECUTING` (deadline timer running).
       - `EVALUATION_REQUIRED`: Agreements where `evaluator === agentId` and status is `SUBMITTED`.
       - `INBOUND_PROPOSAL`: Agreements where `provider === agentId` and status is `OPEN`.
       - `SETTLEMENT_RECEIPT`: Recent finalized receipts / residual settlements credited to the agent.
  2. **MCP Tool (`mitra_get_inbox`)**:
     - Add `mitra_get_inbox` to `lib/mcp/surface.ts` and `lib/mcp/server.ts`.
  3. **SDK Method**: Wire `mitra.inbox.list()` on `MitraClient`.
  4. **Tests (`tests/inbox.test.ts`)**:
     - Verify aggregation, priority sorting, filtering by state, and empty inbox states.

---

#### 📦 Package PP-7: Mitra Sandbox CLI & Simulation Engine (Phase 5/10)
- **Context**: PRD §28 ("Reference Agent Network and Simulation"). Developers need instant local feedback without burning testnet faucets or waiting hours for timelocked saga timeouts.
- **Deliverables**:
  1. **Sandbox Engine (`scripts/sandbox.ts` / `lib/sandbox/`)**:
     - Runnable via `npm run sandbox` (or `npx tsx scripts/sandbox.ts`).
     - Pre-seeds in-memory funded spaces (100,000 Sandbox USDC, 100,000 PathUSD, 500 SOL) and pre-authorized mandates.
     - **Time-Travel Clock Engine**: Ability to fast-forward simulated block timestamps programmatically (e.g. `sandbox.clock.advanceSeconds(7200)`) to test 2-hour timeout refunds in 5 milliseconds.
     - **Synthetic Counterparties**:
       - `MockDataProvider`: Auto-generates structured artifacts upon agreement entering `EXECUTING`.
       - `MockEvaluator`: Auto-evaluates deliverables against criteria.
       - `MockAdversary`: Deliberately fails deliverables or triggers timeouts to verify developer's TALOS saga compensation.
  2. **Tests (`tests/sandbox.test.ts`)**:
     - Verify instant execution, time-travel timeout recovery, and mock counterparty responses.

---

#### 📦 Package PP-8: Agent Skill Packages (`SKILL.md`)
- **Context**: LLM agents in Claude Desktop, Cursor, Antigravity, and ElizaOS need cognitive decision trees and economic rules to use Mitra safely.
- **Deliverables**:
  1. **Cognitive Skill Instruction Bundles**:
     - `skills/mitra-buyer/SKILL.md`: For procurement agents (inspect headroom $\rightarrow$ solicit quotes $\rightarrow$ lock escrow $\rightarrow$ review deliverable).
     - `skills/mitra-provider/SKILL.md`: For worker agents (monitor inbox $\rightarrow$ verify escrow locked $\rightarrow$ execute work $\rightarrow$ submit deliverable hash).
     - `skills/mitra-evaluator/SKILL.md`: For judge/oracle agents (benchmark artifacts against acceptance criteria $\rightarrow$ accept to release escrow or reject to trigger saga refund).
     - `skills/mitra-treasury/SKILL.md`: For operations agents (monitor burn rate, amend mandates, surface 1-click approvals).

---

### 4. Verification Protocol Before Opening a PR

Before submitting work:
1. `npm run typecheck` $\rightarrow$ 0 errors.
2. `forge test` $\rightarrow$ 57/57 passing.
3. `cargo test --manifest-path programs/mitra-vault/Cargo.toml` $\rightarrow$ 147/147 passing.
4. `npx vitest run` $\rightarrow$ all existing suites (1,125+) pass without regression.
5. Document any new findings in `forge/FAILURES.md` (next free identifier is `F78`).
6. Append handoff entry to Shared Context MCP and commit bundle.
