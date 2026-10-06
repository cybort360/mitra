# Mitra Lead Coding Agent Handoff (Sprint Wave 2)
## Active Packages: LP-2 Adapter Wiring, LP-3 (Tempo Settlement Parity), LP-4 (Solana Escrow Recovery), LP-5 (Arcium MPC)

**Date:** 2026-10-06  
**Current Branch:** `feat/mitra-vault-v2-reseed` (Tip: `94118e1` pushed to remote)  
**Shared Context Tip:** Seq 103 (`b6d7ff1d...`)  
**Keys Location:** `.dev-keys/evm-testnet.key` (EVM: `0xAeA8...`), `.dev-keys/solana-testnet.json` (Solana)  

---

### Executive State: LP-1 & LP-2 Complete & Pushed ✅

1. **LP-1 Intent Persistence Substrate** landed in `656967d`:
   - `createIntent`/`getIntent`/`listIntents` on `EconomicRepository`, Postgres, and Memory.
   - `POST/GET /api/v1/intents`, `GET /api/v1/intents/[id]` active.
   - 5/5 tests passing in `tests/intent-persistence.test.ts`.
2. **LP-2 Decoupled ERC-8183 Job Escrow** landed in `9d93706`:
   - `MitraJobEscrow.sol` deployed and runtime-verified (2,096 bytes) on:
     - **Base Sepolia (84532)**: `0xc49c93f0a1e5362b38f1c38b8f0ff80c577df3a6` (Block `47740801`)
     - **Tempo Moderato (42431)**: `0x95ca2170d1021cb9b5ce6809066f094e00c0a583` (Block `38355996`)
   - 7/7 Foundry tests pass (57/57 total).
   - Solved: Refund pays client directly (avoids `deposit()` self-credit trap); zero callback into vault; PRD §15.5 `refundRouteHash` pre-commitment enforced.

---

### Ground Rules & Non-Negotiable Invariants

1. **Repository Files Are Truth**: Prior chat summaries are non-authoritative (`AGENTS.md`).
2. **The Mechanism to Protect**:
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   An `ALLOW` decision is never permission to move value. The execution guard independently re-derives whether this exact instruction may move capital.
3. **Multi-Chain Parity — Do Not Exclude Tempo**: Every EVM deployment and rail must support **both Base Sepolia (84532) and Tempo Moderato (42431)**:
   - Base Sepolia: USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 dec).
   - Tempo Moderato: PathUSD (`0x20c0000000000000000000000000000000000000`, 6 dec, TIP-20).
4. **Pre-Committed Recovery (PRD §15.5)**: Every compensation route (`refundJob`) must be hash-committed at funding time. Never synthesize post-failure calldata.
5. **Strict Evidence Discipline (BUILD_FOUNDRY §2)**: Record un-truncated 66-character transaction hashes and block numbers.

---

### Lead Active Work Packages

#### 📦 Task 1: LP-2 Follow-up — ERC-8183 Live Transport & Wiring
**Context:** `lib/adapters/erc8183.ts` is currently a pure data projection. It needs an on-chain transport interacting with the deployed `jobEscrow` contracts without making offline tests fragile.

**Tasks:**
1. In `lib/adapters/erc8183.ts` (or `lib/adapters/erc8183-transport.ts`), add `ERC8183Transport`:
   - Methods: `depositToEscrow(job)`, `completeJob(jobId)`, `refundJob(jobId)`.
   - Reads contract addresses from `lib/evm/deployments.json` under `jobEscrow.baseSepolia` and `jobEscrow.moderato`.
2. Add opt-in live test suite `tests/commerce-escrow-live.test.ts` (gated by `JOB_ESCROW_LIVE=base|tempo|1`):
   - Fund a job on Base Sepolia (`0xc49c...`) and Tempo Moderato (`0x95ca...`).
   - Demonstrate `completeJob` (release to provider) and `refundJob` (return to client after simulated or actual timeout).
   - Verify `tests/commerce-lifecycle.test.ts` continues to pass 100% offline.

