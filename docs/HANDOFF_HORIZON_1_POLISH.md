# Handoff Specification: Horizon 1 Polish & Control Plane Reconciliation (Option B)

**Date:** 2026-10-09  
**Author:** Lead Agent / Antigravity  
**Target:** Coding Agent (Implementation & Verification)  
**Repository Branch:** `feat/mitra-vault-v2-reseed`  
**Applicable Standards:** [`AGENTS.md`](./AGENTS.md), [`BUILD_FOUNDRY.md`](./forge/standards/BUILD_FOUNDRY.md), [`INVARIANTS.md`](./forge/INVARIANTS.md)

---

## 1. Executive Summary & Objectives

With the core sprint deliverables (LP-6..LP-8, PP-5..PP-8) merged and defects F94 through F98 fully resolved (commit `75e4864`), this handoff addresses **Horizon 1 Polish & Control Plane Reconciliation**.

This packet covers four concise, self-contained tasks:
1. **Task 1: Eliminate `sagasToPersist` JSON leak in `app/api/v1/agreements/route.ts`.**
2. **Task 2: Remove F94 / F96 workarounds in `lib/sandbox/index.ts`.**
3. **Task 3: Implement pre-authorized mandate seeding in `lib/sandbox/index.ts`.**
4. **Task 4: Reconcile control plane documentation (`forge/EXECUTION_PLAN.md`, `forge/PROOF_LEDGER.md`, `forge/FAILURES.md`).**

### Verification Protocol
Before declaring completion, run and confirm:
```bash
npm run typecheck
forge test
cargo test --manifest-path programs/mitra-vault/Cargo.toml
npx vitest run
DATABASE_URL="postgres://mitra:mitra@localhost:5432/mitra" npm run test:postgres
npm run sandbox
```

---

## 2. Task 1: Eliminate `sagasToPersist` JSON Response Leak

### 2.1 Problem & Root Cause
In `app/api/v1/agreements/route.ts:392-403`:
```typescript
return NextResponse.json({
  data: {
    ...opResult.value,
    agreement: {
      ...opResult.value.agreement,
      availableOps: availableAgreementOps(opResult.value.agreement.status),
    },
  },
  backend,
  evidenceLevel: "LOCAL_PASS",
});
```
`opResult.value` is of type `CoupledResult` (`lib/kernel/commerce-recovery.ts`), which contains:
```typescript
export interface CoupledResult {
  space: Space;
  agreement: Agreement;
  saga?: Saga;
  sagasToPersist: Saga[]; // Internal write-set intended strictly for store persistence
}
```
Spreading `...opResult.value` leaks `sagasToPersist` into the public JSON response. While harmless today, it exposes internal database write-sets as unintended API surface that clients might couple to.

### 2.2 Prescribed Implementation
1. In `app/api/v1/agreements/route.ts`:
   Explicitly destructure only the intended client-facing fields:
   ```typescript
   const { space, agreement, saga } = opResult.value;
   return NextResponse.json({
     data: {
       space,
       agreement: {
         ...agreement,
         availableOps: availableAgreementOps(agreement.status),
       },
       ...(saga ? { saga } : {}),
     },
     backend,
     evidenceLevel: "LOCAL_PASS",
   });
   ```
2. In `tests/agreements-api.test.ts`:
   Add an explicit assertion on an agreement operation response asserting that `body.data.sagasToPersist` is `undefined`:
   ```typescript
   expect(body.data).not.toHaveProperty("sagasToPersist");
   ```

---

## 3. Task 2: Remove Post-F94 / F96 Sandbox Workarounds

### 2.1 Problem & Root Cause
In `lib/sandbox/index.ts`:
Before F94 and F96 were resolved, the sandbox used two workarounds:
1. Provider handed artifact refs and hash to the evaluator via an out-of-band `handover` map because Mitra previously discarded deliverables (F94).
2. The evaluator agent was named by the relayer's address because route code previously failed when given an agent ID string (F96).

Now that F94 persists deliverables on the agreement and F96 resolves agent IDs to `rail.evm.account.address`, these workarounds are obsolete and can be cleaned up.

