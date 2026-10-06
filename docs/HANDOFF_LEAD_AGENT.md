# Mitra Lead Coding Agent Handoff (Sprint Wave 2)
## Active Packages: LP-1 Intent Persistence ✅, LP-2 Decoupled Escrow & Wire ✅, LP-3 Tempo Parity ✅, F65/F68 Fixes ✅, LP-4 Solana Escrow Recovery ✅, LP-5 Arcium MPC [ACTIVE NEXT]

**Date:** 2026-10-06  
**Current Branch:** `feat/mitra-vault-v2-reseed`  
**Shared Context Tip:** Seq 118 (`ctx_cb399b84759b85c9`, hash `204bb4fe4613f2107c095d19b84843881f8f4d738c94c3fcdb54083854e820ef`)  
**Keys Location:** `.dev-keys/evm-testnet.key` (EVM: `0xAeA8bc34df7745e35510214147a2F6A5e15Eb26D`), `.dev-keys/solana-testnet.json` (Solana)  

---

### Executive State: Completed Packages

1. **LP-1 Intent Persistence Substrate** landed in `656967d`:
   - `createIntent`/`getIntent`/`listIntents` on `EconomicRepository`, Postgres, and Memory.
   - `POST/GET /api/v1/intents`, `GET /api/v1/intents/[id]` active.
   - 6/6 tests passing in `tests/intent-persistence.test.ts`.

2. **LP-2 Decoupled ERC-8183 Job Escrow & Wire** landed in `9d93706`, `003ff74`, `2daf5c5`:
   - `MitraJobEscrow.sol` deployed and runtime-verified (2,096 bytes) on:
     - **Base Sepolia (84532)**: `0xc49c93f0a1e5362b38f1c38b8f0ff80c577df3a6` (Block `47740801`)
     - **Tempo Moderato (42431)**: `0x95ca2170d1021cb9b5ce6809066f094e00c0a583` (Block `38355996`)
   - `lib/adapters/erc8183-transport.ts`: `ERC8183Transport` with `depositToEscrow`, `completeJob`, `refundJob`, `getJob`.
   - Verified live in `tests/commerce-escrow-live.test.ts` (6/6 live tests passed under `JOB_ESCROW_LIVE=1`):
     - Base Sepolia: Fund `0x294ea38fca81c9dff3a3c40156d485b26fd2753d1c36ba9ca0cd73bc6acb8c07` (blk `47742052`), Release `0x8ff9c6d03f2b50bb0d61ef05c5d13ca3940066fcf90c7b8cd50cc4101c1079c9` (blk `47742053`), Refund `0x5ae3a080470aeed0b9d546610e1f3bf2af2952f15f649844e69be75cf686a975` (blk `47742056`).
     - Tempo Moderato: Fund `0x2ebe2afebcddcce59e47aaf3a63290949b79956907954f884a32e919f6904650` (blk `38360077`), Release `0x22060610c9e22318d3ef66ecf3d2a19c4b099caf9538a7110fbe5dff3a8774dd` (blk `38360078`), Refund `0x324779cd52eb0919bad820627dc3f9f6ff1f5eb7ba012817fba240c8f790765f` (blk `38360095`).

3. **LP-3 Tempo Settlement Parity & Caller Verification** landed in `18bba22`:
   - `tests/settlement-tempo-caller.test.ts`: Mirrors Base caller suite across 28 tests (happy path, evidence, refusals, capital book movements, nonce boundaries).
   - Verified live on **Tempo Moderato (42431)** under `TEMPO_LIVE=1`:
     - Settle Tx: `0x80cccf7863e042a963b6b2bc5eb873fb43d2db1987571479bad2aaa055ac35f3`
     - Block: `38398243`
     - Settlement: `set_ag_live_tempo_1791275280833`
     - Receipt: `rcpt_set_ag_live_tempo_1791275280833`
     - Status: `CONFIRMED`, Evidence: `TESTNET_PASS`
     - Memo Topic Verified: `0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0` on-chain event carrying EIP-712 settlement commitment.

4. **Purple Sprint Coordination (PP-1..PP-4 Merged; F65 & F68 Resolved)**:
   - **PP-1**: 19 MCP tools served (backed `/api/v1/intents` and `mitra_start_execution`, closing F66). E2E loop verified over Streamable HTTP and stdio against Postgres.
   - **PP-2**: `lib/adapters/virtuals.ts` built against real `@virtuals-protocol/acp-node` schemas (closing F67).
   - **PP-3**: Outbox event worker (`scripts/webhook-worker.ts`), HMAC-SHA256 signatures, socket-level SSRF defenses.
   - **PP-4**: Operator emergency circuit breaker (`POST /api/v1/admin/pause`) halting value movement while leaving reads, streams, and recovery active (`tests/circuit-breaker.test.ts`).
   - **F65 Resolved**: `POST /api/v1/intents` and repository `createIntent` enforce first-write-wins. Identical replay returns `200`; mismatched replay returns `409 INTENT_EXISTS`.
   - **F68 Resolved**: `Agreement.externalJobRefs` typed `ExternalJobRef[] = (ExternalIdentityRef | string)[]`.