---

#### 📦 Task 2: LP-3 — Tempo Settlement Parity & Caller Wiring (Phase 9)
**Context:** `POST /api/v1/settlements` settles agreements on Base Sepolia, but Tempo settlement has only been exercised from adapter unit tests. It must be accessible through the common API route with full execution guard verification.

**Tasks:**
1. **API Wiring & Caller Test (`tests/settlement-tempo-caller.test.ts`)**:
   - Drive the full route: Create agreement with `payTo.chain = "tempo"` (asset `PathUSD`) $\rightarrow$ Fund $\rightarrow$ Submit $\rightarrow$ Accept.
   - Call `POST /api/v1/settlements` with `{ agreementId }`.
   - Verify that:
     1. The execution guard re-derives the digest and validates mandate headroom.
     2. The reservation nonce is consumed.
     3. Value settles through `TempoSettlementAdapter` or `MitraVault.sol` (`0x85409dfc...`).
     4. On-chain TIP-20 transfer emits with the agreement `actionHash` in the transaction memo.
2. **Verify live on Tempo Moderato**:
   - Run under `TEMPO_LIVE=1` with `.dev-keys/evm-testnet.key`.
   - Record block number and transaction hash in `forge/PROOF_LEDGER.md`.

---

#### 📦 Task 3: LP-4 — Solana Job Escrow & Autonomous Recovery (Phase 6)
**Context:** Base and Tempo now have autonomous timelocked recovery via `refundJob()`. Solana's `mitra-vault` program only supports `reserve` and `release` (which requires authority signatures). Solana needs autonomous timelocked job escrow.

**Tasks:**
1. **Solana Program Updates (`programs/mitra-vault/src/lib.rs`)**:
   - Add Job Escrow PDA: `seeds = [b"escrow", vault.key().as_ref(), job_id.as_ref()]`.
   - State struct: `JobEscrow { client: Pubkey, provider: Pubkey, amount: u64, timeout: u64, completed: bool, refunded: bool, refund_route_hash: [u8; 32] }`.
   - Instructions:
     - `lock_escrow(job_id, provider, amount, timeout, refund_route_hash)`: Deducts `available` and funds escrow PDA.
     - `release_escrow(job_id)`: Client authority releases funds to `provider`.
     - `refund_escrow(job_id)`: **Autonomous recovery**: If `Clock::get()?.unix_timestamp >= timeout`, anyone can trigger refund to return funds to vault `available`. Reverts if `refund_route_hash` is zero.
2. **Compile & Deploy**:
   - Build: `cargo-build-sbf --tools-version v1.57 --arch v1`.
   - Upgrade devnet program at `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` using `.dev-keys/solana-testnet.json`.
3. **Tests (`tests/solana-escrow.test.ts`)**:
   - Verify lock, client release, and autonomous timeout refund on Solana devnet.

---

#### 📦 Task 4: LP-5 — Arcium Confidential Policy Cluster Run (Phase 3)
**Context:** SBF `probe.so` is compiled (423 KB) and `tests/arcium-circuit.test.ts` passes 14/14 hermetically. It needs a live Arcium cluster execution to close `FR-VAULT-008` & `FR-VAULT-009`.

**Tasks:**
1. Spin up local/devnet Arcium MPC node.
2. Run `evaluate_mandate` against encrypted mandate and proposal inputs.
3. Verify that the MPC cluster produces the boolean approval and reason code on-chain.
4. Record execution evidence in `forge/PROOF_LEDGER.md`.

---

### Recommended Execution Flow

```
[Task 1: LP-2 Wire] ──► [Task 2: LP-3 Tempo Caller] ──► [Task 3: LP-4 Solana Escrow] ──► [Task 4: LP-5 Arcium]
```

All gates must remain green at each step (`npm run typecheck`, `forge test`, `npm test`).