### 2.2 Prescribed Implementation
1. In `lib/sandbox/index.ts`:
   * Remove the obsolete workaround comments in lines 15–21.
   * In `evaluatorTurn()` (lines 173–197), retrieve deliverable details directly from the agreement or inbox rather than requiring the in-memory `handover` map fallback.
   * Ensure `handover` is kept only if needed for test introspection, or remove it.
2. Verify via `npm run sandbox` and `npx vitest run tests/sandbox.test.ts`.

---

## 4. Task 3: Implement Pre-Authorized Mandate Seeding in Sandbox

### 3.1 Problem & Motivation
PurpleDNA noted in `seq 132` (loose ends) that the sandbox seeds 100,000 sandbox USDC, but seeds zero mandates. Consequently, the sandbox only exercises `POST /api/v1/agreements` directly, but never exercises the full authority hierarchy:
$$\text{Mandate} \longrightarrow \text{Authorization} \longrightarrow \text{Intent} \longrightarrow \text{Agreement}$$

### 3.2 Prescribed Implementation
1. In `lib/sandbox/index.ts`:
   Add a helper `seedMandates()`:
   * Registers a default 100,000 USDC Mandate for `client.agentId` granted to `client.agentId` (or an operator authority) with capability `"research"` and `"payment"`.
   * Stores the mandate in the repository (`repo.createMandate` or `repo.createAuthorization`).
2. Expose `mandates` on the returned sandbox object.
3. In `tests/sandbox.test.ts`, add a test confirming that sandbox clients can query their active mandate/authorization without errors.

---

## 5. Task 4: Reconcile Control Plane Documentation

### 5.1 F65 Reconciliation
* In `app/api/v1/intents/route.ts:55-75`, first-write-wins idempotency is already implemented: identical bodies return `200`, mismatched bodies return `409 INTENT_EXISTS`.
* In `forge/FAILURES.md` under `## F65`:
  Change status from `open` to `fixed (2026-10-06, first-write-wins with 409 INTENT_EXISTS; verified in tests/sdk.test.ts)`.
* In `forge/EXECUTION_PLAN.md` Phase 5 row:
  Remove `"Open: F65 (intent overwrite, lead)"`.
* In `forge/PROOF_LEDGER.md` line 324 and 444:
  Update the blocker description to reflect that F65 is resolved.

### 5.2 Record F94–F98 Closure
In `forge/FAILURES.md`:
Ensure F94, F95, F96, F97, and F98 are marked `fixed (commit 75e4864)` with their verification evidence (`typecheck 0`, `forge 63/63`, `cargo 147/147`, `vitest 1329`, `postgres 1377`, `sandbox end-to-end`).

### 5.3 Clearing Epoch Authorization Note (Seq 132 Item 4)
Document in `forge/ARCHITECTURE.md` §Clearing:
Clarify that `open_epoch`, `calculate_epoch`, `challenge`, and `finalize_epoch` are permissionless by design per PRD §16 (anyone can verify deterministic netting and dispute malformed cycles). Capital protection is enforced not at epoch finalization, but when the resulting residual payments are executed against the vault, where the execution guard re-verifies headroom, nonces, and signatures.

---

## 6. Execution Checklist

- [ ] **Step 1:** Edit `app/api/v1/agreements/route.ts` to destructure and omit `sagasToPersist`. Add test assertion in `tests/agreements-api.test.ts`.
- [ ] **Step 2:** Clean up outdated F94/F96 comments and redundant `handover` logic in `lib/sandbox/index.ts`.
- [ ] **Step 3:** Implement `seedMandates()` in `lib/sandbox/index.ts` and add validation in `tests/sandbox.test.ts`.
- [ ] **Step 4:** Reconcile `forge/EXECUTION_PLAN.md`, `forge/PROOF_LEDGER.md`, and `forge/FAILURES.md` for F65 and F94–F98.
- [ ] **Step 5:** Run full verification protocol:
  ```bash
  npm run typecheck
  forge test
  cargo test --manifest-path programs/mitra-vault/Cargo.toml
  npx vitest run
  DATABASE_URL="postgres://mitra:mitra@localhost:5432/mitra" npm run test:postgres
  npm run sandbox
  ```
- [ ] **Step 6:** Commit cleanly with message `chore: Horizon 1 polish — response leak fix, sandbox mandate seeding, control plane reconciliation`.
