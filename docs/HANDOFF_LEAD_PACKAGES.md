# Mitra Implementation Handoff: Packages 1–4 (Lead Execution)
## Scope: Phase 4 Commerce, Phase 3d Confidential Policy, Phase 10 Tooling, and Postgres CI Isolation

---

### Ground Rules & Execution Invariants (Non-Negotiable)

1. **Repository files are the source of truth** (`AGENTS.md`). Prior chat summaries are not authoritative.
2. **The Mechanism to Protect:**
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   **An `ALLOW` decision is never permission to move value.** The execution guard independently re-derives whether *this exact instruction* may move capital.
3. **Evidence Discipline (`BUILD_FOUNDRY.md` §2):**
   - Claims must carry both `evidence` and `blocker`. When `evidence` reaches `LIVE_DEMONSTRATED`, `blocker` is strictly `—`.
   - Never weaken a test to make it pass. Fix the code or record the failure honestly.
   - Record exact transaction hashes (full 66-character hex strings, never truncated).
4. **Collision Avoidance with Purple:**
   - **DO NOT TOUCH** `X-Mitra-Actor-Id` or MCP tool un-withholding (F55) — Purple owns this.
   - **DO NOT TOUCH** `scripts/run-live-clearing-epoch.mjs` — Purple owns this.

---

## Work Package 1: Phase 4 Commerce Substrate (PRD §13 / §50)

### 1.1 Objective
Move commerce from pure in-memory transition tables (`lib/kernel/commerce.ts`) to durable Space operations backed by store persistence and ERC-8183 compatibility (PRD §13, §50, Phase 4 exit condition).

**Exit Condition (PRD verbatim):** *"Real job can be opened, funded, submitted, accepted, rejected, refunded."*

### 1.2 Architectural State
- What exists: `lib/kernel/commerce.ts` defines `Space`, `Agreement`, `Deliverable`, and pure transition functions (`openAgreementInSpace`, `fundAgreementInSpace`, `submitDeliverableInSpace`, `evaluateDeliverableInSpace`).
- What is missing:
  1. Space storage and persistence in `PostgresRepository` and `InMemoryRepository` (`lib/store/`).
  2. Space HTTP endpoints (`/api/v1/spaces`, `/api/v1/spaces/[id]`).
  3. ERC-8183 projection: Mapping between ERC-8183 job lifecycle (`Client`, `Provider`, `Evaluator`, `Escrow`) and Mitra Space commitments.
  4. Integration tests proving the complete commercial lifecycle end-to-end.

### 1.3 Implementation Steps
1. **Extend Repository Interfaces (`lib/store/repository.ts`)**:
   - Add `createSpace(space: Space): Promise<Space>`
   - Add `getSpace(id: string): Promise<Space | null>`
   - Add `updateSpace(space: Space): Promise<Space>`
   - Implement in `InMemoryRepository` (`lib/store/memory.ts`) and `PostgresRepository` (`lib/store/postgres.ts`, add table `mitra.spaces` if missing).
2. **Space API Routes**:
   - `POST /api/v1/spaces`: Create and initialize a Space with budget, participants, and allowed capabilities.
   - `GET /api/v1/spaces/[id]`: Query a Space, its committed capital, active agreements, and participant list.
3. **ERC-8183 Adapter / Projection (`lib/adapters/erc8183.ts`)**:
   - Define ERC-8183 struct and event projection: `Client`, `Provider`, `Evaluator`, `Escrow`.
   - Wire state mapping:
     - `Open` $\rightarrow$ `AgreementStatus.PROPOSED`
     - `Funded` $\rightarrow$ `AgreementStatus.OPEN` (capital reserved in Space)
     - `Submitted` $\rightarrow$ `AgreementStatus.DELIVERED` (deliverable payload attached)
     - `Completed` $\rightarrow$ `AgreementStatus.ACCEPTED` (settlement triggered)
     - `Rejected` $\rightarrow$ `AgreementStatus.DISPUTED` or `TERMINAL_REJECTED` (compensation triggered)
4. **Integration Test Suite (`tests/commerce-lifecycle.test.ts`)**:
   - Execute the full lifecycle through store and routes: `Open -> Fund -> Submit -> Accept -> Release` and `Open -> Fund -> Submit -> Reject -> Refund`.
   - Mutation test: verify bypassing Space containment or budget bounds throws.

---

## Work Package 2: Phase 3d Confidential Policy MPC (Arcium)

### 2.1 Objective
Advance confidential policy evaluation (`FR-VAULT-008`, `FR-VAULT-009`) by solving the Arcium SBPFv3 toolchain version skew and validating the circuit against local evaluation (PRD §52 Phase 3d, F31, F43, F44).

### 2.2 Diagnosed Toolchain Blocker (from F44)
`arcium localnet` fails because Anchor CLI 1.0.2 pairs with platform-tools `v1.52` (incompatible with SBPFv3). Platform tools `v1.57` is installed at `/home/ubuntu/.local/share/solana/install/releases/...`.

Working compiler invocation discovered in F44:
```bash
cargo-build-sbf --tools-version v1.57 --arch v1
```

