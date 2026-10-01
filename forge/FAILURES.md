# FAILURES

Failures found, root cause, and the guard that now prevents recurrence.
A failure without a guard is a failure that will happen again.

```
FAILURE → REPRODUCTION → FIX → REGRESSION GUARD
```

---

## F1 — Expired reservations executed

**Found:** Phase 0 review. **Severity:** high (financial).

`validateExecutionBinding` never read `reservation.expiresAt`. A stale
`RESERVED`/`COMMITTED` reservation returned `ok: true`. Confirmed against seed
data `res_run496`, expired by a day.

**Root cause:** an optional field with no enforcing code. A hidden
`new Date()` inside the function also meant no caller could supply a clock, so
expiry could not be tested deterministically.

**Fix:** explicit required `now: Date` parameter; `RESERVATION_EXPIRED` check.

**Guard:** `tests/api-execution.test.ts` *expired reservation*. Mutation-verified.

## F2 — `velocityLimit` never evaluated

**Found:** Phase 0 review. **Severity:** medium.

Declared on the `Mandate` type, set on seed data, checked nowhere. A declared
control that does nothing is worse than an absent one, because it is believed
present.

**Fix:** enforced over a caller-supplied window of recent spend, derived
server-side so a caller cannot under-report it.

**Guard:** `tests/kernel.test.ts` velocity group.

## F3 — Negative amounts returned ALLOW

**Found:** Phase 0 review. **Severity:** high (financial).

Every amount guard was one-sided (`>`), so `-100` passed policy and was only
caught far downstream in `reserve()`. `NaN` also slipped past `amount <= 0`.

**Fix:** `INVALID_AMOUNT` lower bounds at both the policy and execution layers,
plus a non-finite guard in `reserve()`.

**Guard:** `tests/kernel.test.ts`; also `CHECK (amount > 0)` in the schema, so
even a bypassed caller cannot persist one.

## F4 — Reservation nonce hardcoded to 1

**Found:** Phase 1 HTTP demo. **Severity:** medium.

Every reservation used `nonce: 1`. Once one was spent, every later execution on
that vault was refused as `NONCE_ALREADY_CONSUMED` — and it *masked* the real
reason, so a wrong-chain attempt reported as a replay.

**Root cause:** a plausible-looking constant, never exercised with two
concurrent reservations.

**Fix:** `CapitalLedger.allocateNonce`; `UNIQUE (vault_id, nonce)` in Postgres.

**Guard:** two regression tests, mutation-verified against reintroducing the
constant.

**Residual:** the fix lives in the ledger, not the kernel. Both layers are now
tested so neither can be removed silently.

## F5 — Deadlock in `reserveCapital`

**Found:** Phase 3, against a real database. **Severity:** high.

The method read the vault, committed, then re-read on a *different* connection
— two connections per racer. Ten concurrent intents against a ten-connection
pool exhausted it and hung.

**Root cause:** mixing transactional and post-transaction reads on one logical
operation.

**Fix:** one pooled client for the whole transaction; `RETURNING *` plus an
in-transaction read.

**Guard:** the invariant-13 concurrency test is itself the guard — it hangs if
this regresses.

## F6 — A concurrency test that proved nothing

**Found:** Phase 3. **Severity:** high (process).

The invariant-13 test passed on the first run — for the wrong reason.
`Promise.all` over a ten-connection pool queues at `connect()` rather than
overlapping, so nothing ever contended and the assertion was trivially true.

**Root cause:** assuming concurrency from a concurrency-shaped call, without
confirming the calls actually overlapped.

**Fix:** pin the pool to one connection so racers genuinely queue at the row
lock.

**Guard:** documented prominently in `PROOF_LEDGER.md` T4 as a known weakness,
so a future refactor does not "clean it up" back into a vacuous pass.

**This is the most important entry in this file.** A test that looks like it
proves a concurrency invariant while proving nothing is worse than no test,
because it launders a risk into false assurance.

## F7 — `numeric_float_digits` on PostgreSQL 16

**Found:** Phase 3. **Severity:** low.

That GUC is PostgreSQL 17+. Setting it broke connections against the 16 server
with `unrecognized configuration parameter`.

**Fix:** removed; NUMERIC is parsed in the row mappers instead.

**Guard:** the persistence suite fails loudly on connection failure rather than
silently skipping.

## F8 — The working directory was emptied

