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

| — | A persisted ARMED saga is reachable from its agreement | §15.5 | `LIVE_DEMONSTRATED` (Postgres) | **F77, fixed.** `commerce-recovery.ts` is store-free and returns `sagasToPersist`; `lib/commerce/commit-op.ts` writes the **agreement first, then the saga**, so a tear leaves an agreement naming a missing saga (a broken link the kernel already tolerates) instead of an ARMED saga no agreement can reach. Route and tests share that one function so they cannot drift. 3 tests in `tests/torn-write-probe.test.ts`, mutation 5/5, verified against real PostgreSQL |
| — | The §15.5 commitment and the committed route body survive persistence | §15.5 | `LIVE_DEMONSTRATED` (Postgres) | **F79 + F80, fixed.** `saveSaga` writes an explicit column list, so `routeCommitments` was silently dropped on the only backend that runs in production — it failed CLOSED, which is why 1128 in-memory assertions stayed green. A reloaded saga is now compensated from the committed **body** (`committedRoutes`), never a route rebuilt after the failure from `agreement.escrowRef` — which lost the chain and contract, so every on-chain refund was permanently `COMPENSATION_ROUTE_REDIRECTED`. `tests/saga-persistence.test.ts` derives the expected column list from the `Saga` type so a new field cannot be added without the test noticing |

| — | An agreement's on-chain escrow identity is derived, never chosen by a caller | §14, §15.5 | `TESTED` | **LP-6.** `escrowIdFor(agreementId) = jobIdFor(agreementId)`, the one narrowing both rails share, so a retry addresses the identical `bytes32`/PDA and two spellings cannot become two escrows. A request naming a different `jobId` is refused `ESCROW_JOB_ID_MISMATCH` rather than funding an escrow the commitment does not cover. The contract refuses a second deposit for a live `jobId` (`MitraJobEscrow.sol:89`) — the probe is an optimisation against that revert, not the guarantee |
| — | A requested escrow that cannot be executed is refused, never silently skipped | §14 | `TESTED` | **LP-6.** `onChainEscrow` was recorded in the database and answered 200, so an agreement could look funded while no capital was escrowed and its §15.5 commitment pointed at an account that did not exist. No rail → 409 `ESCROW_RAIL_NOT_CONFIGURED`, with the agreement left `OPEN` so a retry cannot find no escrow and fund a second one. Two further refusals: `ESCROW_PROVIDER_ADDRESS_MISSING` (F83 — `agreement.provider` is an agent id, not an address; the escrow party is `payTo`) and `ESCROW_CHAIN_DISAGREES_WITH_PAYTO` |
| — | A capital-moving broadcast is preceded by a read of the chain, and a replay moves nothing | §14 | `LIVE_DEMONSTRATED` | **LP-6.** Every entry point probes first and returns `skipped` with **no `txHash` field at all** when the chain is already in the target state — `AGENTS.md` forbids synthetic hashes, and a `txHash: "ALREADY_FUNDED"` shape would make a skipped run indistinguishable from a real one to anything that logs it. A chain-held commitment differing from the kernel's is refused at lock time, because at refund time it is too late to fix. Mutation 7/7 hermetic; live on Base Sepolia `0x75dbc742…` |

| — | A reported escrow exists on the chain, on BOTH rails | §14 | `LIVE_DEMONSTRATED` (Base Sepolia + devnet) | **F86.** A transaction signature is returned whether or not the transaction took effect, so both rails wait for confirmation **and then re-read the resulting state**. EVM waits for a `success` receipt; Solana re-reads the escrow account and treats `NOT CONFIRMED`, `CONFIRMED BUT NO ESCROW EXISTS` and `CONFIRMED WITHOUT A §15.5 COMMITMENT` as failures. The third matters most: an escrow with a zero route hash can never be refunded, and that is knowable at lock time while the route hash is in hand |
| — | Escrow terms mean the same thing on both rails | §14 | `TESTED` | **F85.** `EscrowTerms.client` is a caller-named vault address on EVM and the **signing key itself** on Solana, where `vaultPda(client)` derives the vault and the program checks it as the authority — so it is read from `SolanaEscrowRail.authority` and cannot be a request field. Amounts are per-rail (token base units vs lamports), and lamports are **refused** rather than guessed |