### 2.3 Implementation Steps
1. **Inspect Arcium Probe (`/home/ubuntu/arcium-probe/probe/`)**:
   - Inspect `encrypted-ixs/src/lib.rs` (the `evaluate_mandate` Arcis circuit).
   - Inspect `programs/probe/src/lib.rs` (ensure all 9 renamed positions from F44 match `evaluate_mandate`).
2. **Build Circuit and SBF Program**:
   ```bash
   cd /home/ubuntu/arcium-probe/probe
   arcium build
   cargo-build-sbf --tools-version v1.57 --arch v1 --manifest-path programs/probe/Cargo.toml
   ```
3. **Hermetic Local Test Harness (`tests/arcium-circuit.test.ts`)**:
   - Write a Node/TS test that validates the policy circuit logic (zero-amount refusal, boundary checking, reason code discrimination) against simulated inputs.
   - Prove that `amount == 0` is refused (`INVALID_AMOUNT`), `amount > limit` is refused (`LIMIT_EXCEEDED`), and valid transactions return `ALLOW`.

---

## Work Package 3: Phase 10 Console & Observability Live Store Wiring

### 1.1 Objective
Eliminate direct imports of `@/lib/store/seed` in the console and wire `/evidence` and `/integrations` to real store data and live chain observations (PRD §52 Phase 10, PROOF_LEDGER T3/line 108).

### 1.2 Problem Statement
- `app/integrations/page.tsx` and `app/evidence/page.tsx` directly import from `@/lib/store/seed` and display static fixtures (`DataSource fixtures="integration status is not read from the adapters"`).
- `PROOF_LEDGER.md` explicitly flags this gap.

### 1.3 Implementation Steps
1. **Store Projections for Integrations & Evidence**:
   - Expose `getIntegrations()` and `getEvidenceRecords()` from `getStore()` (`lib/store/provider.ts`).
   - Populate from repository store records rather than seed constants.
2. **Rewire Console Pages**:
   - In `app/integrations/page.tsx`: Replace `import { integrations } from "@/lib/store/seed"` with `const store = await getStore(); const integrations = await store.listIntegrations();`.
   - In `app/evidence/page.tsx`: Replace `import { evidence } from "@/lib/store/seed"` with live evidence reads from store and `GET /api/v1/settlements/evidence`.
   - Replace `<DataSource fixtures="..."/>` with `<DataSource backend={store.backend}/>`.
3. **Observability & Webhooks**:
   - Add Prometheus metrics route: `GET /api/v1/metrics` exporting:
     - `mitra_settlements_total{status, chain}`
     - `mitra_vault_available_units{chain, token}`
     - `mitra_vault_reserved_units{chain, token}`
     - `mitra_sagas_active_count`
4. **Verification**:
   - Verify `next build` succeeds without static seed imports on these pages.
   - Run Vitest browser / route tests to confirm 200 responses with `backend: "postgres" | "memory"`.

---

## Work Package 4: Postgres CI Test Isolation (Purple Note #7, Seq 82)

### 1.1 Objective
Eliminate parallel test race conditions on table truncations when running Vitest against a single PostgreSQL database instance.

### 1.2 Problem Statement
When running Vitest with multiple worker threads against `DATABASE_URL`, different test files run concurrently. When `persistence.test.ts` truncates `mitra.settlements` or `mitra.vaults`, racing queries in `settlement-persistence.test.ts` fail with unexpected missing rows or foreign key locks.

### 1.3 Implementation Steps
1. **Vitest Configuration (`vitest.config.ts`)**:
   - Add conditional file concurrency gating based on `DATABASE_URL`:
     ```typescript
     export default defineConfig({
       test: {
         fileParallelism: !process.env.DATABASE_URL,
         testTimeout: 30_000,
         hookTimeout: 30_000,
         // ...
       }
     });
     ```
2. **Dedicated NPM Script in `package.json`**:
   - Add `"test:postgres": "vitest run --no-file-parallelism"`
   - Add `"test:all": "npm test && npm run test:postgres"`
3. **Per-Worker Schema Isolation (Advanced Option)**:
   - In `lib/store/postgres.ts`, support optional `search_path` prefix per worker ID (`process.env.VITEST_WORKER_ID`).
4. **Verification**:
   - Verify `DATABASE_URL=... npm run test:postgres` runs cleanly across all 51+ test suites without deadlocks or table collision failures.

---

## Execution & Coordination Workflow

When picking up these packages, follow the standard multi-agent protocol:

```bash
# 1. Pull latest tip
git pull origin feat/mitra-vault-v2-reseed

# 2. Audit shared context
node shared-context-mcp/dist/cli.js audit

# 3. Announce starting package
node shared-context-mcp/dist/cli.js say \
  --author "agent:lead-worker" \
  --kind task \
  --scope "commerce" \
  --title "Starting Work Package X: ..."

# 4. Implement and run verification gates
npm run typecheck
npm test
forge test

# 5. Commit and sync
git add -A && git commit -m "..." && git push origin feat/mitra-vault-v2-reseed
node shared-context-mcp/dist/cli.js sync
```
