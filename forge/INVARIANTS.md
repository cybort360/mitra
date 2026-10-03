# INVARIANTS

The properties that must never break. This file is the merge point between the
product specification and the code.

**Sources of truth, in precedence order:**

1. `docs/product/MITRA_PRD.md` §52.5 — the normative FR/NFR register
2. `docs/SECURITY.md` — the original cross-state invariants
3. Executable proof in `forge/PROOF_LEDGER.md`

The PRD is normative. Where `docs/SECURITY.md` says something the PRD does not,
that is recorded below as a **reconciliation note**, not silently resolved.

---

## The one mechanism to protect

> **An ALLOW decision is never itself permission to move value.**

Every other property is a consequence of this one. The policy engine decides
*whether an action is permitted*; the execution guard independently re-derives
*whether this exact instruction may move capital*. Merging them is the single
failure that converts an authorization system into an authorization
decoration.

```
Intent → evaluateProposal → ALLOW|DENY → reserve → validateExecutionBinding → movement
                                    ↑                              ↑
                          decides permission            decides execution
```

An `ALLOW` that skips the second gate is not a weaker guarantee. It is no
guarantee at all.

## Status vocabulary

Per `BUILD_FOUNDRY.md`, claims carry exactly one of:

`UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`

`UNTESTED` is the default. It is not a failure state — it is the honest state,
and it is what every claim starts in.

---

## I. Vault and capital

| ID | Invariant | PRD | Status | Proof |
|---|---|---|---|---|
| FR-VAULT-002 | Total balance distinct from spendable balance | §6.7 | `VERIFIED` | `tests/kernel.test.ts` → vault invariants |
| FR-VAULT-004 | Reservations prevent aggregate overspend under concurrency | §6.5 | `VERIFIED` | `tests/persistence.test.ts` → *concurrent intents*; 10 racers, capital for 3, exactly 3 granted |
| — | Reported spendable capital never exceeds actual available | §6.7 | `VERIFIED` | `reconcileVault` assertion + `CHECK (>= 0)` on every bucket |
| FR-VAULT-007 | Vaults support freeze semantics | §6.4 | `PARTIAL` | `emergency_freeze` blocks reservation; no emergency path exercised end-to-end |
| FR-VAULT-001 | Explicit capital boundary for autonomous spending | §1.2 | `PARTIAL` | Local only. No on-chain vault controller (PRD Phase 2) |

**Reconciliation note.** The PRD requires a *real enforced* boundary. A local
Postgres row lock enforces capital correctly but is not a custody boundary — an
operator with database access can move funds without passing the guard. The
invariant is satisfied *mechanically* and not *cryptographically*. That is
recorded as `PARTIAL` deliberately; the distinction is the point of the evidence
model.

## II. Authority

| ID | Invariant | PRD | Status | Proof |
|---|---|---|---|---|
| FR-VAULT-005 | Execution validates the exact action digest approved by policy | §1.3 | `VERIFIED` | `tests/api-execution.test.ts` → *tampered action digest* |
| FR-CORE-005 | Replay-sensitive actions carry nonce and expiry | §6.5 | `VERIFIED` | `*replayed nonce*` + `UNIQUE (vault_id, nonce)` survives restart |
| — | An expired reservation cannot execute | §6.5 | `VERIFIED` | `*expired reservation*` → `RESERVATION_EXPIRED` |
| FR-VAULT-006 | Agent authority does not imply principal withdrawal authority | §6.4 | `VERIFIED` — on-chain path | `programs/mitra-vault/tests/withdraw.rs` (16 tests). Withdrawal is authority-only, re-derived from vault data, refuses reserved capital, and is refused while frozen. See F41 |
| — | A FROZEN vault cannot be drained by withdrawal | §6.4 | `VERIFIED` | `withdraw.rs` → *a frozen vault refuses withdrawal* + *handler refuses withdrawal from a frozen vault*. This was **false before F41** |
| FR-VAULT-008 | Confidential policy optional where not required, enforced where it is | §10 | `UNTESTED` | `confidentialPolicy` exists on the type; no enclave |
| FR-VAULT-009 | Enclave decision bound to policy version, vault, mandate, digest, expiry, nonce | §10 | `UNTESTED` | PRD Phase 3 (Arcium) |

