# Mitra Lead Coding Agent Handoff
## Target Phases: Phase 4 (Decoupled Commerce), Phase 5 (Intent Substrate), Phase 6 (Solana Parity), Phase 9 (Tempo Parity), Phase 3 (Arcium)

**Date:** 2026-10-06  
**Current Branch:** `feat/mitra-vault-v2-reseed`  
**Shared Context Tip:** Seq 102 (`e297112e...`)  
**Keys Location:** `.dev-keys/evm-testnet.key` (EVM: `0xAeA8...`), `.dev-keys/solana-testnet.json` (Solana)  

---

### Ground Rules & Non-Negotiable Invariants

1. **Repository Files Are Truth**: Prior chat summaries are non-authoritative (`AGENTS.md`).
2. **The Mechanism to Protect**:
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   An `ALLOW` decision is never permission to move value. The execution guard independently re-derives whether this exact instruction may move capital.
3. **Decoupled Architecture**: Do not bloat `MitraVault.sol`. The vault is a pure capital boundary (`deposit`, `withdraw`, `spendAuthorized`). Escrow and commercial job logic belong in `MitraJobEscrow.sol`.
4. **Multi-Chain Parity — Do Not Exclude Tempo**: Every EVM deployment and rail must support **both Base Sepolia (84532) and Tempo Moderato (42431)**:
   - Base Sepolia: USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 dec).
   - Tempo Moderato: PathUSD (`0x20c0000000000000000000000000000000000000`, 6 dec, TIP-20).
5. **Pre-Committed Recovery (PRD §15.5)**: Every compensation route (`refundJob`) must be hash-committed at funding time. Never synthesize post-failure calldata.
6. **Strict Evidence Discipline (BUILD_FOUNDRY §2)**: Record un-truncated 66-character transaction hashes and block numbers.

---

### Work Package LP-1: Intent Persistence Substrate (Phase 5 Prereq)

**Objective:** Provide a durable store for commercial intents so Purple's MCP tools (`mitra_create_intent`, `mitra_get_intent`) can read and write without using memory stubs.

**Files to modify:**
- `lib/store/repository.ts` — Add methods to `EconomicRepository`:
  - `createIntent(intent: Intent): Promise<Intent>`
  - `getIntent(id: string): Promise<Intent | null>`
  - `listIntents(filter?: { principal?: string; agentId?: string }): Promise<Intent[]>`
- `lib/store/postgres.ts` — Implement `intents` table and queries with PostgreSQL 16 compatibility.
- `lib/store/schema.ts` — Add `CREATE TABLE IF NOT EXISTS intents (...)`.
- `lib/store/provider.ts` — Implement in `InMemoryRepository`.
- `app/api/v1/intents/route.ts` — REST endpoint (`POST` to create, `GET` to list).
- `app/api/v1/intents/[id]/route.ts` — REST endpoint (`GET` by ID).
- `tests/intent-persistence.test.ts` — Comprehensive unit and round-trip tests.

---

### Work Package LP-2: Decoupled ERC-8183 Job Escrow Contract (Base + Tempo) (Phase 4)

**Objective:** Build, test, and deploy a decoupled commercial job escrow contract on **both Base Sepolia and Tempo Moderato**, replacing the god-contract pattern in `MitraVault`.

**Implementation Details:**
1. **Solidity Contract (`contracts/src/ERC8183/MitraJobEscrow.sol`)**:
   - Implements ERC-8183 job lifecycle: `(jobId, clientVault, provider, evaluator, token, amount, timeout, status)`.
   - `depositToEscrow(bytes32 jobId, address clientVault, address provider, address evaluator, address token, uint256 amount, uint64 timeout)`:
     - Called when `MitraVault.spendAuthorized()` sends funds to `MitraJobEscrow`.
   - `completeJob(bytes32 jobId)`:
     - Callable by `clientVault` owner or `evaluator`.
     - Transfers `amount` of `token` to `provider`.
   - `refundJob(bytes32 jobId)`:
     - Callable if `block.timestamp >= timeout` or if client rejected.
     - Transfers `amount` of `token` back to `clientVault` and invokes `MitraVault.deposit(token, amount)`.
