# Mitra Co-Developer Handoff Specification
## Phase-by-Phase Execution Guide

---

### Status Baseline (Current Head: `fix/integrity-f40-f45`)

* **Tests:** 497 TS tests passing (37 files passed, 3 persistence files self-skip cleanly offline), 88 Rust tests passing in `programs/mitra-vault`. Zero RPC flakes.
* **TypeScript:** `npm run typecheck` (`tsc --noEmit`) passes with 0 errors.
* **Shared Context:** Sequence 47 audited (`ok=true`).
* **PRD §4.5 Discharged:** Failure is a state transition, not an exception (`lib/kernel/commerce-recovery.ts` and `app/api/v1/sagas/route.ts`).

---

### Sequence of Phases for the Co-Developer

```
┌────────────────────────────────────────────────────────────────────────┐
│                      CO-DEVELOPER ROADMAP PHASES                       │
├─────────┬───────────────────────────────────┬──────────────────────────┤
│ Phase 1 │ Commercial Agreement HTTP Write   │ Prometheus Showcase      │
│         │ Surface (POST /api/v1/agreements) │ PRD Phase 4              │
├─────────┼───────────────────────────────────┼──────────────────────────┤
│ Phase 2 │ Netting & Clearing Pipeline       │ Pando Showcase           │
│         │ (POST /api/v1/clearing)           │ PRD Phase 7              │
├─────────┼───────────────────────────────────┼──────────────────────────┤
│ Phase 3 │ Multi-Rail Settlement Transports  │ Cross-Chain Settlement   │
│         │ (Base Sepolia & Tempo Moderato)   │ PRD Phases 8 & 9         │
└─────────┴───────────────────────────────────┴──────────────────────────┘
```

---

## Phase 1: Commercial Agreement Write Surface (`POST /api/v1/agreements`)

### 1.1 Objective & Context
Currently, [`lib/kernel/commerce-recovery.ts`](../lib/kernel/commerce-recovery.ts) exposes `applyAgreementOpWithSaga` which drives the complete commercial and recovery lifecycle. However, [`app/api/v1/agreements/route.ts`](../app/api/v1/agreements/route.ts) only implements `GET`. 

This phase gives `Agreement` its true HTTP mutation surface, allowing human operators, console UIs, and external agents to drive agreements over HTTP.

### 1.2 Target Files
* **Modify:** `app/api/v1/agreements/route.ts`
* **New Test File:** `tests/agreements-api.test.ts`

### 1.3 How to Implement

1. **Add Request Validation Schema (Zod):**
   ```typescript
   export const agreementActionSchema = z.discriminatedUnion("op", [
     z.object({
       op: z.literal("open"),
       spaceId: z.string().min(1),
       agreement: z.object({
         agreementId: z.string().min(1),
         runId: z.string().min(1),
         intentId: z.string().min(1),
         client: z.string().min(1),
         provider: z.string().min(1),
         evaluator: z.string().min(1),
         externalJobRefs: z.array(z.string()).default([]),
         price: z.object({ asset: z.literal("USDC"), amount: z.number().positive() }),
         deadline: z.string(),
         acceptanceCriteria: z.array(z.string()).min(1),
         failurePolicy: z.string().optional(),
       }),
       capability: z.string().min(1),
       amount: z.object({ asset: z.literal("USDC"), amount: z.number().positive() }),
     }),
     z.object({
       op: z.literal("fund"),
       spaceId: z.string().min(1),
       agreementId: z.string().min(1),
       capability: z.string().min(1),
       amount: z.object({ asset: z.literal("USDC"), amount: z.number().positive() }),
     }),
     z.object({
       op: z.literal("startExecution"),
       spaceId: z.string().min(1),
       agreementId: z.string().min(1),
     }),
     z.object({
       op: z.literal("submitDeliverable"),
       spaceId: z.string().min(1),
       agreementId: z.string().min(1),
       artifactRefs: z.array(z.string()).min(1),
       contentHash: z.string().min(1),
     }),
     z.object({
       op: z.literal("acceptDeliverable"),
       spaceId: z.string().min(1),
       agreementId: z.string().min(1),
     }),
     z.object({
       op: z.literal("rejectDeliverable"),
       spaceId: z.string().min(1),
       agreementId: z.string().min(1),
       failureReason: z.string().optional(),
     }),
   ]);
   ```

2. **Implement `POST(req: Request)` in `app/api/v1/agreements/route.ts`:**
   - Parse body with `agreementActionSchema`. If invalid, return 400.
   - For `op === "open"`, call `openAgreement(space, agreementDraft, opts)`.
   - For subsequent ops, retrieve `space` and `agreement` via `repo.getSpace(spaceId)` and `repo.getAgreement(agreementId)`.
   - Call `applyAgreementOpWithSaga(repo, space, agreement, body.op, opts)`.
   - If not `ok`, return 400 `{ error: res.reason }`.
   - If `ok`, persist changes (`repo.saveSpace`, `repo.saveAgreement`) and return 200 `{ data: res.value, backend, evidenceLevel: "LOCAL_PASS" }`.