**Reconciliation note — FR-VAULT-006 (rewritten after F41).** This entry previously
read:

> The invariant holds by *absence*: there is no withdrawal route at all.

**That was false.** `withdraw` has been in `programs/mitra-vault/src/lib.rs` the
whole time; what was missing was a *test*, not a path. The note therefore described
an absence that did not exist, which is worse than recording nothing — it
discharged the invariant by asserting a state of the world that had never been
checked.

Testing it immediately found a real defect: `withdraw` performed its arithmetic
inline in the handler and, unlike its sibling `reserve`, **did not check
`is_frozen()`**. A frozen vault could be drained. The emergency control meant to
stop value leaving did not stop the one operation it most needed to.

The rules now live in `Vault::withdraw`, so they are state-level and cannot be
bypassed by a handler doing its own arithmetic. Evidence
(`evidence: VERIFIED, blocker: —`) rests on 16 tests, two of which drive the real
`dispatch` with real `AccountInfo`s — because type tests alone left the entire
suite green against a handler that bypassed the fix entirely (see F41).

**Still not claimed:** `invoke_signed` and genuine lamport ownership are untested
in-process; those need a chain, and `scripts/vault-devnet.mjs` is the counterpart.

## III. Commerce and obligations

| ID | Invariant | PRD | Status |
|---|---|---|---|
| FR-COM-001 | Commercial terms distinct from payment transport | §12, §13 | `VERIFIED` | `tests/commerce-escrow.test.ts` → *terms are independent of transport*: an `Agreement` records no chain, rail or transport, and the same terms are admitted identically regardless of the Space's allowed rails |
| FR-COM-002 | Escrow release depends on agreement/deliverable state | **§13.4** (was §12) | `VERIFIED` | `tests/commerce-escrow.test.ts` → *acceptance releases the committed amount*, *refund releases the committed amount*, *a Space can fund its budget repeatedly*. **Was false — see F42** |
| FR-COM-003 | Duplicate delivery/evaluation events cannot cause duplicate capital release | **§13.4** (was §12) | `VERIFIED` | `tests/commerce-escrow.test.ts` → *a chargeback after acceptance does not return the budget twice*, plus replay and duplicate-evaluation cases. The chargeback test kills a guard-removal mutation; see F42 |
| — | A Space's budget is a concurrency limit, not a lifetime cap | §13.1 | `VERIFIED` | 12 sequential accepted agreements against a 100 budget. **Was false — see F42** |
| — | A rejected deliverable cannot trigger normal payment release | SECURITY.md | `VERIFIED` | `tests/security-invariants.test.ts` → *a rejected deliverable cannot be accepted afterwards*; *settlement is refused until the agreement is ACCEPTED*. Structurally guaranteed: the machine has no `REJECTED -> ACCEPTED` edge, and the test pins that table |
| — | An agreement cannot settle against a different provider without reassignment | SECURITY.md | `VERIFIED` — guard added | `assertSettlementBinding` **did not exist**; `SettlementAdapter.settle()` did not even carry a provider. Now matched exactly, with an impostor-case test. Mutation check: removing the guard fails 5 |

## IV. Recovery

| ID | Invariant | PRD | Status |
|---|---|---|---|
| — | A non-idempotent compensation route cannot execute twice | SECURITY.md | `VERIFIED` — guard added | `maxAttempts` was checked against a CALLER-supplied array the kernel never decremented, so the limit was advisory. `Saga.routeAttempts` now tracks it. `tests/security-invariants-2.test.ts`; mutation removes 2 |
| — | `RECOVERED`, `CONTAINED`, `ABORTED` remain semantically distinct | §14 | `VERIFIED` — `tests/machines.test.ts` proves none is reachable from another |
| — | Failure is a state transition, not an exception | §4.5 | `VERIFIED` | `tests/commerce-saga.test.ts` → a rejected deliverable drives the saga `EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED` with zero unhandled exceptions. **F50a:** four recovery functions typed `Result` but threw. Mutation: arming without stepping fails 6 tests |

