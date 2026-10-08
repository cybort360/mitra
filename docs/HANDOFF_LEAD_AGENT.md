# Mitra Lead Agent Handoff Specification
## Phase 4 Commerce & Phase 5 External Marketplace Expansion: Work Packages LP-6, LP-7, & LP-8

**Date:** 2026-10-08  
**Active Branch:** `feat/mitra-vault-v2-reseed` (In-Sync with `origin`, Tip: `1155b8b`)  
**Lead Agent Track:** Pure On-Chain Infrastructure, Dual-Write Reconciliation, External Relayers  
**Next Free Defect Identifier:** `F81`  

---

### Executive State & Separation of Concerns

Sprint Wave 3 has been strictly bifurcated to prevent developer collision:

```
┌───────────────────────────────────────────────────┬───────────────────────────────────────────────────┐
│        💜 PURPLEDNA TRACK (PP-5 to PP-8)          │           👑 LEAD AGENT TRACK (LP-6 to LP-8)      │
├───────────────────────────────────────────────────┼───────────────────────────────────────────────────┤
│ • PP-5: Developer Client SDK (@mitra/sdk)         │ • LP-6: On-Chain Escrow Wiring & Idempotency      │
│ • PP-6: Agent Inbox API & MCP Tool (GET /inbox)   │   (depositToEscrow, lock_escrow, dual-write probe)│
│ • PP-7: Sandbox CLI & Time-Travel Simulation      │ • LP-7: Hyper-Abstracted Cross-Chain Payout       │
│ • PP-8: Cognitive Agent Skills (SKILL.md bundles) │   (BNB & X Layer native payouts via relayers)     │
│                                                   │ • LP-8: Virtuals ACP Outbound Session Transport   │
└───────────────────────────────────────────────────┴───────────────────────────────────────────────────┘
```

**Pre-conditions Completed:**
- **F77 (Atomic Fund Path)**: Completed in commit `1155b8b`. `applyAgreementOpWithSaga` is synchronous and store-free; `commitAgreementOp` enforces `agreement` write before `saga` write.
- **F79 (Postgres Saga Columns)**: Explicit column list in `saveSaga` updated and dynamically derived in `tests/saga-persistence.test.ts`.
- **F80 (Committed Route Reconstruction)**: `declareSaga` records committed route bodies beside hashes so refund routes are never reconstructed from incomplete agreement refs.
- **Baselines**: `tsc` (0 errors), `forge test` (57/57 pass), `cargo test` (147/147 pass), `npx vitest run` (1,128 pass, 81 skipped), PostgreSQL 16 persistence (90/90 pass).

---

### 1. Non-Negotiable Ground Rules (`AGENTS.md`)

1. **Repository Files Are Truth**: Prior chat summaries are non-authoritative.
2. **The Mechanism to Protect**:
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   $$\text{Mandate} \longrightarrow \text{Policy Engine} \longrightarrow \text{Execution Guard}$$
   An `ALLOW` decision is never permission to move value; nonces are single-use.
3. **Dual-Write Discipline & Zero Stranded Capital**:
   Never broadcast an on-chain transaction that cannot be reconciled upon failure. Every chain call must be preceded by an idempotency probe.
4. **Pre-Committed Recovery (PRD §15.5)**:
   Every escrow deposit must commit `refundRouteHash` at funding time.
5. **Zero Mocks in Production**:
   Offline suites test projection and logic. Live suites connect to real testnets (`Base Sepolia`, `Tempo Moderato`, `Solana Devnet`). Production code never returns synthetic transaction hashes.

---

### 2. Lead Agent Active Queue (Work Packages LP-6 to LP-8)

---

#### 📦 Package LP-6: On-Chain Escrow Wiring & Idempotency Engine
- **Context**: PRD §14 & Phase 4 ("Commerce"). The contracts (`MitraJobEscrow.sol` on Base Sepolia `0xc49c93f0...` and Tempo Moderato `0x95ca2170...`, and `programs/mitra-vault` on Solana Devnet `GkQQtmVXtG...`) are deployed and tested in isolation. Currently, `app/api/v1/agreements/route.ts` records `onChainEscrow` in the database but **does not trigger on-chain deposits**.
- **Deliverables**:
  1. **Escrow Bridge Module (`lib/commerce/onchain-escrow.ts`)**:
     - `probeEscrowStatus(repo, agreementId, onChainEscrow)`:
       - EVM: Uses `ERC8183Transport.getJob(jobId)`. Returns `{ funded: boolean, amount, provider, refundRouteHash }`.
       - Solana: Derives `escrowPda(vault, jobId)` via `jobIdFor(agreementId)` and inspects account via `connection.getAccountInfo`. Decodes with `decodeJobEscrow`.
     - `executeEscrowLock(agreement, onChainEscrow, rails)`:
       - Deterministic `jobId = jobIdFor(agreement.agreementId)`.
       - **Idempotency Check**: If already funded on-chain with matching terms, returns `{ txHash: "ALREADY_FUNDED", skipped: true }`.
       - **EVM Execution**:
         - Spend authorization permit issued via Policy Engine.
         - Relayer (`MITRA_EVM_SETTLEMENT_KEY_FILE`) submits `spendAuthorized` to move tokens from Vault to Escrow.
         - Relayer calls `depositToEscrow(jobId, clientVault, provider, evaluator, token, expected, timeout, refundRouteHash)`.
       - **Solana Execution**:
         - Client/Authority keypair signs `lock_escrow` transaction creating Escrow PDA and transferring lamports.
     - `executeEscrowRelease(agreement, rails)`:
       - On `acceptDeliverable`: Calls `completeJob(jobId)` on EVM or `release_escrow` on Solana.
     - `executeEscrowRefund(agreement, rails)`:
       - On `rejectDeliverable` / timeout: Calls `refundJob(jobId)` on EVM or `refund_escrow` on Solana using the pre-committed refund route.
  2. **Agreement Route Integration (`app/api/v1/agreements/route.ts`)**:
     - On `op === "fund"` with `body.onChainEscrow`:
       - Run `executeEscrowLock`.
       - If on-chain succeeds, invoke `commitAgreementOp(...)`.
       - If DB commit fails, log error: subsequent retry probes on-chain state, detects existing funding, and heals DB.
     - On `op === "acceptDeliverable"`: Trigger `executeEscrowRelease`.
     - On `op === "rejectDeliverable"`: Trigger `executeEscrowRefund`.
  3. **Tests (`tests/agreement-onchain-escrow.test.ts`)**:
     - Hermetic suite with mocked transports verifying the read-before-write probe and idempotency recovery on crash.
     - Opt-in live testnet suite gated on `JOB_ESCROW_LIVE=1`.