2. **Foundry Test Suite (`contracts/test/MitraJobEscrow.t.sol`)**:
   - Test deposit from vault, client approval, evaluator approval, timeout refund, reentrancy guards, and invalid state transitions.
3. **Deployments**:
   - Deploy script: `scripts/deploy-job-escrow.mjs base|tempo`.
   - Deploy to **Base Sepolia (84532)** and **Tempo Moderato (42431)** using `.dev-keys/evm-testnet.key`.
   - Record addresses in `lib/evm/deployments.json` under `jobEscrow.baseSepolia` and `jobEscrow.moderato` with CAIP-10 IDs.
4. **Adapter Wiring**:
   - Update `lib/adapters/erc8183.ts` to interact with the deployed `MitraJobEscrow` contracts.
   - Test via `tests/commerce-lifecycle.test.ts`.

---

### Work Package LP-3: Tempo Settlement Parity & MPP Metadata (Phase 9)

**Objective:** Ensure that any Mitra obligation can target Tempo settlement through the common API with full payment metadata.

**Implementation Details:**
1. **Obligation Routing**:
   - Ensure `POST /api/v1/settlements` routes obligations with `chain: "tempo"` automatically through `TempoSettlementAdapter` and `MitraVault.sol` (`0x85409dfc...`) without manual env flags.
2. **Payment Metadata & Receipt Mapping**:
   - Verify that TIP-20 `transferWithMemo` commits the exact `actionHash` (keccak256 digest of `agreementId` / `epochId`) into the on-chain transaction memo.
   - Confirm receipt parser decodes `Transfer` logs and fee deductions (`0.000032` fee) without false failures (F40).
3. **Tests**:
   - `tests/tempo-obligation.test.ts`: Verify full lifecycle of an obligation targeting Tempo Moderato.

---

### Work Package LP-4: Solana Job Escrow & Autonomous Recovery (Phase 6)

**Objective:** Replicate the autonomous timelocked escrow recovery primitive on Solana devnet so Solana achieves parity with Base and Tempo.

**Implementation Details:**
1. **Solana Program Updates (`programs/mitra-vault/src/lib.rs`)**:
   - Add Job Escrow PDA: `seeds = [b"escrow", vault.key().as_ref(), job_id.as_ref()]`.
   - Instruction `lock_escrow(job_id, provider, amount, timeout)`:
     - Moves `available -> escrowed` inside vault or dedicated escrow PDA.
   - Instruction `release_escrow(job_id)`:
     - Client authority releases escrow to `provider`.
   - Instruction `refund_escrow(job_id)`:
     - Autonomous timeout recovery: if `Clock::get()?.unix_timestamp >= timeout`, anyone can trigger refund to return escrowed capital to vault `available`.
2. **Build & Deploy**:
   - `cargo-build-sbf --tools-version v1.57 --arch v1`.
   - Deploy/upgrade on Solana devnet using `.dev-keys/solana-testnet.json`.
3. **Tests**:
   - Add unit tests in `programs/mitra-vault/tests/` and live test in `tests/solana-escrow.test.ts`.

---

### Work Package LP-5: Arcium Confidential Policy Cluster Run (Phase 3)

**Objective:** Execute `evaluate_mandate` on encrypted inputs using a real Arcium MPC cluster to close `FR-VAULT-008` and `FR-VAULT-009`.

**Implementation Details:**
1. Connect to local or testnet Arcium MPC node.
2. Feed encrypted mandate and spending proposal into `target/deploy/probe.so`.
3. Verify that the MPC cluster outputs the boolean decision without decrypting inputs.
4. Record execution evidence in `forge/PROOF_LEDGER.md`.

---

### Execution Order

1. **LP-1 (Intent Substrate)**: Complete first to unblock Purple's MCP tools.
2. **LP-2 (Decoupled Escrow on Base & Tempo)**: Deploy contracts and bind adapter.
3. **LP-3 (Tempo Parity)**: Wire automatic obligation routing on Tempo.
4. **LP-4 (Solana Escrow)**: Build and deploy on devnet.
5. **LP-5 (Arcium MPC)**: Run cluster verification.