## V. Netting and clearing

| ID | Invariant | PRD | Status | Proof |
|---|---|---|---|---|
| FR-CLEAR-003 | Disputed obligations are never silently included in the net result | §19 | `VERIFIED` | `netObligations` excludes `DISPUTED`/`DEFAULTED` and reports them in `excluded` |
| — | Net positions sum to zero | — | `VERIFIED` | `*conserves value*` |
| — | Netting is deterministic and order-independent | — | `VERIFIED` | `*is deterministic*` — reversed input, identical output |
| — | An obligation enters at most one finalized clearing epoch | SECURITY.md | `VERIFIED` — guard added | `finalizeEpochOnce` refuses an obligation already in a FINALIZED epoch. Only finalized counts: an OPEN/CHALLENGE epoch holds it provisionally, so two may be prepared at once |
| — | A settlement receipt binds to the exact cleared obligation set | SECURITY.md | `VERIFIED` — guard added | `settlementReceiptHash` binds settlementId + epochId + resultHash + the transfers themselves. Order-insensitive; amount/epoch/result changes all change it |

## VI. Settlement and integration

| ID | Invariant | PRD | Status |
|---|---|---|---|
| FR-SETTLE-004 | No claim of atomic cross-chain settlement unless implemented and verified | §21 | `VERIFIED` — settlement adapter throws `UnconfiguredAdapterError`; no such claim is made |
| FR-INT-002 | MCP remains the control surface and cannot bypass authority | §24 | `PARTIAL` — the shared-context server holds notes, not authority; it cannot move capital |
| — | Settlement chain and asset match authorized terms | SECURITY.md | `VERIFIED` — `CHAIN_MISMATCH` / `ASSET_MISMATCH` |
| — | External identities cannot be silently remapped | SECURITY.md | `VERIFIED` — guard added | `marketplaceRefs` was a plain array. `assertNoIdentityRemap` / `mergeRefs` refuse a `(system,id)` already bound to another agent |

## VII. Evidence honesty

These constrain how we are *allowed to speak*, not how the system behaves. They
are the invariants most easily violated by accident.

| ID | Rule | Status |
|---|---|---|
| NFR-005 | Never represent mocked or simulated evidence as live economic proof | `VERIFIED` — every mutation route returns `evidenceLevel: LOCAL_PASS` and an explicit "no chain transaction" note |
| — | Unconfigured integrations must report themselves as unconfigured | `VERIFIED` — `UnconfiguredAdapterError`; `createPool` refuses to default |
| — | Tests self-skip rather than pass vacuously | `VERIFIED` — persistence tests warn and skip without `DATABASE_URL` |
| — | Evidence levels `DESIGN_ONLY · LOCAL_PASS · TESTNET_PASS · LIVE_PUBLIC_PASS · PRODUCTION_PASS` | `VERIFIED` — `docs/EVIDENCE.md` |

---

## Unresolved conflicts

Raised rather than resolved, because each is a product decision:

1. **`docs/SECURITY.md` states a rule the PRD does not number:** "Available
   vault capital must reflect reservations, escrow, encumbrances, settling
   balances and freezes." The PRD says this in prose (§6.7) but not as a
   numbered requirement. Recommend promoting it to `FR-VAULT-002b` rather than
   leaving prose that can drift.

2. **The PRD's Phase 2 exit condition is on-chain proof; our recent work has
   been local.** Postgres is defensible engineering and was not requested by the
   roadmap. It is retained because it makes the concurrency and durability
   properties testable, but it is **not** progress toward the PRD's Phase 2 exit
   condition and must not be counted as such.

3. **Six of seven state machines have no write path.** `RESERVATION` is
   enforced. `AGENT`, `MANDATE`, `AUTHORIZATION`, `AGREEMENT`, `OBLIGATION`,
   `SAGA` and `CLEARING_EPOCH` are defined and tested but nothing writes through
   them, because those write paths do not exist yet.