---

#### 📦 Package LP-7: Hyper-Abstracted Cross-Chain Payout Relayer Adapter
- **Context**: PRD §16 & Phase 5/8 ("Settlement Rails & External Marketplaces"). Counterparties on external chains (e.g. BNB Chain, X Layer, Polygon) provide services, but Mitra **never deploys unverified vaults on non-canonical chains**. Escrows remain on Base Sepolia, Tempo Moderato, or Solana Devnet. Upon deliverable acceptance, a payout relayer routes native currency to the external counterparty while anchoring canonical receipts on deployed networks.
- **Deliverables**:
  1. **Cross-Chain Relayer Adapter (`lib/adapters/cross-chain-payout.ts`)**:
     - Interface `CrossChainPayoutRelayer`:
       - `quoteBridgeFee(sourceChain, targetChain, asset, amount)`
       - `executeCrossChainPayout(input: { agreementId, sourceChain, targetChain, recipientAddress, amount, asset })`
     - Implements payout bridging via Across / LiFi / CCTP abstracted relayer transport.
     - Automatically verifies recipient address format (EVM checksum on BNB/X Layer).
  2. **Canonical Mitra Receipt Anchoring**:
     - Generates `MitraReceipt` with status `SETTLED_EXTERNALLY`.
     - Pins the bridge intent transaction hash and destination execution receipt to the Mitra agreement run log on Base/Solana.
  3. **Settlement Route Integration (`app/api/v1/settlements/route.ts`)**:
     - Recognizes external payees (`payTo.chain === "bnb" | "xlayer"`).
     - Debits the canonical vault/escrow on Base/Solana, passes funds to relayer, and anchors external settlement.
  4. **Tests (`tests/cross-chain-payout.test.ts`)**:
     - Unit tests verifying external address validation, slippage/fee guards, and canonical receipt hashing.

---

#### 📦 Package LP-8: Virtuals ACP Outbound Session Key Transport
- **Context**: PRD §22 & Phase 5 ("Agent Ecosystem"). `lib/adapters/virtuals.ts` provides complete data translation between Mitra Agreements and Virtuals Agent Communication Protocol (ACP) offerings, but currently requires an injected client.
- **Deliverables**:
  1. **Live ACP Transport (`lib/adapters/virtuals-transport.ts`)**:
     - Class `VirtualsHttpTransport implements VirtualsClient`:
       - Connects to Virtuals ACP gateway endpoints.
       - Manages **Session Keys**: signs outbound agent gig proposals and bids using delegated agent session keys without exposing the vault authority key.
       - Polls / streams ACP job status transitions via SSE.
       - Implements automatic retries with exponential backoff.
  2. **Adapter Connection (`lib/adapters/virtuals.ts`)**:
     - Wires `VirtualsHttpTransport` as default transport when `VIRTUALS_API_KEY` and `VIRTUALS_AGENT_SESSION_KEY` are provided in the environment.
  3. **Tests (`tests/virtuals-transport.test.ts`)**:
     - Contract tests against recorded ACP responses and simulated network disconnects.

---

### 3. Execution Sequencing for the Lead Agent

```
Phase 1: Package LP-6 (Escrow Route Wiring & Idempotency)
  Step 1.1: Create lib/commerce/onchain-escrow.ts with probeEscrowStatus & executeEscrowLock.
  Step 1.2: Wire app/api/v1/agreements/route.ts (fund, accept, reject).
  Step 1.3: Create tests/agreement-onchain-escrow.test.ts & verify dual-write recovery.
  Step 1.4: Run typecheck, forge test, cargo test, and vitest.

Phase 2: Package LP-7 (Cross-Chain Payout Relayer)
  Step 2.1: Implement lib/adapters/cross-chain-payout.ts.
  Step 2.2: Wire external chains into lib/settlement/rails.ts and app/api/v1/settlements/route.ts.
  Step 2.3: Create tests/cross-chain-payout.test.ts.

Phase 3: Package LP-8 (Virtuals ACP Outbound Transport)
  Step 3.1: Implement lib/adapters/virtuals-transport.ts with session key signing.
  Step 3.2: Wire default transport in lib/adapters/virtuals.ts.
  Step 3.3: Create tests/virtuals-transport.test.ts.
```

---

### 4. Verification Gate

Every package commit must pass:
1. `npm run typecheck` $\rightarrow$ 0 errors.
2. `forge test` $\rightarrow$ 57/57 passed.
3. `cargo test --manifest-path programs/mitra-vault/Cargo.toml` $\rightarrow$ 147/147 passed.
4. `npx vitest run` $\rightarrow$ all existing tests green (1,128+ passed).
5. `npm run test:postgres` $\rightarrow$ 90/90 passed against real PostgreSQL 16.
6. Record evidence in `forge/PROOF_LEDGER.md` and any newly discovered defects in `forge/FAILURES.md`.