**Found:** after Phase 3. **Severity:** critical (process).

`/home/ubuntu/mitra` was removed entirely, including `.git`. No cause
identified.

**Impact:** nothing was lost, because every commit had been pushed. Rebuilt by
cloning; the shared context was reconstructed from committed sync bundles
(19 entries, `audit ok=true`).

**Root cause:** unknown, and unresolved. Worth investigating — the same event
could target a directory that was never committed.

**Guard, partial:** the sync bundles are committed, so the team's context now
survives this class of loss. But they lived on one branch only until Phase 3,
which is itself a lesson: **artifacts that must survive belong on every branch
or on `main`.**

## F9 — Roadmap drift

**Found:** on receiving the PRD. **Severity:** medium (process).

`PHASES.md` was written before the PRD existed and defined its own phase
numbering. The PRD defines eleven different phases with different exit
conditions. Two competing truths existed about what "Phase 2" meant.

**Fix:** `forge/EXECUTION_PLAN.md` is now authoritative and reconciles the two.
`PHASES.md` is retained as a historical record, explicitly labelled.

**Guard:** `AGENTS.md` states the PRD is normative and that disagreements
belong in this file.

---

## F10 — A docstring asserted an interface compatibility that did not exist

`lib/store/repository.ts` claimed the in-memory `CapitalLedger` "satisfies this
interface, which is what allows the two to be swapped without touching a route".
It did not. Verified false by asserting the compatibility and reading the
compiler: the ledger was missing `getMandate`, `appendEvent` and `listEvents`,
and every method was synchronous against an async signature.

The claim mattered because it was the stated justification for the whole
Phase 3 design. A reader would reasonably conclude the swap was free, and would
not check — which is exactly how "the repository is wired" becomes true in the
docstring and false in the routes, which still called `getLedger()`.

**Fix.** The docstring now states the incompatibility and why. The
incompatibility is pinned by a test rather than a comment, so it cannot silently
become false again.

**Guard.** `tests/repository-contract.test.ts` asserts that the ledger does *not*
satisfy the interface, and that both real backends do.

## F11 — Canonicalizing the action digest invalidated outstanding bindings

**Found:** Phase 1, when replacing `JSON.stringify([...])` with a canonical hash.
**Severity:** high, had it shipped later.

`actionDigestFor` hashed a positional array via `JSON.stringify`, so it was
stable only while every caller passed the fields in exactly that order, and it
hashed raw floats — `0.1 + 0.2` and `0.3` are the same amount but produced
different digests. Replacing it with a domain-separated canonical hash fixed
both, and **changed the digest value**.

The first draft of the fix asserted in a comment that the value was unchanged
"because the field set and order are the same". That was not checked, and it was
false. Verifying it directly showed `sha256:ff378e4f…` before and
`sha256:c22d6a25…` after for identical input.

Every reservation holding an old binding would have failed
`ACTION_DIGEST_MISMATCH` at execution — a fund-looking freeze presented as a
cleanup.

**Why it matters more than the bug.** The false claim was in a comment
explaining a safety property. It is the same failure as F10 and F9: something
asserted because it was cheaper to assert than to check. The check took one
command.

**Fix.** Comment corrected to state the consequence. Before this ships with
real data, either re-issue outstanding reservations or accept both digests for
historical verification.

**Guard.** `tests/canonical.test.ts` pins key-order independence and float
stability; `tests/digest-compat.test.ts` records the old and new values so the
change cannot be made silently a second time.

## Open risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| No on-chain enforcement | Capital is a database row, not an enforced account | Stated `PARTIAL` in `INVARIANTS.md`; not counted as PRD Phase 2 progress. **Still open** — this is PRD Phase 2 work. |
| No withdrawal path exists | `FR-VAULT-006` holds by absence, not enforcement | Recorded `UNTESTED`, not `VERIFIED`. **Still open.** |
| Six of seven state machines unwritten | Definitions exist but nothing writes through them | Stated in `INVARIANTS.md` and `EXECUTION_PLAN.md`. **Still open** — only `reservation` has a write path. |
| ~~Ledger is process-local on the kernel path~~ **RESOLVED** | Routes now go through `getStore()`; `InMemoryRepository` / `PostgresRepository` behind one interface | `tests/persistence.test.ts` — "routes served by postgres", incl. nonce surviving a simulated restart |