### 1.4 Invariants to Protect
- **Rule 24 (FAILURES.md):** Commercial state transition runs *first*; the saga only follows if the commercial transition succeeded.
- **Capital Ordering:** Refund releases `space.committed` *before* the saga marks `RECOVERED`.
- **Default Failure Route:** Empty `failurePolicy` must default to `"refund on expiry"`, never an absent saga.

---

## Phase 2: Netting & Clearing Pipeline (`POST /api/v1/clearing`)

### 2.1 Objective & Context
Mitra has complete, tested deterministic netting algorithms in [`lib/kernel/clearing.ts`](../lib/kernel/clearing.ts). But currently, clearing epochs are not written or finalized through HTTP.

This phase unlocks **PRD Phase 7** and **Project Pando** by enabling batches of bilateral obligations to be submitted, netted, committed into an epoch with a Merkle digest, and finalized after a challenge window.

### 2.2 Target Files
* **Modify:** `app/api/v1/clearing/route.ts`
* **Modify/Extend:** Repository epoch methods in `lib/store/repository.ts`
* **New Test File:** `tests/clearing-api.test.ts`

### 2.3 How to Implement

1. **Bilateral Collection & Dispute Filtering:**
   - Read pending obligations from `repo.listObligations()`.
   - Enforce **FR-CLEAR-003**: Filter out any obligation with status `DISPUTED` or `DEFAULTED` into an `excluded` array.
2. **Deterministic Netting Calculation:**
   - Pass valid obligations to `netObligations(obligations)`.
   - Assert $\sum \text{net} = 0$ (Conservation of Value).
3. **Epoch Commitment:**
   - Generate SHA-256 domain-separated receipt digest using `settlementReceiptHash(transfers, epochId, resultHash)` (avoiding F45's string concatenation trap).
   - Write epoch to repository in `PROVISIONAL` state with `challengeExpiresAt`.
4. **Finalization Endpoint / Trigger:**
   - Provide an endpoint or op `finalizeEpoch`: confirms challenge window has expired and no challenges are open.
   - Advances epoch to `FINALIZED`.
   - Enforce: An obligation enters at most **one** finalized clearing epoch.

---

## Phase 3: Multi-Rail Settlement Transports (Base & Tempo)

### 3.1 Objective & Context
Currently, [`lib/adapters/base.ts`](../lib/adapters/base.ts) and [`lib/adapters/tempo.ts`](../lib/adapters/tempo.ts) throw `UnconfiguredAdapterError` when no transport is provided.

This phase wires real testnet transports using the Colosseum Hackathon canonical RPC endpoints identified in our resource audit.

### 3.2 Target Files
* **Modify:** `lib/adapters/base.ts`
* **Modify:** `lib/adapters/tempo.ts`
* **Verify:** `tests/settlement-adapters.test.ts`

### 3.3 How to Implement

1. **Base Sepolia Transport (`lib/adapters/base.ts`):**
   - Use viem/ethers with RPC `https://sepolia.base.org` (or Alchemy/CDP).
   - Wire `BaseTransport` interface:
     - `sendUserOp`: Packages UserOp with EIP-712 structured mandate hash.
     - `verify1271`: Queries smart contract wallet for ERC-1271 signature validity.
2. **Tempo Moderato Transport (`lib/adapters/tempo.ts`):**
   - RPC: `https://rpc.moderato.tempo.xyz` (Chain ID 42431).
   - **Crucial Guard (F12/F40):** Never read `eth_getBalance` as native balance (it returns a constant 0xa5bf). Only settle in TIP-20 tokens via contract calls.
   - **Rate-Limit Guard:** Wrap all JSON-RPC calls with exponential backoff on `-32002` (up to 3 retries, $500\text{ms} \times 2^n$ backoff), following the pattern in `scripts/fund-tempo.mjs`.
   - Payment confirmation: Must parse decoded `Transfer` logs, never rely on account balance deltas.
3. **Testing Discipline:**
   - Gate live network tests behind `BASE_LIVE=1` and `TEMPO_LIVE=1`.
   - The default `npm test` run must remain offline-first and 100% deterministic.

---

### Step-by-Step Commands for the Co-Developer

```bash
# 1. Pull latest and review context digest
git pull origin fix/integrity-f40-f45
node shared-context-mcp/dist/cli.js digest

# 2. Check baseline health
npm run typecheck
npm test
cargo test -p mitra-vault

# 3. Announce start of work
node shared-context-mcp/dist/cli.js say \
  --kind progress \
  --title "Starting Phase 1: Commercial Agreement HTTP Write Surface" \
  --scope "commerce"

# 4. Implement Phase 1 and run tests
npx vitest run tests/agreements-api.test.ts

# 5. Commit and audit before handing back
git add app/ tests/
git commit -m "feat(commerce): implement POST /api/v1/agreements write surface"
node shared-context-mcp/dist/cli.js audit
```