5. **LP-4 Solana Job Escrow & Autonomous Recovery (Phase 6)** ✅:
   - Program upgraded on Solana devnet (`GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY`, slots `508039758` and `508041500`).
   - `JobEscrow` PDA (154 B, `[b"escrow", vault, job_id]`), `lock_escrow`, `release_escrow`, `refund_escrow` (codes 6019–6023), and three Vault transitions (`lock_to_escrow`, `pay_escrow`, `return_escrow`).
   - Live devnet proof:
     - Lock: `2mXh5ejmr9H8ikydogRuoygSjKq6vz8upTPznxKBdmbeGaLEyAyDfCvBtnwTULqnr4E98Xz4rExDTS6QQGpYr8bV` (slot `508042268`)
     - Release: `5YZKU4XaxmXhgPgyBCpdVa4B5EFSmb81aZVR5LyZtrPMw72tWijxBpAZmLmNSxgRjnvR1wW5r7XPFGonSeaYC6rk` (slot `508042354`)
     - Autonomous refund: `57f5fScrHFcecrDLV66SgGgEtPmyhDnKJ5HyzA3yfM1kiLN5BPx3uGWcuSyqMM9nPs7idVvb9PCjyyKddNfq5WQe` (slot `508042318`)
   - Guards: PRD §15.5 pre-commitment enforced (all-zero route rejected `0x1783` at lock and refund), caller cannot redirect payee/amount, pre-deadline stranger refund refused (`0x1784`), single-shot settlement (`0x1785`).
   - Defect F70 resolved: Reconciled reservation arithmetic with escrowed funds via `Vault::held()` (`total − escrowed`), restoring Phase 2 six-position invariant to the exact lamport.
   - Defect F69 resolved: Committed program ID bytes pinned in Rust `PROGRAM_ID_BYTES` and test harnesses.
   - Tests: `cargo test` 147/147 pass; `tests/solana-escrow.test.ts` 19/19 pass (including 3 live); mutation audit 8/8 killed.

---

### Ground Rules & Non-Negotiable Invariants

1. **Repository Files Are Truth**: Prior chat summaries are non-authoritative (`AGENTS.md`).
2. **The Mechanism to Protect**:
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   An `ALLOW` decision is never permission to move value. The execution guard independently re-derives whether this exact instruction may move capital.
3. **Multi-Chain Parity**: Every EVM deployment and rail must support **both Base Sepolia (84532) and Tempo Moderato (42431)**, and Solana Devnet where applicable.
4. **Pre-Committed Recovery (PRD §15.5)**: Every compensation route must be hash-committed at funding time. Never synthesize post-failure calldata.
5. **Strict Evidence Discipline (BUILD_FOUNDRY §2)**: Record un-truncated 66-character EVM tx hashes / 88-character Solana signatures and exact block/slot numbers.

---

### Active Next Packages

#### 📦 Task 1: LP-5 — Arcium Confidential Policy Cluster Run (Phase 3d) [ACTIVE NEXT]
**Context:** SBF circuit `probe.so` is compiled (423 KB) and `tests/arcium-circuit.test.ts` passes 14/14 hermetically. It needs a live Arcium cluster execution to close `FR-VAULT-008` & `FR-VAULT-009`.

**Implementation Plan:**
1. Check local/devnet Arcium MPC node setup (`arcup`, Docker, Anchor 1.0.2).
2. Run `evaluate_mandate` against encrypted mandate and proposal inputs.
3. Verify that the MPC cluster produces the boolean approval and reason code on-chain.
4. Record execution evidence in `forge/PROOF_LEDGER.md`.

---

#### 📦 Task 2: Agreement Route Wiring to On-Chain Escrow (Phase 4/6 Integration)
**Context:** Escrows are deployed and live on Base Sepolia, Tempo Moderato, and Solana Devnet. The next step is wiring `app/api/v1/agreements/route.ts` so that agreement state transitions invoke on-chain escrow operations:
- On `fund`: Call `depositToEscrow` on EVM or `lock_escrow` on Solana.
- On `acceptDeliverable`: Call `completeJob` on EVM or `release_escrow` on Solana.
- On rejection or expiry: Call `refundJob` on EVM or keeper `refund_escrow` on Solana.

---

#### 📦 Task 3: Virtuals Protocol ACP Outbound On-Chain Transaction Transport (Phase 5)
**Context:** ACP schemas and translation exist in `lib/adapters/virtuals.ts` (PP-2). Wire outbound transaction submission using agent session keys against Base Sepolia.

---

#### 📦 Task 4: Webhook Worker Postgres Advisory Lock (Phase 10 Hardening)
**Context:** Purple added outbox worker (`scripts/webhook-worker.ts`). Add `pg_try_advisory_lock` in Postgres repository to prevent concurrent worker instances from double-delivering events.

---

### Verification Gates Status
- `npm run typecheck`: **0 errors**
- `forge test`: **57 passed, 0 failed**
- `cargo test --manifest-path programs/mitra-vault/Cargo.toml`: **147 passed, 0 failed**
- `npx vitest run`: **67 files passed, 7 skipped (1103 passed, 74 skipped)**
- `tests/solana-escrow.test.ts`: **16 passed, 3 skipped (hermetic)**
- Shared Context Audit: `ok: true, checked: 118, tipHash: 204bb4fe4613...`
