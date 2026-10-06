# Mitra Lead Coding Agent Handoff (Sprint Wave 2)
## Active Packages: LP-1 Intent Persistence ✅, LP-2 Decoupled Escrow & Wire ✅, LP-3 Tempo Parity ✅, F65/F68 Fixes ✅, LP-4 Solana Escrow Recovery [ACTIVE NEXT], LP-5 Arcium MPC

**Date:** 2026-10-06  
**Current Branch:** `feat/mitra-vault-v2-reseed`  
**Shared Context Tip:** Seq 117 (`ctx_61a813506de51f49`, hash `24644f4f095b5def6fa0cbf405c13174aa6ed81ada2aaa016d64c4bfcc36dd97`)  
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

3. **LP-3 Tempo Settlement Parity & Caller Verification** ✅:
   - `tests/settlement-tempo-caller.test.ts`: Mirrors Base caller suite across 28 tests (happy path, evidence, refusals, capital book movements, nonce boundaries).
   - Verified live on **Tempo Moderato (42431)** under `TEMPO_LIVE=1`:
     - Settle Tx: `0x80cccf7863e042a963b6b2bc5eb873fb43d2db1987571479bad2aaa055ac35f3`
     - Block: `38398243`
     - Settlement: `set_ag_live_tempo_1791275280833`
     - Receipt: `rcpt_set_ag_live_tempo_1791275280833`
     - Status: `CONFIRMED`, Evidence: `TESTNET_PASS`
     - Memo Topic Verified: `0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0` on-chain event carrying EIP-712 settlement commitment.
     - Recorded in `forge/PROOF_LEDGER.md` and `forge/EXECUTION_PLAN.md`.

4. **Purple Sprint Coordination (F65 & F68 Resolved)** ✅:
   - **F65 Resolved**: `POST /api/v1/intents` and repository `createIntent` enforce first-write-wins. Identical replay returns `200` with the existing intent; mismatched replay returns `409 INTENT_EXISTS`; original intent survives. Pinned in `tests/intent-persistence.test.ts`.
   - **F68 Resolved**: `Agreement.externalJobRefs` typed `ExternalJobRef[] = (ExternalIdentityRef | string)[]`. Accommodates both structured `{ system, id }` objects and namespaced URN strings (Virtuals ACP) across domain types, routes, and `app/commerce/page.tsx`.
   - **Decisions Communicated in Shared Context Seq 117**:
     - Signed-transition refusals (401/403) remain excluded from the run timeline to prevent unauthenticated log flooding.
     - Postgres single-worker advisory lock (`pg_try_advisory_lock`) approved for webhook worker.

---

### Ground Rules & Non-Negotiable Invariants

1. **Repository Files Are Truth**: Prior chat summaries are non-authoritative (`AGENTS.md`).
2. **The Mechanism to Protect**:
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   An `ALLOW` decision is never permission to move value. The execution guard independently re-derives whether this exact instruction may move capital.
3. **Multi-Chain Parity**: Every EVM deployment and rail must support **both Base Sepolia (84532) and Tempo Moderato (42431)**.
4. **Pre-Committed Recovery (PRD §15.5)**: Every compensation route must be hash-committed at funding time. Never synthesize post-failure calldata.
5. **Strict Evidence Discipline (BUILD_FOUNDRY §2)**: Record un-truncated 66-character transaction hashes and block numbers.

---

### Active Next Packages

#### 📦 Task 3: LP-4 — Solana Job Escrow & Autonomous Recovery (Phase 6) [ACTIVE NEXT]
**Context:** Base and Tempo have autonomous timelocked recovery via `refundJob()`. Solana's `mitra-vault` program currently supports `reserve` and `release` (which requires authority signatures). Solana needs autonomous timelocked job escrow.

**Implementation Plan:**
1. **Solana Program Updates (`programs/mitra-vault/src/lib.rs`)**:
   - Add Job Escrow PDA: `seeds = [b"escrow", vault.key().as_ref(), job_id.as_ref()]`.
   - State struct:
     ```rust
     pub struct JobEscrow {
         pub client: Pubkey,
         pub provider: Pubkey,
         pub amount: u64,
         pub timeout: i64,
         pub completed: bool,
         pub refunded: bool,
         pub refund_route_hash: [u8; 32],
     }
     ```
   - Instructions:
     - `lock_escrow(job_id, provider, amount, timeout, refund_route_hash)`: Deducts `available` and funds escrow PDA.
     - `release_escrow(job_id)`: Client authority releases funds to `provider`.
     - `refund_escrow(job_id)`: **Autonomous recovery**: If `Clock::get()?.unix_timestamp >= timeout`, anyone can trigger refund to return funds to vault `available`. Reverts if `refund_route_hash == [0; 32]`.
2. **Compile & Deploy**:
   - Build: `cargo-build-sbf --tools-version v1.57 --arch v1`.
   - Upgrade devnet program at `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` using `.dev-keys/solana-testnet.json`.
3. **Tests (`tests/solana-escrow.test.ts`)**:
   - Verify lock, client release, and autonomous timeout refund on Solana devnet.

---

#### 📦 Task 4: LP-5 — Arcium Confidential Policy Cluster Run (Phase 3)
**Context:** SBF `probe.so` is compiled (423 KB) and `tests/arcium-circuit.test.ts` passes 14/14 hermetically. It needs a live Arcium cluster execution to close `FR-VAULT-008` & `FR-VAULT-009`.

**Implementation Plan:**
1. Spin up local/devnet Arcium MPC node.
2. Run `evaluate_mandate` against encrypted mandate and proposal inputs.
3. Verify that the MPC cluster produces the boolean approval and reason code on-chain.
4. Record execution evidence in `forge/PROOF_LEDGER.md`.

---

### Verification Gates Status
- `npm run typecheck`: **0 errors**
- `npm test`: **66 files passed, 7 skipped, 0 failed (1082 passed, 71 skipped)**
- `forge test`: **57 passed, 0 failed**
- `TEMPO_LIVE=1 npx vitest run tests/settlement-tempo-caller.test.ts`: **28/28 passed**
- Shared Context Audit: `ok: true, checked: 117, tipHash: 24644f4f...`
