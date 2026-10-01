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
| FR-VAULT-006 | Agent authority does not imply principal withdrawal authority | §6.4 | `UNTESTED` | **No withdrawal path exists to test.** |
| FR-VAULT-008 | Confidential policy optional where not required, enforced where it is | §10 | `UNTESTED` | `confidentialPolicy` exists on the type; no enclave |
| FR-VAULT-009 | Enclave decision bound to policy version, vault, mandate, digest, expiry, nonce | §10 | `UNTESTED` | PRD Phase 3 (Arcium) |

**Reconciliation note — FR-VAULT-006.** This is the weakest link in the current
build. The invariant holds by *absence*: there is no withdrawal route at all.
That is true today, but it is not evidence, and the moment a withdrawal path is
added nothing will stop it from being wrong. The PRD places this in Phase 3.
Until then it stays `UNTESTED` — claiming `VERIFIED` would be precisely the
"documented ≠ true" failure the Foundry exists to prevent.

## III. Commerce and obligations

| ID | Invariant | PRD | Status |
|---|---|---|---|
| FR-COM-001 | Commercial terms distinct from payment transport | §12 | `UNTESTED` |
| FR-COM-002 | Escrow release depends on agreement/deliverable state | §12 | `UNTESTED` |
| FR-COM-003 | Duplicate delivery/evaluation events cannot cause duplicate capital release | §12 | `UNTESTED` |
| — | A rejected deliverable cannot trigger normal payment release | SECURITY.md | `UNTESTED` |
| — | An agreement cannot settle against a different provider without reassignment | SECURITY.md | `UNTESTED` |

## IV. Recovery

| ID | Invariant | PRD | Status |
|---|---|---|---|
| — | A non-idempotent compensation route cannot execute twice | SECURITY.md | `UNTESTED` |
| — | `RECOVERED`, `CONTAINED`, `ABORTED` remain semantically distinct | §14 | `VERIFIED` — `tests/machines.test.ts` proves none is reachable from another |
| — | Failure is a state transition, not an exception | §4.5 | `UNTESTED` — the saga machine is defined but no saga runs |

## V. Netting and clearing

| ID | Invariant | PRD | Status | Proof |
|---|---|---|---|---|
| FR-CLEAR-003 | Disputed obligations are never silently included in the net result | §19 | `VERIFIED` | `netObligations` excludes `DISPUTED`/`DEFAULTED` and reports them in `excluded` |
| — | Net positions sum to zero | — | `VERIFIED` | `*conserves value*` |
| — | Netting is deterministic and order-independent | — | `VERIFIED` | `*is deterministic*` — reversed input, identical output |
| — | An obligation enters at most one finalized clearing epoch | SECURITY.md | `UNTESTED` |
| — | A settlement receipt binds to the exact cleared obligation set | SECURITY.md | `UNTESTED` |

## VI. Settlement and integration

| ID | Invariant | PRD | Status |
|---|---|---|---|
| FR-SETTLE-004 | No claim of atomic cross-chain settlement unless implemented and verified | §21 | `VERIFIED` — settlement adapter throws `UnconfiguredAdapterError`; no such claim is made |
| FR-INT-002 | MCP remains the control surface and cannot bypass authority | §24 | `PARTIAL` — the shared-context server holds notes, not authority; it cannot move capital |
| — | Settlement chain and asset match authorized terms | SECURITY.md | `VERIFIED` — `CHAIN_MISMATCH` / `ASSET_MISMATCH` |
| — | External identities cannot be silently remapped | SECURITY.md | `UNTESTED` |

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
