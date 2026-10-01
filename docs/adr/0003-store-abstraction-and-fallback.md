# 0003. One repository interface, explicit in-memory fallback

**Status:** Accepted

## Context

`lib/store/repository.ts` claimed the in-memory `CapitalLedger` "satisfies this
interface, which is what allows the two to be swapped without touching a route".
It did not: the ledger was missing three methods and was synchronous against an
async signature. That false claim was the stated justification for the Phase 3
design, so nobody checked — and the routes kept importing `getLedger()` for the
whole of Phase 3. A durable store existed and nothing called it. Recorded as F10.

The fallback is genuinely needed: without `DATABASE_URL` a fresh clone and the
test suite still have to run.

## Decision

1. Routes depend on `EconomicRepository`, never on a concrete store.
2. `getStore()` selects the backend from `DATABASE_URL` at runtime.
3. **Every response carries `backend`.** The in-memory fallback is permitted but
   never silent — a process-local ledger that looks identical to a durable one is
   indistinguishable from a working system until the restart that loses the
   nonces.
4. The incompatibility with `CapitalLedger` is pinned by
   `tests/repository-contract.test.ts`, which asserts the ledger does *not*
   satisfy the interface, so the false claim cannot return.

## Consequences

- A reader of any API response can tell whether they are looking at durable
  state. That is the property the previous design lacked.
- `InMemoryRepository` is an adapter over the sync ledger rather than a rewrite
  of it, so existing callers and tests are untouched.
- The lesson generalises: **a comment asserting a compatibility is not evidence
  of one.** Assert it, or do not write it.
