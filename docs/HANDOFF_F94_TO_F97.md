# Handoff Specification: Defects F94 through F97

**Date:** 2026-10-09  
**Author:** Lead Agent / Antigravity  
**Target:** Coding Agent (Implementation & Verification)  
**Repository Branch:** `feat/mitra-vault-v2-reseed`  
**Applicable Standards:** [`AGENTS.md`](./AGENTS.md), [`BUILD_FOUNDRY.md`](./forge/standards/BUILD_FOUNDRY.md), [`INVARIANTS.md`](./forge/INVARIANTS.md)

---

## 1. Executive Summary & Verification Protocol

Four concrete defects (F94, F95, F96, F97) were discovered during Sprint Wave 3 (delivered by PurpleDNA in PR #34 / commit `818ee58`). Each defect is currently protected by `it.fails` canary tests in the test suite so the overall CI remains green while defects remain open.

Your task is to implement the fixes for all four defects, turn the `it.fails` canaries into passing `it` tests, preserve all invariants, and verify against the complete repository baseline suite.

### Verification Gate Commands
Before declaring completion, every gate below must pass:
1. `npm run typecheck` (0 errors)
2. `forge test` (57+ passed)
3. `cargo test --manifest-path programs/mitra-vault/Cargo.toml` (147 passed)
4. `npx vitest run tests/deliverable-binding-probe.test.ts tests/sandbox.test.ts` (all tests passing)
5. `npx vitest run` (1,330+ passed, 0 failed)
6. `DATABASE_URL="postgres://mitra:mitra@localhost:5432/mitra" npm run test:postgres` (1,377+ passed)
7. `npm run sandbox` (all commerce loops passing)

---

## 2. Defect F94 — A Submitted Deliverable is Neither Checked nor Kept

### 2.1 Problem Description & Root Cause
- **Files Affected:**
  - `lib/kernel/commerce.ts` (`evaluateDeliverable`, `applyAgreementOp`)
  - `lib/kernel/commerce-recovery.ts` (`applyAgreementOpWithSaga`)
  - `lib/commerce/commit-op.ts` (`commitAgreementOp`)
  - `lib/store/in-memory-repository.ts` & `lib/store/postgres-repository.ts`
  - `app/api/v1/agreements/route.ts`
- **Active Canary:** `tests/deliverable-binding-probe.test.ts`
- **Root Cause:**
  When a provider calls `POST /api/v1/agreements` with `op: "submitDeliverable"`, the request includes `artifactRefs: string[]` and `contentHash: string`. However:
  1. `applyAgreementOp` accepts these in `opts`, but completely ignores them and does not invoke `evaluateDeliverable(agreement, deliverable, now)`.
  2. Because `evaluateDeliverable` is never called, an empty deliverable or a submission 5 years after the agreement deadline moves the agreement to `SUBMITTED`, allowing the evaluator to release capital for an invalid job.
  3. The deliverable is never persisted to the store (`EconomicRepository` has `listDeliverables` but no active persistence method, or it's uncalled).
  4. Subsequent `GET /api/v1/agreements?agreementId=...` calls do not return what the provider signed, so the evaluator cannot inspect the actual hash or artifact references.

### 2.2 Prescribed Implementation Plan
1. **Repository & Storage Layer:**
   - In `lib/domain/types.ts`, ensure `Deliverable` is fully typed (`deliverableId`, `agreementId`, `provider`, `artifactRefs`, `contentHash`, `submittedAt`).
   - Add/verify `saveDeliverable(deliverable: Deliverable): Promise<void>` and `getDeliverable(deliverableId: string): Promise<Deliverable | null>` on `EconomicRepository`.
   - Implement `saveDeliverable` in `InMemoryRepository` and `PostgresRepository`.
   - Update `Agreement` domain type to record `deliverableId?: string` or `deliverables?: Deliverable[]`, or ensure `getAgreement` / `listAgreements` queries embed or link the submitted deliverable.
2. **Kernel Enforcement:**
   - In `applyAgreementOp` (or within `commitAgreementOp` / `applyAgreementOpWithSaga`):
     - When `op === "submitDeliverable"`, construct the `Deliverable` record.
     - Validate via `evaluateDeliverable(agreement, deliverable, now)`. If it returns `!ok`, fail closed with `fail(res.reason)` (`DELIVERABLE_EMPTY`, `DELIVERABLE_LATE`, `DELIVERABLE_HAS_NO_ARTIFACTS`, etc.).
3. **Route & Persistence:**
   - In `app/api/v1/agreements/route.ts`, ensure `op === "submitDeliverable"` requires non-empty `artifactRefs` and `contentHash` (HTTP 400 if missing or invalid).
   - In `commitAgreementOp`, persist the deliverable using `repo.saveDeliverable(deliverable)`.
   - Ensure `GET /api/v1/agreements?agreementId=...` returns the deliverable details (including `contentHash` and `artifactRefs`) so tests and evaluators can read them.
4. **Canary Resolution:**
   - In `tests/deliverable-binding-probe.test.ts`, change the three `it.fails(...)` to `it(...)` and ensure they pass. Remove or update the "today" test.

---

## 3. Defect F95 — On-Chain Escrow Over-Commit

### 3.1 Problem Description & Root Cause
- **Files Affected:**
  - `contracts/src/ERC8183/MitraJobEscrow.sol`
  - `contracts/test/ERC8183/MitraJobEscrow.t.sol`
- **Active Canary:** `tests/sandbox.test.ts:129` (`it.fails("F95: a second escrow cannot be funded by the first escrow's tokens")`)
- **Root Cause:**
  In `MitraJobEscrow.sol` line 93–106:
  ```solidity
  uint256 bal = IERC20(token).balanceOf(address(this));
  if (bal == 0) revert NothingReceived();
  received = bal > expected ? expected : bal;
  ```
  `bal` is the contract's **aggregate** token balance across all jobs.
  If Job A is funded with 30 USDC, `balanceOf(this) == 30`. When Job B calls `depositToEscrow` with `expected = 30` without transferring any tokens, `bal` is still 30. The contract records Job B as `Funded` for 30 tokens, even though zero new tokens arrived! The contract now owes 60 tokens while holding only 30.

### 3.2 Prescribed Implementation Plan
1. **Solidity Contract Accounting (`MitraJobEscrow.sol`):**
   - Introduce total allocated tracking per token:
     ```solidity
     mapping(address => uint256) public totalAllocated;
     error InsufficientDeposit(uint256 expected, uint256 available);
     ```
   - In `depositToEscrow`:
     ```solidity
     uint256 currentBalance = IERC20(token).balanceOf(address(this));
     if (currentBalance < totalAllocated[token]) revert NothingReceived();
     uint256 unallocated = currentBalance - totalAllocated[token];
     if (unallocated < expected) revert InsufficientDeposit(expected, unallocated);
     
     received = expected;
     totalAllocated[token] += received;
     ```
   - In `completeJob`:
     ```solidity
     totalAllocated[j.token] -= j.amount;
     IERC20(j.token).safeTransfer(j.provider, j.amount);
     ```
   - In `refundJob`:
     ```solidity
     totalAllocated[j.token] -= j.amount;
     IERC20(j.token).safeTransfer(j.clientVault, j.amount);
     ```
2. **Foundry Testing & Compilation:**
   - Run `forge build`.
   - Update `contracts/test/ERC8183/MitraJobEscrow.t.sol` to assert that a second `depositToEscrow` without transferring new tokens reverts with `InsufficientDeposit`.
   - Run `forge test` (all 57+ tests must pass).
3. **Canary Resolution:**
   - In `tests/sandbox.test.ts`, change line 129 from `it.fails` to `it`.
   - Remove or invert line 138 (`it("F95 today: ...")`).

---

## 4. Defect F96 — Agent ID Passed as On-Chain Evaluator Address

### 4.1 Problem Description & Root Cause
- **Files Affected:**
  - `app/api/v1/agreements/route.ts` (`runEscrowStep`, around line 524)
  - `lib/commerce/onchain-escrow.ts`
- **Active Canary:** `tests/sandbox.test.ts:149` (`it.fails("F96: an agreement whose evaluator is an agent id can be escrowed on chain")`)
- **Root Cause:**
  In `app/api/v1/agreements/route.ts:524`:
  ```typescript
  evaluator: (agreement.evaluator ?? agreement.provider) as `0x${string}`,
  ```
  `agreement.evaluator` is an agent ID string (e.g. `"sandbox_provider"` or `"agent_eval_02"`). viem rejects it when encoding calldata, failing with `409 BROADCAST_FAILED` (`Address "sandbox_provider" is invalid`).
  Crucially, `MitraJobEscrow.sol` requires:
  ```solidity
  if (msg.sender != j.clientVault && msg.sender != j.evaluator) revert NotAuthorised();
  ```
  Since the backend relayer (`rail.evm.account.address`) is the entity submitting transactions for `completeJob` and `refundJob`, if `j.evaluator` is not an address the relayer can act for (or the relayer's own address), on-chain execution reverts.

### 4.2 Prescribed Implementation Plan
1. **Evaluator Address Resolution in `app/api/v1/agreements/route.ts`:**
   - Use viem's `isAddress` to check whether `agreement.evaluator` is already an EVM address:
     ```typescript
     import { isAddress } from "viem";
     
     let evaluatorAddress: `0x${string}` | undefined;
     if (agreement.evaluator && isAddress(agreement.evaluator)) {
       evaluatorAddress = agreement.evaluator as `0x${string}`;
     } else if (rail.evm) {
       // When evaluator is a Mitra agent ID, the on-chain evaluator is the relayer account
       // which executes evaluation verdicts on chain on behalf of the agent.
       evaluatorAddress = rail.evm.account.address;
     }
     ```
   - Pass `evaluator: evaluatorAddress!` to `executeEscrowLock`.
2. **Canary Resolution:**
   - In `tests/sandbox.test.ts:149`, change `it.fails` to `it` and confirm it passes cleanly without `409 BROADCAST_FAILED`.

---

## 5. Defect F97 — Agreement/Escrow State Drift on Refund & Missing Keeper

### 5.1 Problem Description & Root Cause
- **Files Affected:**
  - `app/api/v1/agreements/route.ts` (`ESCROW_ACTION_FOR_OP`)
  - `lib/commerce/onchain-escrow.ts`
  - `lib/sandbox/index.ts` / keeper automation
- **Active Canaries:**
  - `tests/sandbox.test.ts:166` (`it.fails("F97: a refund op on an escrowed agreement refunds the escrow, so Mitra and the chain agree")`)
  - `tests/sandbox.test.ts:174` (`it.fails("F97: Mitra notices an escrow's timeout refund without a party telling it")`)
- **Root Cause:**
  1. `ESCROW_ACTION_FOR_OP` in `app/api/v1/agreements/route.ts:545` defines:
     ```typescript
     const ESCROW_ACTION_FOR_OP: Partial<Record<AgreementOp, "locked" | "released" | "refunded">> = {
       fund: "locked",
       acceptDeliverable: "released",
       rejectDeliverable: "refunded",
     };
     ```
     `refund` is completely missing! Calling `refund` updates Mitra internal agreement status to `REFUNDED`, but never triggers `runEscrowStep` with `action === "refunded"`. As a result, the on-chain escrow stays `Funded`.
  2. In the timeout case: when the timeout passes and a keeper or external caller triggers `refundJob` directly on chain, Mitra's internal agreement state remains in `EXECUTING`. There is no sync mechanism to observe that the escrow has settled as refunded.

### 5.2 Prescribed Implementation Plan
1. **Include `refund` in Escrow Op Mapping:**
   - In `app/api/v1/agreements/route.ts`:
     ```typescript
     const ESCROW_ACTION_FOR_OP: Partial<Record<AgreementOp, "locked" | "released" | "refunded">> = {
       fund: "locked",
       acceptDeliverable: "released",
       rejectDeliverable: "refunded",
       refund: "refunded", // Add this line
     };
     ```
   - Ensure that calling `refund` invokes `runEscrowStep`, executing `executeEscrowRefund` on-chain.
2. **Keeper / Timeout Sync Path:**
   - In `lib/sandbox/index.ts` (and general keeper support):
     When `sb.keeper.refundTimedOut(agreementId)` runs:
     - It calls `refundJob` on the escrow contract.
     - It must notify or transition the Mitra agreement (e.g. by dispatching a keeper-signed refund or syncing agreement status from on-chain state when reading agreement).
     - Alternatively, ensure `getAgreement` or an explicit keeper endpoint detects on-chain `JobStatus.Refunded` and marks the agreement `REFUNDED`.
3. **Canary Resolution:**
   - In `tests/sandbox.test.ts:166` and `tests/sandbox.test.ts:174`, change `it.fails` to `it` and verify both tests pass.

---

## 6. Execution Order & Checklist for Coding Agent

Follow this exact sequence to ensure clean gate compliance at each step:

- [ ] **Step 1: Resolve F96 (Evaluator Address)**
  - Edit `app/api/v1/agreements/route.ts` line 524 to check `isAddress` or fallback to `rail.evm.account.address`.
  - Flip canary in `tests/sandbox.test.ts:149`.
  - Run `npx vitest run tests/sandbox.test.ts -t "F96"`.
- [ ] **Step 2: Resolve F97 (Refund Op & Keeper Sync)**
  - Add `refund: "refunded"` to `ESCROW_ACTION_FOR_OP` in `app/api/v1/agreements/route.ts`.
  - Ensure keeper syncs agreement status when timeout refund occurs.
  - Flip canaries in `tests/sandbox.test.ts:166` and `174`.
  - Run `npx vitest run tests/sandbox.test.ts -t "F97"`.
- [ ] **Step 3: Resolve F95 (MitraJobEscrow Over-Commit)**
  - Update `contracts/src/ERC8183/MitraJobEscrow.sol` with `totalAllocated` mapping and checks.
  - Recompile with `forge build` and verify `forge test`.
  - Flip canary in `tests/sandbox.test.ts:129`.
  - Run `npx vitest run tests/sandbox.test.ts -t "F95"`.
- [ ] **Step 4: Resolve F94 (Deliverable Binding & Persistence)**
  - Implement deliverable validation in `applyAgreementOp` / `evaluateDeliverable`.
  - Ensure persistence in `InMemoryRepository` and `PostgresRepository`.
  - Expose deliverable on `GET /api/v1/agreements`.
  - Flip canaries in `tests/deliverable-binding-probe.test.ts`.
  - Run `npx vitest run tests/deliverable-binding-probe.test.ts`.
- [ ] **Step 5: Full Baseline Verification**
  - Run `npm run typecheck`
  - Run `forge test`
  - Run `cargo test --manifest-path programs/mitra-vault/Cargo.toml`
  - Run `npx vitest run`
  - Run `DATABASE_URL="postgres://mitra:mitra@localhost:5432/mitra" npm run test:postgres`
  - Run `npm run sandbox`
- [ ] **Step 6: Update Documentation**
  - Update `forge/FAILURES.md` to record F94–F97 as resolved with their commit hash and verification commands.
  - Commit cleanly with structured commit messages.