| — | A cross-chain payout pays an address we verified, on a chain we registered | §16 | `TESTED` | **LP-7.** Strict EIP-55 (`getAddress(a) === a`), so a mistyped-but-plausible address cannot receive real funds — EIP-55 exists precisely to catch that, and an unchecksummed address is one nobody verified before sending to it. The zero address is refused **separately**, because it *is* a valid checksummed address and would pass the check above. The destination is resolved through an explicit registry (`bnb→56/97`, `xlayer→196/195`) and never inferred from a bridge provider's response, so the set of chains Mitra will pay depends on this file rather than on what a provider supports this month |
| — | A bridge fee is bounded, and charged against the payer's authority as well | §16 | `TESTED` | **LP-7.** Fee ≤ `min(1% of amount, $2.00)`, slippage ≤ 50 bps, both compared in **integer basis points** — a limit lost to float noise is not a limit. And `amount + fee ≤ vault headroom`: the fee is an *additional* debit, so a guard checking only `amount` is walkable by exactly the number the destination chain sets (F87 made the ceiling 100× too small and failed **closed**, so only a boundary test caught it) |
| — | A settlement to an external chain cannot fall back to paying it from a canonical vault | §16 | `TESTED` | **LP-7.** `settleCrossChainAgreement` is a separate function rather than a flag on `settleAgreement`, because `VAULT_CHAIN_MISMATCH` is the guard that stops a Base vault paying a Solana address and a `skipTheChainCheck()` flag would endanger every other settlement. **Canonical leg first, then the bridge**, so the accepted failure is recoverable (funds in the relayer on a chain Mitra operates) rather than the destination being short with no record. **Quote before the debit**, so an unacceptable quote is found while the money is still in the vault. A live relayer requires key **and** broadcaster **and** address; absent any, the simulator is used — never a silent fallback to the canonical path (F89) |
| — | No bridge result is recorded unless a bridge actually happened | §16, AGENTS.md | `TESTED` | **LP-7.** `SimulatedPayoutRelayer` returns **no `bridgeTxHash` field at all**, and `broadcastBridgeTransaction` refuses rather than reporting an unbroadcast transaction. Every result carries `isSimulated` and an `evidenceLevel`, so a simulated settlement is distinguishable in the record from a real one. The receipt's `bridgeTxHash` is **omitted** for a simulated run rather than emitted empty, and `crossChainReceiptHash` covers the agreement, destination, amounts, both hashes and the evidence level, so it cannot be lifted onto another agreement |

| — | A session key can only do what a signed delegation permits, for as long as it permits it | §22, ADR-0011 | `TESTED` (LP-8) | The delegation is **EIP-712 over the exact tuple that is enforced** and **recovered before every use** — an authorisation not cryptographically bound to its authority is a preference, and a read-only `delegation.allowedActions` check is a speed bump in front of an attacker who writes their own permit (F90). Scope is re-checked with a live clock immediately before **each** signature, so a long-lived process cannot keep signing after expiry (F92). The action allowlist is an **enum checked before** the delegation's own list, so a genuine delegation signed by the agent itself naming `settle` is still refused — only code widens the surface (F91). Digests bind the delegation to `virtuals-acp-v1`, and a Space running Mitra's own rules is refused |
| — | A session key cannot move capital or adjudicate a dispute | §22 | `TESTED` (LP-8) | `ACP_PERMITTED_ACTIONS` is `DISCOVER`/`OPEN_JOB`/`SUBMIT_ARTIFACT`/`QUERY_STATE`/`CANCEL_JOB` and nothing else. `openJob` proposes a bid capped by `maxSpendUsd`; it does not disburse. Seven forbidden verbs are refused including when the delegator signed them in. A test asserts **no** permitted action matches `/spend|settle|dispute|claim|withdraw|transfer/`, so the control is stated as the absence of verbs rather than the presence of a deny-list |
| — | The simulator is never more permissive than the transport it stands in for | AGENTS.md | `TESTED` (LP-8) | `SimulatedVirtualsTransport` performs the **identical** scope check and tags every result `isSimulated: true` / `LOCAL_PASS`. A more permissive simulator would be a fixture that approves actions the product refuses — the most dangerous kind of test double. Client resolution has three outcomes and no fourth: no delegation or no session key yields `undefined`, so the adapter raises `UnconfiguredAdapterError` rather than no-opping |

| — | A submitted deliverable is evaluated and kept (F94) | §13, §14 | `LIVE_DEMONSTRATED` | `evaluateDeliverable` carried four guards and **no production code called it**, so a submission reached `SUBMITTED` with no evidence or past the deadline and could then be `ACCEPTED`. It now runs in the kernel **before** the transition succeeds, with `now` as an explicit input — a kernel reading `Date.now()` decides "late" untestably. `saveDeliverable` exists (`listDeliverables` had a reader and no writer) and a store that cannot write one is **refused** rather than allowed to accept a submission it drops |
| — | The job escrow never owes more than it holds (F95) | §14 | `TESTED` (13 Solidity tests, mutation 4/4) | `depositToEscrow` measured the deposit against the contract's whole balance — which includes every other live job — so a second job could be funded with **zero tokens arriving**, and the shortfall surfaced on the first payout, unrecoverable and attributable to neither job. `totalAllocated` tracks commitments; settlement frees them; an over-send stays unallocated as headroom |
| — | The escrow's evaluator and token are resolved, never cast (F96) | §14 | `LIVE_DEMONSTRATED` | The evaluator is a Mitra **agent id** cast to an address, for a field the contract treats as an **authority** — one of two callers permitted to `refundJob`. F51's caller-chosen-authority defect on a new surface. Resolved via `isAddress`, else the relayer's own address, else **refused**. The token likewise defaulted to the **zero address**, which is an escrow holding nothing at an address that exists |
| — | An agreement knows where its capital is, and notices when it leaves (F97) | §14, §15.5 | `LIVE_DEMONSTRATED` | `escrowChain`/`escrowContract`/`escrowTimeout` are persisted at `fund` — without them reconciliation has no chain to probe, which is why a keeper's timeout refund was invisible while the agreement claimed `FUNDED` over returned capital. Reconciliation is bounded and **one-directional**: refunded only, never chain-**completed**, because acceptance must drive the settlement saga |
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
