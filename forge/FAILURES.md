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

## F12 — `eth_getBalance` on Tempo returns a large constant, not zero

**Found** 2026-01-10, while establishing PRD §34 Tempo parameters.

The PRD names Tempo as a settlement chain but specifies no chain ID, RPC
endpoint, or balance semantics. Those had to be established from vendor docs.
Tempo is EVM-compatible (Osaka) and its public testnet is **Moderato**, chain
ID `42431`, at `https://rpc.moderato.tempo.xyz` — confirmed by
`eth_chainId` returning `0xa5bf`.

Tempo has **no native gas token**; fees are paid in stablecoins (TIP-20).
The vendor's EVM-compatibility page states that native token balance "is always
returning zero balances" and that `BALANCE`/`SELFBALANCE` opcodes return 0.

**That is not what the node does.** `eth_getBalance` against Moderato returns

```
0x9612084f0316e0ebd5182f398e5195a51b5ca47667d4c9b26c9b26c9b2
```

for **every** address tested — the dev key, `0x…dEaD`, and `0x1111…1111` — and
at both `latest` and `earliest` block tags. Identical bytes, all three. Decoded,
that is a ~4.0e75 figure, which is also what a wallet UI renders as the
"unusually high balance" the docs warn about.

So the documented behaviour (0) and the observed behaviour (a huge constant) are
both wrong in the same direction for our purposes: neither is a balance. A
value that is large, constant, and address-independent is the worst of the three
options, because it passes a naive truthiness or `> 0` funding check.

**Why this matters here specifically.** PRD Phase 2 is a vault controller whose
job is to decide whether capital is present before moving it. An implementation
that reads `eth_getBalance` — the obvious first thing to write, and what every
EVM tutorial teaches — would conclude the vault holds more than the supply of
the chain and would proceed. This is a capital-movement decision made on a
non-balance. It is exactly the class of error `INVARIANTS.md` exists to prevent,
arriving through an adapter rather than through the kernel.

**Resolution.** Tempo balances must be read from TIP-20 token balances
(`balanceOf`) via the Tempo API (`GET /v1/addresses/{address}/balances`), or
from `eth_call` `balanceOf` — **not** from native balance. Note that
`eth_call balanceOf` against the documented faucet token addresses currently
reverts on Moderato while `eth_getCode` returns `0xef` (a predeploy-style stub,
not empty), so the API route is the one that is actually observed working.
Unresolved: why `balanceOf` reverts is `UNTESTED`.

**Guard.** `scripts/phase2-readiness.mjs` asserts Tempo's `eth_chainId` is
`42431` and **fails loudly on `4217` (mainnet)**, so a misconfigured endpoint
cannot be mistaken for a testnet. The no-native-token rule is surfaced as an
explicit precondition. Verified by running the script against
`https://rpc.tempo.xyz` and watching it report
`chainId 4217 = TEMPO MAINNET — refusing to treat production as a testnet`.

**Rule.** Documentation of an RPC's behaviour is not evidence of that RPC's
behaviour. Probe it, and probe it with at least one control value that must
differ.

## F13 — the secrets guard was green because it could not see the file

**Found** 2026-01-10, immediately after the key tooling was committed.

`tests/secrets.test.ts` failed on the new baseline:

```
expected [ 'scripts/generate-dev-keys.mjs:113' ] to deeply equal []
```

That line is the secp256k1 scalar-1 known-answer vector — `0…01`, a published
constant, not a secret. So the finding was substantively harmless.

**But how it was found is the actual failure.** The previous run reported
138/138. That run happened *before* `git add`. The scanner enumerates
`git ls-files`, which returns only **tracked** files. At the time it passed, the
file it should have been scanning was not yet tracked, so the guard had never
looked at it. Committing the file is what made the guard fire.

A test that inspects a directory listing reports on the directory listing, not
on the working tree. Untracked-but-present files are invisible to it — which is
precisely the window in which a secret is most likely to be added and most
likely to be missed.

**Two mistakes were available here and the tempting one was worse.** The easy
fix was to add a filename exclusion for `generate-dev-keys.mjs`, the same shape
as the `"canonical"` exclusion that F-record already documents as a hole shaped
like the thing it excludes. The fix chosen instead was to remove the literal:
`BigInt(1).toString(16).padStart(64, "0")` constructs the scalar, so no
64-hex string sits on a field named `privateKey`. The published constant stays
in the code, legible as `SCALAR_ONE`, and the file stays fully scannable.

**Fix.** Constructor expression instead of a hex literal. No scanner exemption
was added, so the guard's coverage is unchanged.

**Guard verified by planting a key, not by assertion.** A realistic fake
(`privateKey = "a3f1c9…e6f7"`) was added to `lib/adapters/types.ts` and staged:
the guard fired with the exact file and line. Restored, it passed. The guard
catches key material *and* no longer trips on the public vector.

**Rule.** A guard that enumerates tracked files has a blind spot precisely
where files change. Run secret scanners against the working tree, and never
treat a green run on an untracked file as evidence about that file.

