# Mitra Co-Developer Handoff Specification
## Sprint: Phase 4 (Decoupled Commerce), Phase 5 (Agent Ecosystem), Phase 6 (Recovery Parity), & Phase 10 (Production Tooling)

**Date:** 2026-10-06  
**Active Branch:** `feat/mitra-vault-v2-reseed`  
**Shared Context Tip:** Seq 101+  

---

### Executive State & Convergence

All prior collaborative packages and PR #32 are **merged and verified**:
- **F55 Caller Identity**: EIP-712 signed transitions, actor role verification, and un-withholding of all 4 MCP tools (`fund_agreement`, `accept_deliverable`, `reject_deliverable`, `register_agent`) verified in memory and Postgres.
- **F63 Vault Redeploy**: Canonical `MitraVault.sol` v2 live on Base Sepolia (`0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489`) and Tempo Moderato (`0x85409dfc30fa0671b06f98cc56c5b04eb921b568`) with verified F61 token-scoped runtime code (`[principal][holder][token]`).
- **F64 Clearing Redeploy**: Canonical `MitraClearing.sol` live on Base Sepolia (`0xaacba512ba6dc726cb6cafdc2799198dbddb1c4c`) and Tempo Moderato (`0xd03d91c3ae594c6b1163d89a5cee622c3c1f8688`) with PRD §14.4 challenge lifecycle and rolling `inputsRoot`.
- **Phase 7 Clearing Live**: 3-party netting cycle executed on-chain, finalized, and residuals settled through execution guard and `MitraVault`. Recorded `LIVE_DEMONSTRATED`.
- **Verification Gates**: Typecheck clean (0 errors); Vitest 891 pass, 0 fail; Forge 50/50 pass; Saga event audit 100% pass; Shared context audited `ok: true`.

---

### 1. Ground Rules & Invariants (Non-Negotiable)

1. **Repository files are the source of truth** (`AGENTS.md`). Prior chat summaries are not authoritative.
2. **The Mechanism to Protect:**
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   **An `ALLOW` decision is never permission to move value.** The execution guard or on-chain contract independently re-derives whether *this exact instruction* may move capital.
3. **Decoupled Escrow Architecture (ADR-0012)**:
   Avoid creating God Contracts. The Vault is a pure capital boundary (`deposit`, `withdraw`, `spendAuthorized`). Commercial job logic, milestones, and evaluations belong in decoupled escrow contracts (`MitraJobEscrow` / ERC-8183) or external protocols.
4. **Pre-Committed Recovery (PRD §15.5)**:
   Never invent compensation calldata post-failure. Every saga compensation route must be committed at agreement funding time.
5. **Strict Evidence Discipline (BUILD_FOUNDRY §2)**:
   Every claim requires `evidence` and `blocker`. Never truncate transaction hashes in logs or evidence ledgers (`F52`).

---

### 2. File Ownership Boundaries (Zero Collision Guarantee)

To enable seamless parallel development:

| Area | Lead Ownership (Do NOT touch) | Purple Ownership (Active Queue) |
|---|---|---|
| **Smart Contracts** | `contracts/src/ERC8183/`, `programs/mitra-vault/` | *None* |
| **Storage & Data** | `lib/store/repository.ts`, `lib/store/postgres.ts`, `app/api/v1/intents/` | `lib/webhooks/`, `app/api/v1/webhooks/`, `app/api/v1/admin/` |
| **MCP & Ecosystem** | *None* | `lib/mcp/server.ts`, `lib/adapters/virtuals.ts`, `tests/external-agent-e2e.test.ts` |
| **Tooling & Tests** | `tests/commerce-lifecycle.test.ts`, `tests/arcium-circuit.test.ts` | `tests/webhooks.test.ts`, `tests/external-agent-e2e.test.ts` |

---

### 3. Purple Active Queue (Work Packages PP-1 to PP-4)

#### 📦 Package PP-1: MCP Intent Tools & Live External Agent E2E (Phase 5)
- **Context**: The Lead is implementing the `Intent` persistence substrate (`LP-2`) in `EconomicRepository` and `POST /api/v1/intents`.
- **Deliverables**:
  1. **MCP Intent Tools**: Wire `mitra_create_intent` and `mitra_get_intent` in `lib/mcp/server.ts` to `getStore().createIntent()` and `getStore().getIntent()`, so all 17 MCP tools from `lib/mcp/surface.ts` are 100% backed.
  2. **External Agent E2E Harness (`tests/external-agent-e2e.test.ts`)**:
     - Connect an external client via `@modelcontextprotocol/sdk` (Stdio and Streamable HTTP `/mcp`).
     - Walk the external agent lifecycle:
       1. Agent connects without private keys or capital access.
       2. Registers its identity via `mitra_register_agent` with an EIP-712 wallet proof.
       3. Creates commercial intent (`mitra_create_intent`).
       4. Binds agreement (`mitra_create_agreement`).
       5. Client signs transitions using `lib/identity/signed-request.ts`.
       6. Submits and accepts deliverable through served MCP tools.
  3. **Verification**: Assert 0 un-backed tools remain. Verify mutation coverage against unauthorized transitions.

