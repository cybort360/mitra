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
| FR-VAULT-006 | Agent authority does not imply principal withdrawal authority | §6.4 | `PARTIAL` | `withdraw` path `VERIFIED` (`withdraw.rs`, 16 tests, F41). **The `spend_authorized` path FAILED on the deployed program (F51):** a stranger could issue a permit and spend any vault to any payee. Fixed (merged) and **redeployed**: the deployed bytecode carries the F51-only log string and the deploy slot moved to 507040856. In-process: `permit_binding.rs`, mutation 14/14. Live: see the row below |
| — | Only the principal grants a mandate; only its named engine issues permits; a permit pays only its named recipient, only from the principal's vault | §3, ADR-0009 | `PARTIAL` | In-process, all three refusals: `programs/mitra-vault/tests/permit_binding.rs` (13 tests, each paired with the legitimate path). **Live on devnet** (`SOLANA_LIVE=1 npx vitest run tests/solana-transport.test.ts`): a non-engine signer's `authorize` is refused with `Custom: 6015` (simulated, no fee), and the granted path settles (`5ymG6QcREUCT…`). Not yet live: the wrong-vault and wrong-payee refusals. The deployed binary is identified by its log strings, not by a build reproduced here. See F51 |
| — | A FROZEN vault cannot be drained by withdrawal | §6.4 | `VERIFIED` | `withdraw.rs` → *a frozen vault refuses withdrawal* + *handler refuses withdrawal from a frozen vault*. This was **false before F41** |
| — | A job's escrowed capital is unreachable through the vault, and its recovery route was committed before the job was funded | §13, §15.5 | `LIVE_DEMONSTRATED` | **Live on devnet** (LP-4, 2026-10-06). `lock_escrow` moves real lamports to a per-job PDA (`2mXh5ejmr9H8…`, slot 508042268): `available` −750,000, `escrowed` +750,000, `total` unchanged, and the escrow account's own balance holds the capital — the property `reserve` cannot have. **§15.5 enforced on chain:** an all-zero `refund_route_hash` is refused `0x1783` (6019) with the vault byte-identical after. **Recovery is autonomous:** at the job's deadline a keeper who is neither client nor provider refunded it (`57f5fScrHFcec…`, slot 508042318), before which the same keeper was refused `0x1784` (6020). Replay refused `0x1785` (6021) in both directions. Offline: `tests/escrow.rs` 39 tests, mutation 8/8; `tests/solana-escrow.test.ts` 16 hermetic against Rust-generated bytes |
| — | Escrowed capital is still Mitra's capital, and holding a job does not distort the vault's balance identity | §4.12 | `LIVE_DEMONSTRATED` | **This was false as first deployed — see F70.** `check_no_surplus_lamports` compared lamports against `total`, which stops holding once lamports sit in an escrow PDA: with 2,000,000 outstanding, `reserve` and `release` returned `0x1773` for every amount, i.e. one escrow disabled the reservation mechanism for the whole vault. Corrected to `Vault::held()` (`total − escrowed`) and re-proven live: `node scripts/vault-devnet.mjs` → all six Phase 2 clauses pass with 2,000,000 still escrowed, and `lamports == held + rent` reconciles to the lamport (5,277,346 = 6,093,706 − 2,000,000 + 1,183,640). Regression test: `tests/escrow.rs` → *an outstanding escrow does not break the vault's lamport identity* |
| — | The provider is paid from the escrow's record, never from the caller's account list | §13.4 | `LIVE_DEMONSTRATED` | `release_escrow` takes **no amount and no payee argument** — 8 + 32 bytes, asserted structurally in both the Rust golden layout and `tests/solana-escrow.test.ts`. The provider is a positional account only because Solana requires every touched account in the message, and it is refused with `0x1760`/6016 `RECIPIENT_MISMATCH` unless it is the key recorded at funding, exactly as `spend_authorized` refuses a permit to the wrong payee (F51). Live: the payee rose by **exactly** the escrow amount and a replay paid nothing |
| — | Nobody can invent a compensation route after a failure | §15.5 | `LIVE_DEMONSTRATED` | The refund consults `refund_route_hash` and nothing else, so there is no code path that could pay out against a route nobody agreed to. The guard is duplicated on purpose: `lock_escrow` refuses a zero hash (live, `0x1783`), **and** `JobEscrow::refundable_at` refuses the refund independently (`tests/escrow.rs` → *an escrow with no commitment cannot be refunded*), so the guarantee rests on the refund rather than on how the account came to exist |