## F14 — the key generator silently destroyed funded keys

**Found** 2026-01-10, immediately after funding the EVM key on Base Vibenet.

`scripts/generate-dev-keys.mjs` called `writeFileSync` unconditionally. Running
it a second time replaced **both** keypairs with fresh ones, with no prompt, no
warning, and no non-zero exit. The only evidence was a changed address in
otherwise-successful output.

This was not hypothetical. The sequence was:

1. Generated keys, verified the known-answer vector after the F13 fix — by
   running `generate-dev-keys.mjs`, which **rotated both keypairs**.
2. Discovered the rotation when `phase2-readiness.mjs` reported the *old*
   address as unfunded while Vibenet showed the funds at a *different* address.
3. 0.1 ETH sent to the original address is now unrecoverable.

The step-1 intent was "confirm the script still runs." That is exactly the
operation `verify-dev-keys.mjs` exists for, and it writes nothing. Two scripts
with overlapping purpose, one of which is destructive, is the actual defect.

**Why this class of bug is worth a failure record.** A key tool that destroys
keys on a casual re-run is worse than one that refuses, because the damage is
invisible at the moment it happens and permanent afterwards. The AGENTS.md rule
about not introducing fake success paths is the same shape: a tool reporting
success while having done something irreversible.

**Fix.** The generator now refuses to overwrite when `.dev-keys/evm-testnet.key`
exists, prints the existing address so the operator can see what is at risk, and
exits non-zero. Rotation requires an explicit `--force`, which warns that the old
addresses are dead. `verify-dev-keys.mjs` is named in the refusal message as the
non-destructive alternative.

**Guard.** Verified by planting: keys backed up, `--force` run (address changes,
as intended), then a default run (refused, exit non-zero, address unchanged).
The test asserts the *default* path refuses, because that is the path that
protects funds.

**Rule.** A destructive tool must require intent. "It was only a test run" is
not a defence against an irreversible action, and a script that silently
overwrites a secret has the same failure mode as a script that leaks one.

## F15 — `api.tempo.xyz` indexes mainnet, and reports testnet accounts as empty

**Found** 2026-01-10, while confirming Tempo funding.

ADR-0006 directs Tempo balance reads to the Tempo API, on the strength of an
earlier probe: `GET /v1/addresses/{address}/balances` returned a well-formed
response for a busy address. That was true and misleading. The host indexes
**Tempo mainnet**.

Measured, not inferred: the API's newest block was `42141436` while
`rpc.tempo.xyz` (mainnet) was at `42141428` and `rpc.moderato.tempo.xyz` was at
`37738544`. The API tracks mainnet.

**The failure mode is the bad kind.** A funded Moderato address queried through
this host returns `{"data":[],"nextCursor":null}` — byte-identical to the
response for an address that has never been touched. So the API reports "no
funds" for an account holding 1M units of five stablecoins, and a funding check
built on it would either block a funded vault or, worse, be "fixed" by trusting
it after a future top-up appeared. There is no testnet host:
`api.testnet.tempo.xyz` and `api.moderato.tempo.xyz` do not resolve.

**Resolution.** Tempo testnet balances are read from Moderato `eth_getLogs`
Transfer topics, summing amounts per token. `scripts/fund-tempo.mjs` does this
and never contacts the API for balances.

**A second trap, in my own verification.** The first log query filtered
`topics[1]` (the sender) for our address and returned nothing — I briefly
concluded the account was unfunded. The faucet delivers by **mint**, so
`topics[1]` is the zero address and the recipient is in `topics[2]`. Filtering on
the wrong index made a funded account look empty, the same false negative as the
API, reached by a different route. Both are now stated in the script.

**Guard.** `tests/dev-scripts.test.ts` measures the API's block height against
both nodes and asserts it tracks exactly one — currently mainnet. If Tempo ever
indexes Moderato, the assertion fails and the ADR can be revisited. It is
written to fail rather than pass silently on "neither", because a third state
would mean the reasoning behind the whole workaround no longer holds.

**Rule.** A query that returns empty is not evidence of absence until the
query's subject has been identified. Confirm which chain an endpoint serves
before believing anything it says — especially "nothing here".

## Open risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| No on-chain enforcement | Capital is a database row, not an enforced account | Stated `PARTIAL` in `INVARIANTS.md`; not counted as PRD Phase 2 progress. **Still open** — this is PRD Phase 2 work. |
| No withdrawal path exists | `FR-VAULT-006` holds by absence, not enforcement | Recorded `UNTESTED`, not `VERIFIED`. **Still open.** |
| Six of seven state machines unwritten | Definitions exist but nothing writes through them | Stated in `INVARIANTS.md` and `EXECUTION_PLAN.md`. **Still open** — only `reservation` has a write path. |
| ~~Ledger is process-local on the kernel path~~ **RESOLVED** | Routes now go through `getStore()`; `InMemoryRepository` / `PostgresRepository` behind one interface | `tests/persistence.test.ts` — "routes served by postgres", incl. nonce surviving a simulated restart |