#### 📦 Package PP-2: Virtuals Protocol Marketplace Adapter (Phase 5)
- **Context**: PRD §23 and §52 Phase 5 require one deep marketplace adapter for external agent discovery (Virtuals preferred).
- **Deliverables**:
  1. **Adapter (`lib/adapters/virtuals.ts`)**:
     - Map Virtuals Agent / ACP (Agent Communication Protocol) gig proposals to Mitra `Intent` and `AgreementDraft`.
     - Implement quote verification, service metadata mapping, and counterparty attestation.
  2. **Tests (`tests/virtuals-adapter.test.ts`)**:
     - Verify two-way conversion: Virtuals gig $\leftrightarrow$ Mitra Agreement.
     - Validate rejection of malformed pricing, unmapped tokens, and missing agent identifiers.

#### 📦 Package PP-3: Outbound Webhook Delivery Infrastructure (Phase 10)
- **Context**: PRD §18 / §52 Phase 10 requires pilot organizations to receive asynchronous event notifications without polling protocol logs.
- **Deliverables**:
  1. **Webhook Engine (`lib/webhooks/dispatcher.ts`)**:
     - HMAC-SHA256 request signing (`X-Mitra-Signature` = `sha256(secret, timestamp + "." + payload)`).
     - Timestamp replay protection (`X-Mitra-Timestamp`, max 300s clock skew).
     - Exponential backoff retry loop (e.g. 1s, 5s, 30s) with max 3 attempts.
     - In-memory / persistent dead-letter queue for failed deliveries.
  2. **REST Endpoints**:
     - `POST /api/v1/webhooks`: Register webhook URL, subscription events (`agreement.*`, `clearing.*`, `saga.*`), and secret.
     - `GET /api/v1/webhooks`: List active subscriptions and delivery health.
  3. **Tests (`tests/webhooks.test.ts`)**:
     - Verify signature calculation, retry backoff, and dead-letter capture.

#### 📦 Package PP-4: Incident Controls & Circuit Breakers (Phase 10)
- **Context**: PRD §52 Phase 10 incident controls.
- **Deliverables**:
  1. **Circuit Breaker Middleware / Route (`app/api/v1/admin/pause/route.ts`)**:
     - Allow an operator to pause new agreement creation, funding, and reservation execution.
     - **Invariant**: Read-only routes (`GET /api/v1/*`) and event streaming MUST remain operational during a halt; only state-mutating value endpoints return `503 SERVICE_UNAVAILABLE (SYSTEM_PAUSED)`.
  2. **Test (`tests/circuit-breaker.test.ts`)**:
     - Verify pause activation, rejection of new value movements, and transparent continuation of read streams.

---

### 4. Lead Active Queue (What Lead Is Building)

While Purple executes PP-1 through PP-4, Lead is building:
1. **LP-2 (Intent Persistence Substrate)**: Adding `Intent` to `EconomicRepository`, Postgres schema, and `app/api/v1/intents/` (delivering the backend for PP-1).
2. **LP-1 (Decoupled ERC-8183 Job Escrow on Base)**: Writing `MitraJobEscrow.sol` in `contracts/src/ERC8183/`, deploying to Base Sepolia, and binding `lib/adapters/erc8183.ts`.
3. **LP-3 (Solana Job Escrow & Autonomous Recovery)**: Adding job escrow PDAs and timelocked `refund_escrow` to `programs/mitra-vault/` on Solana devnet.
4. **LP-4 (Arcium MPC Cluster)**: Running the live Arcium MPC cluster against `probe.so`.

---

### 5. Verification Protocol Before Opening a PR

Before submitting work for merge:
1. `npm run typecheck` $\rightarrow$ 0 errors.
2. `forge test` $\rightarrow$ 50+ passing.
3. `npm test` $\rightarrow$ all tests green.
4. Document any new failure findings or numbering in `forge/FAILURES.md`. (Next free F-number is **`F65`**).
5. Post decision and handoff entries to the Shared Context MCP and sync bundles.