| — | A caller cannot substitute different instructions behind a committed route id | §15.5 | `TESTED` | **F76.** `compensate` read route bodies from a caller-supplied array while the saga persisted only ids, so the committed id could carry another contract, job or payee and the engine would run it. `keccak256(route)` is recorded at `declareSaga` and re-derived before execution; mismatch `COMPENSATION_ROUTE_REDIRECTED`, absent `COMPENSATION_ROUTE_NOT_COMMITTED`. The commitment covers the instructions and not `maxAttempts`, so a retry-budget change is still the caller's business. Mutation 3/3 |

| — | A persisted ARMED saga is reachable from its agreement | §15.5 | `PARTIAL` — **F77, open.** `applyAgreementOpWithSaga` saves the saga and returns; the route saves the agreement afterwards, in a second transaction. If the second never lands, the store holds an ARMED saga with a live §15.5 commitment that no agreement names and no op can reach (`agreement.sagaIds` is how every op finds it). Canary: `tests/torn-write-probe.test.ts`, `it.fails`, green until the fund path becomes atomic. **Blocks** putting `depositToEscrow`/`lock_escrow` in that window — the tear would then strand capital rather than one saga |
| FR-VAULT-008 | Confidential policy optional where not required, enforced where it is | §10 | `LIVE_DEMONSTRATED` (2026-10-06, LP-5) | **Was `UNTESTED` with the rationale "no enclave" — which was wrong: the circuit existed and had never been RUN.** Live on a 4-node Arcium MPC localnet (2 primary + 2 backup, `Cerberus`), `evaluate_mandate` queued as a real Arcis computation: 9 policy cases + 2 confidentiality cases, **13/13**. ALLOW inside every bound (`48f4oZ5gGHwL9J5…` slot 1695 → `5WXhnFju2a6KWS3…` slot 1700, `allowed=1 reason=0`); the enclave is **optional in the ordinary path** and this row is about it being *enforced where used* — all six gates fold multiplicatively into `allowed`, asserted in `tests/arcium-policy-circuit.test.ts` |
| — | A confidential decision is computed without revealing the policy it applied | §11.12 | `LIVE_DEMONSTRATED` | The mandate's limits are the secret. With `max_transaction = 0x5eed123456789abc` and `budget = 0xfeed0bad0c0d0e0f`, **the whole serialized queue transaction is searched for both in both endiannesses; neither appears**. The callback emits two 32-byte ciphertexts, not a verdict — asserted against a bare `u64` 1 and 32 zero bytes, so "inputs secret but ALLOW published" cannot pass. The circuit keeps the six binding fields OUT (policy version, digest, vault, mandate, expiry, guard): they travel in plaintext around the encrypted result, as §11.12 asks |
| — | A DENY from the enclave is attributable without revealing which limit bound | §11 | `LIVE_DEMONSTRATED` | **Both F43 defects, re-proven on the compiled circuit the cluster actually executes** — something the 14 hermetic tests could never do. A zero amount is REFUSED `reason=3` (`28EgnXF2X6sQjS…` slot 1702 → `xjibkbs7LRvfsDv…` slot 1706); a dead mandate outranks a breached `max_transaction` with `reason=1` (`4ZfZtjZZsXdgCmB…` slot 1707 → `K3djJSx1JDM7mDe…` slot 1711), where the defect reported `reason=4`. All seven codes and both inclusive boundaries reproduced |
| — | The enclave is never the only enforcement layer | §11 | `LIVE_DEMONSTRATED` (that it enforces nothing) | The Anchor program **emits ciphertexts and cannot read its own verdict** — `output.verify_output` then `emit!`, no decryption, no branch on `allowed`. A decision from here is an input to `validateExecutionBinding`, which re-derives independently. Asserted structurally: the circuit returns `Enc<Shared, MandatePolicyOutput>`, and the callback's payload is two ciphertexts rather than a value |
| FR-VAULT-009 | Enclave decision bound to policy version, vault, mandate, digest, expiry, nonce | §10 | `LIVE_DEMONSTRATED` (decision leg only) | `PARTIAL` — **deliberately NOT upgraded on the strength of the LP-5 run, because LP-5 proved a different claim.** The cluster now computes and returns a decision (see FR-VAULT-008), but of the six fields this row names, **exactly one is bound inside the decision**: the nonce, which the cluster echoes and only the caller holding the x25519 secret can read the output with. `expiry` is a *function* of the decision — it arrives pre-folded into the encrypted `mandate_live` flag, so an expired mandate cannot be evaluated as live — but no specific expiry value is bound to it. **Policy version, vault, mandate and action digest appear nowhere in the circuit or the request**: they are §11.12's plaintext identifiers travelling *around* the encrypted result, and nothing yet commits the decision to them. That is a deliberate design choice (MPC cycles on public values are waste, and the probe program cannot see them either), but it means the binding is the **client's** obligation and the client has not started doing it. **Open:** assemble the six fields on the request, commit them into the transcript, and have `validateExecutionBinding` re-derive the same commitment off-chain before any permit is issued |

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
| FR-INT-002 | MCP remains the control surface and cannot bypass authority | §24 | `evidence: E2E_VERIFIED, blocker: BLOCKED_INTERNAL` — the live MCP server (`lib/mcp/server.ts`) is a thin client of the API: no store, no keys, no capital verb (`assertNoCapitalVerb` on what is served), refusals passed through as tool errors; verified over stdio and over HTTP to a running Mitra (2026-10-04, local). F55 fixed 2026-10-05: fund/accept/reject/register are served and carry the agent's own EIP-712 signature, which the API checks against role and registered wallets (in-memory and Postgres). Blocker: the signed tools are not yet verified against a running Mitra |
| — | Settlement chain and asset match authorized terms | SECURITY.md | `VERIFIED` — `CHAIN_MISMATCH` / `ASSET_MISMATCH` |
| — | External identities cannot be silently remapped | SECURITY.md | `VERIFIED` — guard added | `marketplaceRefs` was a plain array. `assertNoIdentityRemap` / `mergeRefs` refuse a `(system,id)` already bound to another agent |
| — | An ACCEPTED agreement is paid only through the execution guard, at most once, to its agreed payee | AGENTS.md mechanism; lead seq 55 | `evidence: LIVE_DEMONSTRATED, blocker: —` — Base Sepolia 2026-10-03 (PROOF_LEDGER). `lib/kernel/settlement.ts` re-derives the digest from the agreement; `claimSettlement` is the at-most-once boundary (Postgres race test) |
| — | A smart-account (ERC-1271) or counterfactual (ERC-6492) signature is verified by the chain, never assumed; a reverting or codeless account is invalid | §8 (account types), §28 P0 ERC-1271 | `evidence: LIVE_DEMONSTRATED, blocker: —` — Base Sepolia 2026-10-03 (PROOF_LEDGER). `RpcSignatureVerifier` behind `verifyAuthorisation`. Note: no production route yet asks for a counterparty signature, so the verifier has no caller outside tests |
| — | An x402 payment consumes a reservation and passes the execution guard before anything is signed; the protocol is the reference SDK's | §12.1 | `evidence: LIVE_DEMONSTRATED, blocker: —` — Base Sepolia via the public x402.org facilitator, 2026-10-04 (PROOF_LEDGER). `planX402Payment` runs in `onBeforePaymentCreation` |
| — | On EVM, a spend needs the engine the PRINCIPAL named, pays only the recipient the engine signed, from only the vault the mandate governs, once | §34 (EVM equivalent), F51 | `evidence: LIVE_DEMONSTRATED, blocker: —` — `contracts/src/MitraVault.sol` on Base Sepolia and Tempo Moderato, 2026-10-04 (PROOF_LEDGER); refusals simulated on the deployed contracts |
| §21.4 / FR-PROV-001 | Settlement evidence is built from the chain, re-derivable by a third party, and never upgraded from Mitra's own record | §17, §21.4 | `evidence: LIVE_DEMONSTRATED, blocker: —` for the evidence leg on all three rails (Base Sepolia, Tempo Moderato, Solana devnet; 2026-10-03, PROOF_LEDGER). Receipts are hash-chained per run and **EIP-191 signed** when `MITRA_RECEIPT_SIGNER_KEY_FILE` is set (backlog #4; `verifyReceipts`); unsigned otherwise, and labelled so |

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
