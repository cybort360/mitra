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

## F16 — the official Base bridge guide is archived and Goerli-pinned

**Found** 2026-01-10, when bridging Sepolia → Base Sepolia.

`docs.base.org` links to `base/guides/tree/main/bridge/native` as the reference
for programmatic bridging. It cannot be used as written, for three independent
reasons:

1. **The repository is archived.** GitHub reports `archived: true`, last push
   2024-06-23. Nobody is fixing it.
2. **Its config is pinned to Goerli, not Sepolia.** `hardhat.config.js`
   hardcodes `base-goerli.blockscout.com`, WETH on goerli, and
   `L1StandardBridge = 0xfA6D8Ee5BE770F84FC001D098C4bD604Fe01284a`. The README
   *prose* says "sepolia" throughout, so a careful reader following the words
   sends value to a Goerli address. **That address has no code on Sepolia L1** —
   measured with `eth_getCode`, not assumed.
3. **It requires a wallet mnemonic in a checked-in `secrets.json`**, which is
   precisely the habit F13/F14 exist to prevent.

The correct Base Sepolia `L1StandardBridge` is
`0xfd0Bf71F60660E2f608ed56e1659C450eB113120`, taken from Base's own
contract-addresses page and then verified from two independent directions: it
has 2,472 bytes of code on Sepolia L1, and `messenger()` returns
`0xC34855F4De64F1840e5686e64278da901e261f20`, the documented
`L1CrossDomainMessenger`. `scripts/bridge-sepolia.mjs` asserts both before it
will move a wei.

**The bridge entry point is blocked, but the portal is not.** Calling
`depositETH` on `L1StandardBridge` reverts:

```
ContractFunctionExecutionError: The contract function "depositETH" reverted.
  address: 0xfd0Bf71F60660E2f608ed56e1659C450eB113120
  args: (0xAeA8bc34…26D, 200000, 0x)
```

Cause: `L1StandardBridge` forwards to the portal but enforces its own
access control, and a plain EOA does not satisfy it. `eth_call` confirms the
revert is real while the portal's own equivalent succeeds — see below.

### Correction: I reported this as impossible, and that was wrong

The first version of this entry concluded the bridge could not be done from an
EOA. That was an over-generalisation from one entry point. The human pointed out
that the **OptimismPortal** exposes
`depositTransaction(address,uint256,uint64,bool,bytes)`, which is a different
function on a different contract with different access control. Simulated
before spending gas:

```
depositTransaction(...)  via eth_call  -> 0x            (succeeds)
depositETH(...)          via eth_call  -> execution reverted
```

**Correction: I reported this as impossible, and that was wrong.** A bridge from
an EOA was available the whole time; I had tested one function and generalised
from it. That is the same error as F12 and F13 — treating one observation as a
property of the system.

The L1 transaction then succeeded (`status 0x1`,
`0xb681280536f994aef11736e6592de70a363ea00b5dfd1e6a3f1ecd03839c9b4c`, block
11823822), emitting the canonical `TransactionDeposited(address,address,uint256,bytes)`
event, and the L1 balance fell from 0.05 to 0.0398 ETH — so the value really did
leave L1.

**The L2 arrival took longer than expected, and that is the point.** Two deposits
were accepted on L1 and the balance fell both times (0.05 → 0.0398 → 0.0345 ETH),
with canonical `TransactionDeposited` events. For a while the Base Sepolia
balance was still `0x0`, and the temptation was to write "bridged" on the
strength of the L1 receipt.

Instead the claim waited on the L2 balance, which is the only thing that counts.
**0.01 ETH then appeared on `sepolia.base.org`.** The L1 receipt was true
throughout; it was simply not sufficient. A second 0.005 deposit was still
deriving when last checked, which is the same evidence discipline applied
without exception: L1 accepted, L2 not yet observed, so L2 stays `PARTIAL`.

**An ABI bug I introduced while testing this.** The first version of the
regression test hand-encoded the calldata and put the dynamic `bytes` offset at
`0x20` instead of `0xa0` (5 head words, not 3). It produced well-formed-looking
calldata that reverted, and the test then "proved" the working call was broken.
The correct encoding was taken from `cast calldata` rather than from my
arithmetic. Bespoke encoding is F12 again: it fails silently and looks right.

**Rule.** "This function is gated" is not "this is impossible". Test the other
entry point before reporting a wall — especially when the system has more than
one door.

**Rule.** "This function is gated" is not "this is impossible". Test the other
entry point before reporting a wall — especially when the system has more than
one door.

**A misleading environment variable, worth its own note.** The first run failed
with `Must be authenticated!` on every call. The cause was not the code: this
environment has `SEPOLIA_RPC_URL` pointing at an Alchemy endpoint whose key has
expired, and it silently overrode the script's public default. Worth recording
because the error names a *method* (`eth_getCode`) and so reads like a
permissions problem in the script rather than a dead credential in the
environment. The same class of thing as F13: the failure appears in the wrong
place.

**Rule.** An archived reference is not a working reference, and a prose
description of a network is not a deployment. Ask the chain what is actually
there before sending value to an address you read in a README.

## F17 — the Anchor discriminators were written from memory, and were wrong

**Found** 2026-01-10, on the first run of `mitra-vault`'s parity tests.

The `anchor_parity` module hardcoded Anchor's account and instruction
discriminators:

```rust
pub const VAULT_DISCRIMINATOR: [u8; 8] = [173, 18, 155, 96, 193, 78, 157, 99];
```

I wrote those bytes from memory. The first test run produced:

```
assertion `left == right` failed
  left:  [211, 8, 232, 43, 2, 152, 117, 119]   // computed from sha256("account:Vault")
 right: [173, 18, 155, 96, 193, 78, 157, 99]   // what I wrote
```

**Every one of the six constants was wrong.** The corrected values are now
computed and pinned by tests, so the same class of error cannot recur silently.

This is the *fourth* instance of the same pattern in one week — sha3-vs-keccak
(F12), a guard that could not see untracked files (F13), hand-rolled RLP, and a
hand-encoded ABI offset. In every case the code compiled, looked right, and was
only wrong because something independently recomputed it. The reason this one was
caught is that I wrote the parity tests *before* trusting the constants, which is
the whole reason the parity layer exists.

**Why a wrong discriminator is worse than a missing one.** A vault account whose
discriminator does not match is rejected loudly, immediately, with a clear error.
A wrong-but-self-consistent discriminator is silently a *different* program's
account — and after the Anchor migration, that is a different program's state
layout being read as ours.

**Rule.** Never write a hash-derived constant from memory, however short. Compute
it, print it, and pin it with a test that recomputes it. A constant nobody can
re-derive is indistinguishable from a guess, and the guess will be wrong.

## F18 — the BPF-VM end-to-end path is blocked by an upstream defect

**Found** 2026-01-10, while trying to run the vault program in a real VM.

The strongest local evidence for an on-chain program is executing the compiled
`.so` in a real BPF VM — `solana-program-test`. Without it, the unit tests
exercise the capital logic *in-process*, and a bug that only manifests in
compiled eBPF (a borsh offset that is wrong only once the struct is laid out in
a PDA, a discriminator that differs after optimisation) is invisible.

I tried three routes, and the failures are worth recording so the next person does
not repeat them:

1. **No `solana-program-test` offline, no JS client, and the Agave 4.3 CLI has no
   generic send subcommand** (`solana send` does not exist; only `transfer`).
   A `ProgramTest`-style harness in plain `tests/` fails to link.
2. **Raw JSON-RPC over TCP to a local `solana-test-validator`** — viable in
   principle, but the harness needs a *keypair* to sign, and the CLI cannot
   assemble an arbitrary instruction.
3. **`solana-program-test` 4.4.0-beta.0** — installs, but requires `rustc
   1.98.1` where the environment had 1.98.0. Solved: `rustup toolchain install
   1.98.1` (now installed and available).
4. **And it still fails**, inside Solana's own stack:
   `solana-keypair 4.0.0` calls `SignatureError::from_source(five8::DecodeError)`,
   but neither `five8` 0.2.1 nor 1.0.0 implements `std::error::Error` for
   `DecodeError`. Two incompatible `five8` majors resolve side by side.

**Why I did not work around it.** Vendoring a patched dependency tree, or pinning
`five8` to a version whose API the rest of the stack no longer matches, would
produce a green test that exercises *my* tree rather than the real one. The
program is security-critical, so a local test that is not the real thing is worse
than an admitted gap.

**What is actually verified, precisely:** the program compiles under
`cargo-build-sbf` to a 37,432-byte eBPF ELF, links, and **was deployed to a live
`solana-test-validator`** (program id `JDvCs39vreS1vz61Jo5qthiVeDYgysNGD9nsazRWa7xu`,
`VersionedTransaction` accepted by the bank). The `process` entrypoint and
dispatch are real; what is untested is the *on-chain behaviour* of each handler
inside a VM.

**So:** Phase 2's exit condition remains `PARTIAL`, and specifically the
"real devnet vault … settlement proof" clause is not met. 18 tests over the
logic and Anchor parity, and a deploying artifact, are real — and they are not
the same as a transaction the chain executed.

**Rule.** A local test that is not the real dependency tree is a test of your
patch, not of the system. When the gap is upstream, record it as `UNTESTED` and
say which command would close it.

## F19 — the program had five defects that only a real chain could find

**Found** 2026-01-10, deploying to Solana devnet.

The vault program passed **18 unit tests**, built to a clean 37KB eBPF ELF, and
deployed successfully. Then five of its instructions failed on devnet. Every one
is a property that only exists on a real chain, and none is testable in-process:

1. **`copy_from_slice: source slice length (105) does not match destination slice
   length (0)`.** `initialize_vault` wrote into a PDA that did not exist yet. A PDA
   has no account until something creates it; in-process the account is just a
   buffer the function may write to. Fixed with a `create_account` CPI — which is
   precisely what Anchor's `#[account(init, payer = …, space = …)]` does, and the
   reason an Anchor program never confronts this.
2. **`signer privilege escalated`.** The `create_account` CPI makes the PDA a
   signer, and `invoke` cannot grant that; `invoke_signed` with the program's own
   seeds must.
3. **`Could not create program address with signer seeds`.** `invoke_signed` takes
   an outer slice of *seed sets*, one per signer. I passed `[seeds, &[bump]]`,
   asking the runtime to derive two addresses. It wants **one** set:
   `[b"vault", authority, bump]`. The error reads like a derivation bug and is
   actually an argument-shape bug.
4. **`instruction spent from the balance of an account it does not own`.** Lamport
   movement was done by writing `try_borrow_mut_lamports` directly. A program may
   only debit an account it owns or can sign for; the depositor is neither. Fixed
   with a system-program `transfer` CPI.
5. **`check_vault_account` was passed the wrong account.** Its signature took one
   `&AccountInfo`, and every call site passed the *authority* — a wallet, which of
   course is not program-owned. It failed with `INVALID_ACCOUNT_OWNER`, a message
   that says "you passed the wrong account" while the real fault was the argument
   *within* the function. Reshaped to take `(vault, authority)` separately so the
   two questions can no longer be confused.

**And a sixth, in my own verification harness** — worth more than any of the
five. The harness returned `null` on failure and printed nothing, so a genuine bug
was indistinguishable from an expected rejection. Three rounds of debugging went
into that before it surfaced the actual program log. A harness that hides its
errors is worse than no harness: it makes the *absence* of information look like
information.

Then two more harness defects, both found by their consequences rather than by
inspection:

- **Absolute assertions.** It asserted `total == 1 SOL` and `reserved == 0`, which
  only hold on a fresh vault. On a second run those failed — and worse, the
  over-reserve guard *passed* when it should have failed, because leftover capital
  from the previous run made a "beyond available" amount affordable. The harness
  reported a broken boundary that was intact. Every expectation is now relative to
  the state read immediately before the action, which is what makes it re-runnable.
- **A hardcoded program id.** Because the deploy and the script edit ran in
  different shells, the id silently drifted and the harness was driving a
  *previous* deployment, reporting its failures as current. The id is now derived
  from the deployed keypair.

**Why this is the strongest evidence in the repository.** 18 unit tests exercised
the capital arithmetic and Anchor parity and found nothing, because every one of
these five bugs lives in the boundary between the program and the runtime: account
existence, signer privileges, CPI shape, and lamport ownership. No amount of local
testing reaches them. This is the concrete argument for ADR-0004 — "real" and
"funded" in the PRD exit condition are not pedantry, they name the only place these
bugs are visible.

**Rule.** A program that compiles and deploys is not a program that works. The
tests that matter are the ones that run where the account, the runtime and the
signer actually exist.

## F20 — the evidence vocabulary in AGENTS.md conflicts with BUILD_FOUNDRY

**Found** 2026-01-10, reading both standards before a phase audit.

`AGENTS.md` states the permitted statuses are:

> Use only these statuses: `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`.

`forge/standards/BUILD_FOUNDRY.md` §2 defines **fourteen**:

> `PROPOSED` `IMPLEMENTED` `TESTED` `INTEGRATED` `E2E_VERIFIED` `LIVE_DEMONSTRATED`
> `LIVE` `MONITORED` `PARTIAL` `BLOCKED_EXTERNAL` `BLOCKED_INTERNAL` `DEFERRED`
> `REJECTED` `FUTURE`

Only `PARTIAL` is common to both. Everything else is either forbidden by
AGENTS.md or unavailable under it — most importantly `BLOCKED_EXTERNAL` and
`BLOCKED_INTERNAL`, which are the two distinctions that make a blocker
*actionable*, and which this repository most needs now that eight phases remain.

The conflict is not academic. It already produced a concrete loss: Phase 2's
devnet work would, under BUILD_FOUNDRY, be `LIVE_DEMONSTRATED` (executed at least
once against a live substrate). Under AGENTS.md the nearest true value is
`VERIFIED`, which is coarser and loses "demonstrated against a real chain". The
distinction is the one ADR-0004 exists to protect.

**Decision taken, and why.** AGENTS.md governs until an ADR supersedes it — it
is the root directive and says so. So the ledger stays on the five-state
vocabulary, and this record exists so the loss is *visible* rather than silent.
Adopting the full BUILD_FOUNDRY set requires an ADR, and the honest ADR would
have to state whether AGENTS.md is amended or the ledger carries two columns.
Until then, this mapping is the working equivalence:

| BUILD_FOUNDRY | reported here as |
|---|---|
| `PROPOSED` / `IMPLEMENTED` | `UNTESTED` |
| `TESTED` / `INTEGRATED` | `PARTIAL` |
| `E2E_VERIFIED` | `PARTIAL` — local suites only |
| `LIVE_DEMONSTRATED` / `LIVE` | `VERIFIED` |
| `BLOCKED_EXTERNAL` / `BLOCKED_INTERNAL` | `PARTIAL` + the blocker named in prose |
| `REGRESSED` / `FAILED` | `FAILED` / `REGRESSED` |

**Resolution.** [ADR-0008](../docs/adr/0008-evidence-two-fields-union-vocabulary.md)
adopts the **union** in **two fields**, and `AGENTS.md` now points at BUILD_FOUNDRY
§2 rather than carrying its own list, so the two cannot drift apart again.

**How I measured the overlap, and got it wrong first.** A regex of
`^\| \`[A-Z_]+\`` reported **13** states — it excluded digits, so `E2E_VERIFIED`
vanished silently. Corrected to `[A-Z0-9_]`, the real answer is 14 and the
intersection with AGENTS.md's five is **exactly one word: `PARTIAL`**.

That is the same failure as F17, one turn after writing F17: a measurement asserted
before it was checked. Worth recording rather than quietly correcting, because the
whole point of this record is that evidence outranks confidence — and for about
thirty seconds it did not.

**Two errors the new guard caught in my own ADR.** `tests/phase0-docs.test.ts`
failed immediately on:

- **`PARTIAL` was missing from both field lists.** It is the one word both
  documents share, and it belongs on the `blocker` side — BUILD_FOUNDRY defines it
  as "some behavior works, with explicitly named residual gaps", which is a
  statement about what is *missing*. Had I written the vocabulary without the guard,
  the repository would have had a rule that rejected its own most common word.
- **`ALLOW` was flagged as a status.** The first version of the guard
  backticked any ALL-CAPS token in the table and picked up `ALLOW` from prose
  about the policy engine. Fixed by scoping extraction to the status *cells* rather
  than by loosening the vocabulary — loosening would have let any invented word in.

**Rule.** When two governing documents disagree, record the disagreement and the
mapping rather than silently picking one. Silently picking one is how a
repository loses a distinction without noticing it lost one. And write the guard in
the same change as the rule it guards — it found two errors in the rule on its first
run.

## F21 — AGENTS.md links a standards file under a name that does not exist

**Found** 2026-01-10, same audit.

`AGENTS.md` refers to the standards as:

> `Repository_Starter_Virtuous_Build_Cycle.md`

The file on disk is:

```
forge/standards/Repository-Starter-Virtuous-Build-Cycle.md
```

Hyphens, not underscores. A reader following the link exactly — which is the
whole point of a link — gets a 404, and the document governing repository
construction is one of the two the root directive names.

Small, but it is the same class as F9 and F10: a reference that asserts
compatibility with something nobody checked. Fixed in `AGENTS.md` to the real
filename.

**Rule.** A reference is a claim. Check that it resolves.

## F22 — ten days of work were built from half the governing specification

**Found** 2026-01-10, when asked what Mitra is *according to the specification*
rather than the PRD.

`AGENTS.md` names both documents as the specification:

> The full specification is `docs/product/MITRA_PRD.md` (normative) and
> `docs/product/MITRA_0_1_FULL_PRODUCT_SPEC.md`.

I had read the PRD and **never opened the full product spec** — 4,041 lines.
Everything built to that point derived from the PRD alone.

**Why it mattered, concretely.** The spec's thesis appears in exactly one
document:

```
$ grep -c 'Payments let machines move money' MITRA_0_1_FULL_PRODUCT_SPEC.md
1
$ grep -c 'Payments let machines move money' MITRA_PRD.md
0
```

So the defining sentence of the product existed nowhere in what I had read. The
PRD expresses the thesis in its own words — *"financial coordination control
plane"* — and I had been building a **vault**. Those are related, and a vault is
genuinely Phase 2's exit condition, but the vault is the *enforcement substrate
the thesis needs*, not the thesis.

**Three things the spec says that I had not internalised:**

1. **§3.2, what Mitra is not** — not a payment protocol, not a marketplace, not a
   wallet, not a bridge. "Marketplace-interoperable, not primarily a marketplace."
   This is why §2.1 demands adapters to A2A, MCP, ERC-8004, ERC-8183, x402 and MPP
   rather than replacements: an agent must transact with Mitra *without becoming
   Mitra-native*.
2. **§4.6, clearing is distinct from settlement** — clearing determines the
   obligation, settlement moves the asset. I had conflated them.
3. **§1.1, the four primitives form a lifecycle**, not a feature list: Authority →
   Commerce → Clearing → Recovery. My phase audit treated Phases 3–10 as
   independent items with independent blockers, which understates their
   dependency.

**The spec also pre-empts the overclaims this repository has guarded against**,
which is a sign of a well-written document: *"A mocked marketplace response must
not be described as a live marketplace integration"* / *"A local clearing result
must not be described as decentralized clearing"* / *"A testnet settlement must
not be described as production settlement."* And: *"Mitra must not claim that it
invented deferred agent payment"* — x402, Payment Channels and MPP all predate it.
The value is composition, not invention.

**Not recorded as a gap in the product** — the PRD and spec do not contradict each
other; the thesis lines are concordant where both speak. The failure is entirely
mine: I read one of two documents and did not notice the other existed, for ten
days, while writing twenty-one records about exactly this class of error.

**Guard.** `tests/spec-parity.test.ts` asserts the defining statements of the
product — thesis, category, the four primitives, the "is not" list — are present
in the spec, and that the PRD is consistent with it where it overlaps. A future
reader can no longer build from half the specification without the suite failing.

**Rule.** When a governing document names its sources, read all of them before
building. "I read the important one" is a judgement no one can audit, and it is
the judgement that produced this record.

## F24 — two of the four §50 substrate repositories were never located

**Found** 2026-01-10, running the substrate audit that PRD §50 requires.

PRD §50 says to reuse semantics from **four** inherited projects: Engraving,
Microcosm, Cleara, TALOS (with Noema explicitly non-core). Ten days of work
never touched any of them — recorded as F23. On auditing properly:

| Project | Status | Evidence |
|---|---|---|
| **Engraving** | FOUND | `/home/ubuntu/engravings`, remote `github.com/etvjay/Engraving.git` |
| **Cleara** | FOUND | `/home/ubuntu/ClearaOnGen`, remote `github.com/etvjay/ClearaOnGen` |
| **Microcosm** | FOUND — **not where expected** | `/opt/microcosm-x`, remote `github.com/Jaydearcadian/microcosm-x.git`. Runs as a systemd service (`microcosm-server.service`, `active`). FORGE 1.4, 189 tests |
| **TALOS** | **NOT FOUND** | Exhaustive case-insensitive search of `/` to depth 6: zero hits. No `*recovery*`/`*saga*` rename candidates in `/home/ubuntu` or `/opt` |

**Microcosm being at `/opt` rather than `/home/ubuntu` is the instructive part.**
It sits beside the two siblings, in the same PATH-visible location, running as a
service. Two searches of the obvious directory missed it; only a filesystem-wide
sweep found it. A "the inherited repos aren't here" conclusion drawn from one
directory listing would have been wrong on one of two counts.

**TALOS is a genuine `BLOCKED_EXTERNAL`.** The PRD instructs Mitra to integrate
`Saga`, `Recovery Covenant`, `STN Delta accounting`, explicit `RECOVERED` vs
`CONTAINED` semantics, and bounded recovery routes from it. §50 names it; no
implementation is present. Phase 6's exit condition — *"Deliberately failed job
reaches a defined terminal recovery state"* — can be built, but any claim that
it reuses TALOS semantics would be **unsupported by construction**.

Note that Mitra's own `lib/store/seed.ts` already contains a TALOS recovery
event (`evt_501_10`, `RECOVERY_PENDING`, `REASSIGN_APPROVED_PROVIDER`), so the
*concept* is present as seeded data while the *source* is unavailable. Seed data
describing a system is not evidence that the system was studied.

**Rule.** Before recording a dependency as missing, search the whole filesystem,
not the directory where you expected it. And distinguish "the concept appears in
our seed data" from "we have read the implementation" — the first is a fixture,
the second is a substrate audit.

## F25 — the replay guarantee was untested at the point it is enforced

**Found** 2026-01-10, by mutation-auditing Phase 3c.

Phase 3c's first test suite passed 10/10 and was reported as covering the
consumable authorization. It was not. The suite exercised
`Authorization::spendable_at` — the *type* — while the security property lives in
the *handler*, which is what writes `consumed = true` and moves the lamports.

Mutation testing made the gap concrete:

| Mutation | Result |
|---|---|
| Delete the consume write from the handler | **0 tests failed** |
| Set `consumed = false` instead of `true` in the handler | **0 tests failed** |
| Delete the replay check from `spendable_at` (the type) | 3 tests failed |

So the suite was green against a build in which **replay protection had been
removed outright** — while it reliably detected damage to the method nobody's
security depends on. Deleting the *handler's* consume step is the mutation that
matters, and nothing saw it.

**Fixed** by `tests/spend_integration.rs`, which drives the real handler through
`dispatch()` with real `AccountInfo`s. All three mutations are now caught, and
the replay test asserts not only that the second spend errors but that
`recipient_lamports` and `vault.available` are **unchanged** — "it returned an
error" would not catch a handler that errored after moving the value.

Two corrections fell out of the same work, both recorded in the code:

1. **The "consume first" comment was a false security claim.** It asserted that
   inverting the order would leave value moved with the permit unspent. It would
   not: replay is a *separate transaction*, and within one transaction both
   orderings end in the same state under Solana's atomicity. The inverted mutant
   is undetectable *because it is not a defect*. The ordering is kept for two
   weaker but real reasons (a future CPI between the steps; readability), now
   stated as what they are.

2. **The first fixture modelled a cross-mandate replay.** It gave the mandate and
   the permit independent holders, so every test failed `6008` UNAUTHORIZED. The
   handler was correct; the fixture was wrong. Worth recording because the
   instinct on seeing six red tests is to loosen the assertion — here that would
   have deleted a real guard.

**Rule.** A test that exercises a method but not its caller has not tested the
property anyone relies on. And when a mutation is *undetectable*, ask whether it
is a coverage hole or a **false claim in a comment** before adding a test to
paper over it — the second is a documentation bug that a test would cement.

## F26 — accounts created at the bare rent minimum could not be written to

**Found** 2026-01-10, on devnet during the Phase 3 run.

`rent_for_bytes` returned `Rent::minimum_balance(len)` — *exactly* the minimum for
an account to be rent-exempt at creation. Consuming a permit is a one-byte write
to a 98-byte authorization, and that failed:

```
InsufficientFundsForRent { account_index: 2 }
```

An account created at precisely the minimum cannot be written to: the runtime
rejects any transaction that would leave a data-carrying account below its
minimum. The vault was unaffected because its lamports *move through* it, so it
always holds a balance; the authorization was created at the bare minimum and only
ever needed writing.

Fixed with `rent::rent_exempt_with_headroom` — a 2x multiplier, so an account
created today cannot fall below the minimum if rent parameters change with a
cluster-wide vote. The authorization on devnet now shows 1_148_080 lamports of
slack. The pre-existing mandate still shows 0 and is reported as an INFO, not a
failure: it is a pre-fix artifact, and asserting on it would fail forever while
proving nothing.

## F27 — the harness reported its own bugs as program refusals

**Found** 2026-01-10, the same run. The more instructive failure, and the reason
`HARNESS_ERRORS` and `checkRefused` exist.

Four separate defects in `scripts/authority-devnet.mjs` each produced output that
read like a *correct* program rejection:

| Harness fault | Printed as | Reality |
|---|---|---|
| Airdrop failed with 429, logged and continued | downstream `0x1` failures | unfunded signer |
| `spend_ix` sent no signers | `REPLAY REFUSED` → **PASS** | transaction never ran |
| `engine.publicKey` (undefined) | `toString of undefined` | JS TypeError |
| Recipient left at 0 lamports | `InsufficientFundsForRent` | not a program error |

The second is the dangerous one. A transaction that never reached the program has
refused nothing, and the harness counted it as evidence for the exact property
the product exists to provide. **A green replay check was manufactured from a
harness bug.**

Fixed by:
- `checkRefused`, which refuses to count a transaction as a program refusal if
  the error matches harness faults (`no signers`, `prior credit`, fetch failures),
  and says so loudly when it does;
- `TypeError`/`ReferenceError` surfaced with a stack instead of being swallowed
  into a "refusal" string;
- failed funding is now **fatal** — a harness that continues past an unmet
  precondition will report its own bugs as the system's;
- funding by **transfer from the funded authority** rather than airdrop, because
  the devnet faucet is rate-limited and returned `429 ... faucet has run dry`.

A fourth error, `insufficient account keys for instruction`, was a genuine
interface mismatch: the `create_account` CPI needs a fourth account (the program
account) that the harness was not sending. **No in-process test could have caught
it**, since `dispatch` is called with whatever `AccountInfo`s the test chooses and
never exercises a real CPI. This is the entire reason the on-chain harness exists.

### A note on how I found account 2

I guessed wrong three times — authz PDA, then vault, then mandate — before
reading that the runtime's `account_index` counts the fee payer and the program
id, making index 2 the *first instruction key*, the recipient. The error named the
index; I spent several turns not reading it. Where a tool reports a precise
coordinate, use it before forming a hypothesis.

## F28 — the same mistake three more times: tests that named a property and did not exercise it

**Found** 2026-01-10, by mutation-auditing Phase 3b. F25 was "the suite tested
the type, not the handler". Phase 3b repeated it **three separate times** in one
sitting, each time wearing a more convincing costume.

| Test | What it asserted | What it should have asserted |
|---|---|---|
| `tightening_does_not_strand_an_already_issued_permit` | compared two local variables: `50_000 <= base().limit` | amend the mandate, then **SPEND** through the handler |
| `revocation_stops_an_outstanding_permit` | amended fixture **A**, spent fixture **B** | one world: amend the same mandate the spend reads |
| `the_version_never_resets_or_wraps` | called `saturating_add(1)` on a local — a property of the standard library | amend a mandate at `u64::MAX` through the handler |

All three passed against a build where the property was absent or broken, and all
three were caught only by deleting the relevant line and observing that nothing
failed. The names were accurate; the code was not. A test whose *name* states the
guarantee is the most dangerous kind, because a reviewer reads the name and moves
on.

**And the mutation it missed was a live security hole.** `spend_authorized`
checked neither `mandate.revoked` nor anything else about the mandate's current
state, so a revoked mandate still spent. Revocation was a flag nothing read. The
correct test — amend, then spend — found it immediately.

### The rule, now written down

A test that mentions a handler is not a test of that handler. Either call the
handler, or do not claim the property. The question to ask is not "does this test
look like it covers the guard?" but **"which line of production code would have to
change for this test to go red?"** If the answer is "none", it is not a test.

The second failure is its own lesson: two fixtures standing in for one world.
Amending mandate A and spending against mandate B will always succeed, and the
failure looks exactly like a missing guard in the program. Fixtures must share the
accounts they claim to share.

## F29 — a fixture that cannot happen on chain, three times over

**Found** 2026-01-10, same sitting.

- `amend_mandate` tests used a random program id. The handler re-derives the PDA
  from `[b"mandate", holder]` and refuses a mismatch, so **every case failed
  `InvalidSeeds`** — a defect in the fixture that read as a product defect.
- The signing holder was hardcoded to `[1u8; 32]` while the mandate's holder was
  `[3u8; 32]`. Same refusal, same misreading.
- `AccountInfo::new` needs a `&mut u64` per account, and a `&mut f()` temporary is
  dropped mid-statement; three such attempts before the borrow was bound to a
  local.

The program id is now a `PROGRAM_ID_BYTES` constant with a test asserting the exact
bytes — the first version of that test only checked "not all zeros", which is
precisely the check a one-digit typo survives. The repo now has a real
`program_id()` for fixtures to derive against, instead of each inventing one.

**Rule.** When a test fails, the first hypothesis is the test. Loosening an
assertion to make it pass is how a real guard gets deleted; reaching for the
fixture instead is how the suite keeps its meaning.

## F30 — three harness faults that surfaced as policy refusals, and a slice that destroyed the file

**Found** 2026-10-02, running Phase 3b against devnet.

F27 established that a harness bug can print like a correct rejection. Phase 3b hit
the same class **three more times**, each one costing a debugging round because
the symptom was a program error code:

| Harness fault | Printed as | Reality |
|---|---|---|
| Agent funded for exactly one account's rent | `0x177b` (6010 EXCEEDS_MANDATE_CEILING) | needs to also pay the transaction fee |
| Engine funded for one permit only | `0x177b` (6010) / system program `0x1` | the engine pays rent for *every* `authorize` |
| Mandate expired hours earlier | `0x177b` (6010) | really 6011 MANDATE_EXPIRED |

The third is the instructive one. `EXCEEDS_MANDATE_CEILING` for an **expired**
mandate is not a plausible reading, and it appeared only because nobody asked what
the on-chain `expires_at` said. A stale mandate silently poisoned several runs,
each reporting a *ceiling* problem that did not exist.

Fixed by checking preconditions where they arise and **naming** them:

| Exit | Meaning |
|---|---|
| 2 | cannot fund a signer — every later check would be meaningless |
| 3 | this action's permit was already spent; steps 4-9 did not run |
| 4 | the mandate is revoked or expired — terminal, re-run with a new agent |

Exit 3 matters on its own. The harness used to `process.exit(0)` with
"ALL CHECKS PASSED" after skipping half the run, which is F27 one level up: a
green result manufactured by a short circuit.

### The slice that ate the file

While adding retry-on-429, a Python `s.replace(old, new)` used a slice anchored on
`/** The one-line reason a transaction failed */` — but the same comment text
appeared earlier in the file, so the replacement consumed **348 lines**,
including every `process.exit` and steps 8-9. The script then exited 0 immediately
after printing its header, with no error.

Recovered with `git checkout scripts/authority-devnet.mjs`, then reapplied the
retry with a precise editor replacement and a `node --check` gate. The uncommitted
steps 8-9 were lost; they are reimplemented in Rust instead, where `amend_mandate`
is covered against the real handler by `amend_integration.rs`.

**Rules.**
- A `str.replace` whose `old` was located by `find()` must assert the match is
  unique. `assert old in s` catches "not found" and not "found twice".
- After any bulk edit of a script, run it and check it *produces output*, not just
  that it parses. A 486-line harness that prints a header and exits 0 is a silent
  deletion, and `node --check` reported it as valid.

## F31 — I declared BLOCKED_EXTERNAL without attempting the prerequisite

**Found** 2026-10-02, while planning Phase 3d.

Phase 3d's Arcium integration was recorded `BLOCKED_EXTERNAL`: "Arcium's testnet
runs MPC nodes in Docker containers; Docker is not installed; disk is 95% full."
Both statements were true, and the conclusion was **not** — because I never tried
to install it.

Attempted instead of assumed:

| Step | Result |
|---|---|
| `sudo -n true` | exit 0 — passwordless sudo available |
| `apt-get install docker.io` | exit 0 — Docker 29.1.3 |
| `usermod -aG docker` | `sg docker` now works |
| `arcup install` | exit 0 — Arcium CLI, Arx Node, Trusted Dealer 0.15.0 |
| all 5 prerequisites | Rust 1.98, Solana 4.3.0, Yarn 1.22.22, Anchor 1.0.2, Docker 29.1.3 |
| `arcium init probe` | full scaffold, yarn deps in 4.46s |
| Arcis circuit written | `MandatePolicyInput` -> `MandatePolicyOutput` |

The Arcium privacy path was **buildable the whole time**. What I had was an
*environmental inference* — "Docker isn't here, so the network can't run" —
wearing the costume of a blocker. The spec's own vocabulary reserves
`BLOCKED_EXTERNAL` for "names the exact dependency or repository defect". I named
a directory that could be populated with one command.

Two process rules follow:

1. **A blocker must be an attempt, not an observation.** "X is absent" is a
   state. "I ran the command and X failed with error Y" is a blocker. The
   difference is one command, and the cost of conflating them is a phase
   falsely written off.
2. **Disk space at 95% is a constraint, not a prohibition.** It was 6.9 GB free,
   and the images needed ~1.4 GB. I treated a number as a wall.

Corrected: Phase 3d moves from `BLOCKED_EXTERNAL` to in progress, and the
`DEFERRED`/`BLOCKED_EXTERNAL` entry it produced in `PROOF_LEDGER.md` is
superseded by this record.

## F33 — Space.agreementIds duplicated a relationship with nothing enforcing it

**Found** 2026-10-02, while grounding Phase 4.

The `Space` type carried `agreementIds: string[]` alongside `Agreement.spaceId`.
The database has a real foreign key from `agreements.space_id` to `spaces.space_id`
with `ON DELETE RESTRICT`, so the **agreement** side is enforced. The **Space** side
was enforced by nothing: no FK, no consistency check, no read-path verification.

So the same fact was stored in both directions with one direction checked, and the
unchecked one could contain:

- an agreement that does not exist,
- an agreement belonging to a **different** Space,
- a stale entry after an agreement moved.

Nothing would ever have reported it.

**How it survived:** I added the field and the foreign key in the same change and
described the FK as making containment "structural". It does — for one direction.
I checked the direction that was already guarded and did not ask what guarded the
other. The seed data was consistent, one test asserted the list contained the new
id, and the whole thing looked wired. This is the same shape as F24: fixtures
agreeing with each other is not evidence that anything enforces them.

**Fixed** by deleting the field. The relationship is `Agreement.spaceId` plus
`SELECT * FROM mitra.agreements WHERE space_id = $1` — one direction, enforced,
and the reverse question answered by query rather than by a second copy. A field
that exists only to be kept in sync is a defect waiting for the first missed
update; deleting it takes the risk to zero instead of trading it for a check
nobody would remember to write.

Two tests pin the removal, and both are mutation-checked: an agreement written with
a wrong `spaceId` fails 1 test, and a `?spaceId=` filter that ignores its argument
fails 3. The second assertion also proves the information is genuinely not lost —
it walks every Space and checks the scoped query returns exactly the agreements
naming it.

Recorded in `docs/adr/0010-space-is-a-scope-not-a-container.md`, together with the
two fields I invented (`SpaceStatus`, `settlementChains`) and the two spec-listed
contents I did not build (`Disputes`, `Treasury`).

**Rule.** When a relationship is stored in both directions, establish which
direction is actually enforced before describing the pair as structural. Adding a
foreign key protects exactly one side, and the side you just wrote is the one
already covered by the id you were about to add anyway.

## F34 — the saga machine was missing ARMED, which was a safety gap

**Found** 2026-10-02, building Phase 6 against PRD §15.

The implemented `saga` machine went `DECLARED -> EXECUTING -> RECOVERY_PENDING ->
RECOVERING`. PRD §15.3 specifies:

```
DECLARED -> ARMED -> EXECUTING -> STEP_FAILURE -> COMPENSATING
                                                  -> {RECOVERED, CONTAINED, ABORTED}
```

Three states were missing. **`ARMED` was not a naming preference — it was a
missing safety state.**

PRD §15.5: *"A compensation route must be committed before execution when
possible. Never let the recovery engine invent arbitrary compensation calldata
after failure."*

`ARMED` is the state in which the route is committed. Without it the table
permitted `DECLARED -> EXECUTING` directly, which is a path to irreversible action
with **no defined way back** — and, on failure, exactly the situation §15.5 forbids:
the recovery engine with nothing committed and therefore obliged to invent
compensation.

Fixed: the machine is now §15.3 verbatim, `SagaStatus` follows, and
`lib/kernel/recovery.ts` enforces the commitment — `startSaga` refuses anything
not `ARMED`, and `armSaga` refuses a route with `maxAttempts <= 0` or an empty
body, because a route that cannot execute is not a commitment.

**How it survived:** `docs/STATE_MACHINES.md` documented the *implemented* table
without ever mentioning that §15.3 says something different. A doc that restates
the code is not evidence the code matches the spec — the same shape as F24 and
F33. Nobody had compared the two.

**Two smaller things found alongside it.** `RunStatus` legitimately contains
`RECOVERING`, and a broad `sed` renaming saga states hit it too; the type system
caught the collision and the line was reverted. And `failure-lab`'s
`PROVIDER_TIMEOUT.expected` still says "Saga enters RECOVERY_PENDING", a state
that no longer exists — left in place and asserted against, because a fixture
quietly rewritten to match the code is how F24 happens.

Mutations 6/6 caught: DECLARED->EXECUTING edge permitted, compensation invented
for an unknown route, CONTAINED collapsed into RECOVERED, multi-step saga allowed
with no route, recovery triggered on the first step rather than the last, arming
with an unexecutable route.

## F36 — Postgres had never run, and the two backends served different worlds

**Found** 2026-10-02, running the suite with `DATABASE_URL` set for the first time.

The persistence tests had been gated on an unset `DATABASE_URL` for the entire
life of the repository — 15 tests, never executed, `PostgresRepository` written,
typechecked against the interface, and **run zero times**. Its own file said
`Evidence level for persistence remains DESIGN_ONLY`, which was honest and
therefore easy to leave alone.

Postgres 16 was installed and *running* the whole time, and the role and database
already existed. The environment had been prepared and never wired up.

### What running it actually found

**1. `emergency_freeze` had no test at all.** Mutation audit removed BOTH guards —
the JS check and the `emergency_freeze = FALSE` SQL predicate — and broke **zero**
tests, because the fixture only ever inserted `emergency_freeze = FALSE` and
nothing ever froze a vault. A capital-protection control whose only coverage was a
`grep` in review. Three tests added; both guards removed now fails 2.

**2. `FOR UPDATE` does not do what its comment claimed.** Removing the row lock
also broke nothing — because the guarantee comes from the conditional UPDATE
(`WHERE available >= $1`): under READ COMMITTED a losing racer's UPDATE matches
zero rows and it rollbacks. The lock reduces wasted work between racers. The
comment claiming it was the mechanism has been corrected rather than left to
mislead the next reader.

**3. The two backends disagreed, and only the database revealed it.** With
`DATABASE_URL` set, three commerce tests failed with *"expected 0 to be greater
than 0"*: `seedReferenceData` persisted vaults, mandates and reservations but
**not spaces or agreements**. The in-memory backend serves those from `seed.ts`;
the Postgres backend had never been given any. So the suite was green whenever
`DATABASE_URL` was unset and broken whenever it was set — and unset is the default.

Fixed by persisting spaces and agreements, spaces first because
`agreements.space_id` references `spaces.space_id`. `InMemoryRepository` now
reports its real counts rather than zeros, so the two backends describe the same
world.

**The generalisable failure.** A gated test is not a slow test, it is an absent
one that reports itself as present — it appears in the file, it appears in the
count, and it never runs. The evidence discipline this repository applies to
on-chain claims was never applied to the storage layer.

**Rule.** If a test is gated on an environment variable, something must assert
that the gate has been opened at least once. `15 skipped` in a passing suite is a
claim that was never gathered, wearing the same green as the ones that were.

## F37 — the backends-parity test found F36 was not actually fixed

**Found** 2026-10-02, closing out the audits.

F36 fixed four routes that served fixtures. But the mutation audit for that work
immediately asked the obvious question — **would anything stop the two backends
diverging again?** — and the answer was no. Making
`InMemoryRepository.listObligations` return `[]` broke **zero** tests. The
repository methods existed and both backends compiled; nothing asserted they
agreed, so the F36 defect could return by editing one line in one file.

`tests/backend-parity.test.ts` is that assertion, and it found four more defects
on its first run:

1. **`rowToVault` hardcoded `activeMandates: [], activeReservations: []`.** A
   Vault read from Postgres was missing two fields the domain type declares, and
   no test noticed because every vault assertion read from whichever backend was
   selected. Fixed by deriving them.

2. **`seedReferenceData` reported rows inserted by *that call*, not world size.**
   A second call reported 0 for everything. "Seeded" is a claim about the store,
   not about the call.

3. **`InMemoryRepository` reported 0 for vaults, mandates and reservations it
   demonstrably held.** The in-memory half of the F36 disagreement.

4. **The ledger carried `activeReservations` from the SEED rather than deriving
   them** — so a released reservation still read as active. **This is F33 again in
   a different object**: a declared list stored beside the fact, free to drift,
   while the Postgres backend derived the same field from live state. The two
   backends were answering different questions about the same vault.

### Two test bugs of my own, both of which had been reported as real divergence

- **`JSON.stringify` is the wrong comparison.** JSONB does not preserve key
  order, so identical data serialises to different strings and every parity check
  failed on a divergence that did not exist. A false alarm is worse than no alarm:
  it trains everyone to ignore it. Replaced with a canonical key-sorted form.
- **Vaults cannot be compared field-for-field.** They are mutable state, and the
  persistence tests move their balances, so the Postgres vault was compared
  against a fresh in-memory ledger. Narrowed to identity — plus a targeted
  assertion for the derived fields, so narrowing the comparison did not quietly
  drop the coverage that had just found bug (1).

**Rule.** Two implementations of one interface are not the same thing, and a
contract that both satisfy is a contract about *shape*, not about *behaviour*.
Nothing in the type system can assert that two backends return the same data, so
something outside it must — otherwise "consistent" means "compiles".

## F38 — the ERC-7715 delegation digest omitted the domain, so it replayed across chains

**Found** 2026-10-02, building ADR-0011 open item 5.

`delegationDigest(input)` destructured `input.domain`, **validated the addresses
inside it**, and then never used it in the hash. The EIP-712 domain separator is
what stops a signature meaning one thing on chain A and another on chain B; a
digest without it is chain-blind.

So a delegation signed on one Base deployment — same delegate, same ceiling, same
validity window — would verify on **every** Base deployment. The `validAfter` /
`validUntil` bounds and the `maxValue` ceiling were all still enforced, which is
what made it hard to see: the delegation looked bounded in every way a reader
would check by eye, and was unbounded in the one way that mattered.

**How it was caught.** Not by a mutation I chose, but by a test assertion —
"the digest changes with the chain id" — that failed against correct-looking code.
I had written the assertion assuming the domain was included, and its failure is
what exposed that it was not.

This is the **same defect class twice**: the settlement commitment originally used
FNV-1a over the fields alone (fixed when EIP-712 landed), and now a delegation
digest ignored the domain while looking EIP-712-shaped. Both times the code had
the vocabulary of a bound commitment and none of the binding.

**The rule, now stated once:**

> If a function takes a domain, verify it is in the HASH, not just in the
> signature. Validating a parameter and then discarding it is the most expensive
> kind of unused argument, because the type says it matters.

Fixed: the EIP-712 `domainSeparator` is computed first and hashed as the first
field, in the spec's exact type order. The chain id is now bound; a delegation
cannot cross deployments.

Mutations 7/7: domain removed from the digest, delegate unchecked, ceiling
unenforced, expiry made exclusive, Virtuals running under Mitra's rules, unknown
marketplace state coerced to REJECTED, pricing in an unadmitted asset.

## F39 — I invented a Tempo token address, and the tests validated the invention against itself

**Found** 2026-10-02, while enumerating deployment credentials.

`lib/adapters/tempo.ts` shipped:

```ts
USDC: { symbol: "USDC", mint: "0x5dDFa3e0d2C9d0dF4D6b1C6bA9E1A0eD4C5f2B1", decimals: 6 }
```

**That address does not exist.** And neither does USDC on Tempo: Moderato settles in
TIP-20 tokens — OUSD, pathUSD, AlphaUSD, BetaUSD, ThetaUSD. It was typed to satisfy
`Record<string, {...}>`, never checked against a node, and shipped inside a
`TESTED` phase.

### Why every test passed

`tests/tempo-adapter.test.ts` read `TEMPO_TOKENS.USDC.mint` and asserted things
about it. **A test that reads a constant out of the module under test cannot detect
that the constant is wrong.** The suite validated the invention against itself, which
is the same shape as F24 (fixtures agreeing) and F36 (backends self-consistent).

### The root cause was the TYPE

`AssetSymbol` was `"USDC" | "USDT" | "SOL" | "ETH"`. A Tempo settlement **could not
be expressed**, so something had to be invented to fill the gap. The type created
the pressure; the lie relieved it.

Fixed on both levels: `AssetSymbol` now includes the five TIP-20 symbols, and the
registry holds the mints read from Moderato. The test now **PINS** all five values,
asserts no USDC exists, and notes that BetaUSD (`0x20c0…6a37da5c996874be`) breaks
the `0x20c0…<index>` pattern the other four follow — so any code inferring addresses
by pattern would silently miss it.

### Why this one matters more than the other 38

Every previous failure was a missing or broken **control**. This one was a
**fabricated fact about an external system**, presented as verified. It is the one
failure mode that makes an evidence record actively misleading rather than merely
incomplete — and it survived because it sat inside a phase I had already reported as
`TESTED` with a mutation audit behind it.

**Rules.**
1. **An address that names something outside this repository is a CLAIM until read
   from a node.** No exceptions for "well-known" constants.
2. **A test that reads a constant from the module under test is not a test of that
   constant.** Pin it against an independent source, or delete the test.
3. **When a type cannot express the domain, widen the type.** Inventing a value to
   satisfy a type is a design failure dressed as a convenience.

Also confirmed live this session: **F12 still holds.** `eth_getBalance` on
Moderato returns a repeating constant (tail `4c9b26c9b26c9b26c9b2`), and Tempo's
RPC rejects `topics` arrays in `eth_getLogs` entirely.

## F40 — the F39 "correction" was itself a fabrication, on 4 of 5 entries

**Status:** `FAILED` — caught by reading the chain, not by the test suite.
**Found:** 2026-02-10, re-enumerating Moderato after being asked to explain Tempo
deploy/pay semantics and finding no way to answer honestly from the existing code.

### What happened

F39 removed a fabricated `USDC` mint and replaced it with a five-entry registry
claiming to be read from Moderato. **That registry was wrong too.** Calling
`name()` on each address:

| Address | F39 claimed | Actual on Moderato |
|---|---|---|
| `0x20c0…0000` | `OUSD` | **PathUSD** |
| `0x20c0…0001` | `pathUSD` | **AlphaUSD** |
| `0x20c0…0002` | `AlphaUSD` | **BetaUSD** |
| `0x20c0…0003` | `ThetaUSD` | ThetaUSD (correct by luck) |
| `0x20c0…6a37da5c996874be` | `BetaUSD` | **OpenUSD** |

**There is no `OUSD` on Moderato.** The names are shifted by one position, and the
one address F39 flagged as breaking the index pattern is a different token
entirely. Enumeration over indices 0–12 shows exactly four indexed mints —
PathUSD, AlphaUSD, BetaUSD, ThetaUSD, all 6 decimals — and nothing at indices 4+.

### Why nothing caught it

The pinning test asserted `expect(TEMPO_TOKENS).toEqual({...the same literals...})`.
Asserting a literal against the object it was copied from cannot fail for any reason
other than someone editing the test. It confirmed the second fabrication was
*internally consistent*, which is not the same as being true.

This is the sharper form of F39's lesson. F39's rule 2 said "a test that reads a
constant from the module under test is not a test of that constant" — and then the
replacement test did the same thing with a different set of literals. **Two
self-referential copies do not corroborate each other.** Only an assertion against a
source outside the repository can contradict a constant.

### Changes

- `lib/adapters/tempo.ts` — registry corrected to the five names read from Moderato,
  including `OpenUSD`. Both fabrication rounds documented inline.
- `lib/domain/types.ts` — `AssetSymbol` no longer offers `OUSD`/`pathUSD`, which do
  not exist; it now matches the verified set. The comment states explicitly that
  widening a type does not make a name true.
- `tests/tempo-adapter.test.ts` — the literal-table assertion is **deleted**, not
  rewritten. Replaced by property assertions (symbol equals key; no native symbol;
  exactly the verified set) plus an opt-in live test (`TEMPO_LIVE=1`) that re-derives
  every `name()` from `rpc.moderato.tempo.xyz`. Verified passing: 842 ms, real
  network round-trips, 28/28 in the file.
- `scripts/_tempo-enumerate.mjs` — the enumeration that produced the table.

### Rules added

4. **A constant pinned by a literal is pinned to nothing.** Pin to a source outside
   the repository, or accept the value is unverified and say so.
5. **Correcting a fabrication is itself an unverified claim.** Re-derive from the
   source; never copy the previous claim forward.
6. **A helper that silently ignores an argument is worse than no helper.** viem
   2.57's `getContractAddress` ignored the `salt` I passed and returned the same
   stable address for every input, so a whole version sweep "proved" nothing while
   looking rigorous. Where an argument's effect is the thing being tested, compute it
   by hand or assert the argument changes the result.
7. **Derive selectors, never guess them.** `getAddress(address,uint256)` is
   `0x8cb84e18`; I guessed `0xa71d9d0d`, got `execution reverted`, and concluded the
   function did not exist. It does. A revert is not evidence of absence.

### Also established live (Tempo deploy/pay semantics)

`scripts/tempo-pay.mjs`, all checks passing against Moderato:

- **DEPLOY** is plain EVM deployment. Observed tx
  `0xc1426fd3b6583d6e439a79e5aea509eb6419deaf4b9c0021596abd42d075fb1a`, status 1,
  block 37868915, contract `0x1c7f0ae261dd84954af3234cb769ce7abd66484d`, 54 bytes
  of code. No Tempo-specific step exists or is needed.
- **PAY** must be a TIP-20 transfer. Native value is **refused outright**:
  `eth_sendRawTransaction` with `value: 1` returns `"value transfer not allowed"`.
- **TIP-20 transfers levy a fee in the transferred token**, separate from gas: a
  self-transfer of 1.000000 PathUSD emitted two `Transfer` events — 1.000000 to the
  recipient and **0.000032 to `0xfeec…0000`**, the fee vault. So a self-transfer is
  *not* balance-neutral here, and **payment confirmation must come from decoded
  logs, never from a balance delta.** This briefly presented as a failed 1.000000
  payment until the logs were read.
- **`eth_gasPrice` lags.** It reports ~0.6 gwei while receipts show an effective
  1.2 gwei. Signing at `gasPrice × 1` is rejected; use a margin.
- **`eth_getTransactionCount` must use `"latest"`**, not `"pending"` — the pending
  nonce lags the mined one and produces repeated `nonce too low`.

## ERC-4337 — blocked, but for a precise and different reason

`scripts/base-4337.mjs` runs the bundlerless path: build a UserOperation, sign it,
call `entryPoint.handleOps(...)` directly from a funded EOA. Confirmed live:

- EntryPoint v0.7 is deployed on Base Sepolia: **16,035 bytes** at
  `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
- SimpleAccountFactory is deployed: **3,238 bytes** at
  `0x9406Cc6185a346906296840746125a0E44976454`, and it behaves like a genuine
  factory — `createAccount(owner, salt)` varies correctly with both salt and owner,
  and agrees with `getAddress(owner, salt)`.

**The remaining blocker is bytecode, not infrastructure.** The factory's own
`getAddress` derives `0x0c9442D9…`, while every published npm artifact
(`@account-abstraction/contracts` v0.5.0, v0.6.0, v0.7.0, v0.8.0, v0.9.0-rc.1)
across three constructor encodings derives something else. **No match.** The
deployed factory's SimpleAccount is not any of those published builds.

The script therefore **fails closed**: it compares its own CREATE2 derivation
against the on-chain factory, and exits `2` without sending anything. Spending
testnet ETH on an initCode known to be wrong buys nothing.

Also recorded, because both cost real time:

- The factory exposes **no** `getCreationCode()` — every candidate selector reverts.
- The pre-fund step initially over-drew the owner (0.005 ETH requested against
  0.0049997 available); it holds 0.015 ETH, less than had been assumed.
- Gas estimation must exceed ~772k for a deployment; a 200k cap failed with
  `call gas cost (771740) exceeds the gas limit (200000)`.

**Not claimed:** any UserOperation has been executed. No bundler, no paymaster, no
sponsorship, no batching.

## F41 — a frozen vault could be drained, and an invariant was discharged by a false absence

**Status:** `FAILED` — the defect was real; the fix is `TESTED` (16 tests, 2 mutations killed).
**Found:** 2026-02-10, while closing `FR-VAULT-006`.

### The defect

`withdraw` in `programs/mitra-vault/src/lib.rs` did its arithmetic **inline in the
handler**:

```rust
vault.available -= amount;
vault.total -= amount;
vault.reconcile()?;
```

Its sibling `reserve` calls a state method that checks `is_frozen()` first.
`withdraw` had no such check. **A frozen vault could be drained.**

An emergency freeze is the control an operator reaches for when value is at risk.
The one operation it most needed to stop was the one operation it did not stop — and
because the arithmetic was inline, there was no single place where the rule could
have been applied, and no state-level method to unit-test.

### Why it survived

`FR-VAULT-006` was recorded `UNTESTED` with the rationale:

> The invariant holds by *absence*: there is no withdrawal route at all.

**That was false.** `withdraw` had been in `lib.rs` the whole time. The missing thing
was a test, not a path. The note discharged the invariant by asserting a state of
the world nobody had checked — and had anyone checked, it would have failed. An
invariant "held by absence" that was never verified is not weaker evidence than no
claim; it is a claim that actively conceals the work.

### The fix

The rules moved into `Vault::withdraw` (`state.rs`), alongside `deposit`, `reserve`
and `release`, so a handler doing its own arithmetic can no longer bypass them.
The freeze asymmetry with `release` is deliberate and documented: `release` moves
capital *within* the vault and must stay permitted while frozen or an emergency
strands in-flight obligations; `withdraw` moves capital *out*, which is what a
freeze exists to stop.

### The part worth keeping

**Type tests alone did not catch it.** After the fix, a mutation restoring the
pre-F41 inline handler shape — `if amount <= vault.available { ... }`, never
calling `Vault::withdraw` — left the **entire Rust suite green**: 9 of the new
tests and all 72 pre-existing ones. The new tests proved the *rules exist*; they
did not prove the *instruction* obeys them.

This is the gap `spend_integration.rs` was written for, found again in a different
handler. Two further tests now drive the real `mitra_vault::dispatch` with real
`AccountInfo`s, and they kill that mutation (2 failures). The negative case
(*an unfrozen vault must allow withdrawal*) is included so "always refuse" cannot
pass either way.

**Not covered:** `invoke_signed` and genuine lamport ownership need a chain;
`scripts/vault-devnet.mjs` is the counterpart.

### Rules added

8. **"Holds by absence" must be checked, not assumed.** An invariant discharged by
   a claimed absence is a claim. Verify the absence, or record the invariant
   `UNTESTED` *because it is untested* — never because a path is believed absent.
9. **Inline arithmetic in a handler bypasses every state-level guard.** Capital
   rules belong in the state type, where they are testable and cannot be skipped.

## F42 — a Space's budget was a lifetime cap, and the fix introduced an untested double-release

**Status:** `FAILED` — the defect was real; the fix is `TESTED` (10 tests, 2 mutations killed).
**Found:** 2026-02-10, while closing `FR-COM-001/002/003`.

### Two defects, and the second was introduced by fixing the first

**The defect.** `applyAgreementOp` incremented `space.committed` on `fund` and
**never decremented it** — not on acceptance, not on refund. Headroom is
`budget - committed`, so every USDC a Space ever spent stayed spent. A Space with a
100 budget could fund exactly ten 10-USDC agreements *across all time*; the eleventh
failed with `SPACE_BUDGET_EXCEEDED` even though all ten had been accepted and paid
for. The reproduction in the test file shows it failing on agreement index 9.

A budget that behaves as a lifetime expenditure cap is not a rounding issue. It
means a paying Space runs out permanently after its first successes, which is the
opposite of what a budget is for.

**Why nothing caught it.** Every commerce test drove **one** agreement to
completion and asserted the resulting `status`. None asked what the Space could do
*next*. The suite was green against a kernel where the eleventh payment is
impossible.

**The second defect.** The fix released `committed` when an agreement reaches
`ACCEPTED` or `REFUNDED`. But the machine table permits **`ACCEPTED -> REFUNDED`** —
a chargeback — and both states are settlement states. Releasing on either, without
a flag, returns the price **twice**: once at acceptance, again at refund. With other
agreements still encumbered this manufactures headroom **above the budget**, so the
Space can commit capital it does not have.

`escrowReleased` on `Agreement` exists for exactly this, and is why
"Is this still encumbered?" needed an explicit answer rather than a status check.

The double-release was nearly shipped untested. A mutation removing the
`if (agreement.escrowReleased)` guard — leaving the code otherwise correct — left
**27 of 27 tests green**. It was only caught after writing a test that puts a
chargeback next to two live agreements, which no existing test did.

### Also corrected: the citation

All three were cited to PRD **§12**, which is *payment transport* (x402, MPP,
payment channels, ERC-2612) and does not define these invariants. PRD **§13.4
"Escrow invariants"** does, and lists six clauses — "Funds must not be
double-released", "Release requires the correct agreement state", "Duplicate
delivery evaluation must not trigger duplicate release" among them. The citations
were wrong and the recorded coverage was thinner than the spec. Tests now target
§13.4.

### What the tests actually caught in themselves

Three fixture bugs, each of which looked like a kernel defect:

- `driveToAccepted` returned only the agreement, so every op after the first ran
  against a stale Space; the test then asserted `committed === 20` against a Space
  that had never seen the funding.
- `apply` discarded `r.value.space`, dropping the capital update entirely.
- The final assertion used `D.space` — the **pre-fund** Space — instead of
  `fundedD.space`. `expected 10 to be 20` read exactly like the F42 bug.

Because `applyAgreementOp` is pure, a fixture that forgets to thread the returned
Space is measuring stale state, and the kernel is right. Recorded because the first
two were diagnosed by instrumenting rather than by reading, and the instrumented
output is what proved the kernel was correct all along.

### Rules added

10. **A budget is a concurrency limit, not a cumulative total.** Any accounting
    counter that only increments must have a test asserting it returns to zero when
    the obligation settles.
11. **A fix for a leak can introduce a double-release.** When adding a decrement,
    check whether the state machine permits the *same* transition more than once —
    `ACCEPTED -> REFUNDED` was already legal, so two settlement states are not two
    mutually exclusive outcomes. Guard the release with an explicit flag, and test
    the mutation that removes it.

## F43 — the mandate circuit allowed zero-amount actions and reported the same DENY reason for every failure

**Status:** `FAILED` — both defects were real; both are fixed and the circuit recompiles.
**Found:** 2026-02-10, reviewing `arcium-probe/probe/encrypted-ixs/src/lib.rs` before running it.

Neither defect is visible in the artifact. The circuit compiles, its Rust unit test
passes, and `arcium build` reports success for the encrypted module. Both bugs live
in the *reason and validity arithmetic*, which no test exercised.

### Defect 1 — a ZERO-AMOUNT action was ALLOWED

```rust
fn is_nonzero(x: u64) -> u64 {
    // `not_gt(0, x)` is exactly `x >= 1`.
    not_gt(0, x)
}
```

It is not. `not_gt(0, x)` is `!(0 > x)`, which is `x >= 0` — **always true**. So
`is_nonzero(0)` returned 1, `amount_ok` was 1, and the guard four lines above the
call ("a zero amount is never valid") never fired.

The comment asserting the equivalence is what makes this dangerous: it reads as a
proof. `x != 0` is `x > 0`, which is `gt(x, 0)`.

### Defect 2 — every DENY reported `REASON_AMOUNT_INVALID`

```rust
reason = when_allowed(allowed, reason, REASON_AMOUNT_INVALID);
```

`when_allowed(a, r, f) = a*r + (1-a)*f`. Whenever the decision failed, `allowed`
is 0, so `(1 - allowed)` is 1 and the result is **`REASON_AMOUNT_INVALID`
unconditionally**. Reasons 1, 2, 4, 5 and 6 were unreachable.

The circuit's own doc comment states the reason exists "so a DENY can be attributed
without revealing *which limit* was the binding one". The mechanism was a
constant.

### Defect 2b — precedence was inverted

The reason chain used `when(is_zero(x), CODE, reason)` unconditionally, so a *later*
failure **overwrote** an earlier one. A dead mandate that also breached
`max_transaction` reported `MAX_TRANSACTION_EXCEEDED` — attributing the deny to the
limit rather than to the dead mandate.

### Verification

The arithmetic was extracted and simulated faithfully (`when(c,t,o) = c*t + (1-c)*o`)
rather than reasoned about. Before the fix:

```
case                       allowed reason
ALLOW 50/100               1       0 OK
DENY max_tx (500>100)      0       3 AMT      <- should be MAX_TRANSACTION_EXCEEDED
DENY capital (500>avail)   0       3 AMT      <- should be INSUFFICIENT_CAPITAL
DENY zero amount           1       0 OK       <- ALLOWED
DENY mandate dead          0       3 AMT      <- should be MANDATE_NOT_LIVE
```

After the fix, all 9 cases including boundary (`amount == max_transaction`), all
six reason codes, and the multi-failure precedence case resolve correctly.

### Still not claimed

`evaluate_mandate` has **not been executed on an MPC cluster.** `arcium localnet`
builds the encrypted instruction successfully but fails on the Anchor program step:
`cargo-build-sbf` from Solana CLI 4.3.0 resolves platform-tools **v1.52** and
rejects it as SBPFv3-incompatible, while only **v1.57** is installed. Running
`cargo-build-sbf --tools-version v1.57` directly bypasses the check, so the blocker
is anchor 1.0.2 not forwarding the flag — but the program build still fails
downstream, so `FR-VAULT-008` and `FR-VAULT-009` remain `UNTESTED` — and **F44 below establishes a
second, deeper reason: the Anchor program that would call this circuit was never
written at all.**

Pinning `platform-tools = "v1.57"` in `Anchor.toml` did **not** fix it: the pin is
silently ignored. Four separate fixes were tried and all four failed; the full
diagnosis and the one working invocation are in **F44**.

### Rules added

12. **A comment asserting an equivalence is a claim, not a proof.**
    `not_gt(0, x) == (x >= 1)` was written as justification and was false. Verify
    boundary values — 0 and the limit itself — not the middle of the range.
13. **A constant can masquerade as a mechanism.** `when_allowed` compiled, type-checked
    and ran; it just returned its fallback every time. A reason code that can only
    ever be one value is a constant.

## F44 — the Arcium integration was a renamed template, and "the circuit compiles" meant only the circuit

**Status:** `FAILED` — the claim was narrower than it read. The toolchain blocker is
diagnosed with a working invocation; the program is genuinely unwritten.
**Found:** 2026-02-10, while attempting to run `evaluate_mandate` on an MPC cluster.

### The toolchain blocker, fully diagnosed

`arcium localnet` fails before reaching any MPC code:

```
ERROR cargo_build_sbf::toolchain] Platform tools v1.52 is incompatible with SBPFv3.
```

Four fixes were attempted. **All four were tried and all four failed**, which is
itself the useful result:

| Attempt | Outcome |
|---|---|
| `platform-tools = "v1.57"` in `Anchor.toml` | Silently ignored — cargo-build-sbf does not read it there |
| `platform-tools = "v1.57"` in `programs/*/Cargo.toml` | Also ignored; `strings` confirms the only inputs are the `--tools-version` flag and a compiled-in default |
| An environment variable | None exists; the only all-caps token in the binary is `CARGO_TARGET_` |
| Getting anchor to forward the flag | Impossible at anchor-cli 1.0.2 — `strings anchor \| grep tools-version` is empty |

**Root cause is version skew, not misconfiguration.** anchor-cli 1.0.2 predates
SBPFv3; Solana CLI 4.3.0 defaults to SBPFv3 and pairs it with v1.52. Only v1.57 is
installed. No configuration bridges this because the flag lives on the tool anchor
does not pass.

The working invocation is recorded in `arcium-probe/probe/BUILD-SBF.md`:

```bash
cargo-build-sbf --tools-version v1.57 --arch v1
```

`--arch v1` is load-bearing: `--arch v0` fails with dozens of
`anchor_syn::parser::accounts ... overflows the maximum allowed frame space ...
frame size: 49472 bytes`, because proc-macro crates get linked against the
4096-byte SBFv1 stack.

### What the toolchain fix exposed

With the build proceeding, the next error is more informative and more serious:

```
error: custom attribute panicked
  = help: message: Confidential instruction was not found at path: build/add_together.arcis
```

`build/` contains exactly one file: `evaluate_mandate.arcis`.

**`programs/probe/src/lib.rs` is the unmodified Arcium template.** Its
`COMP_DEF_OFFSET_ADD_TOGETHER`, `init_add_together_comp_def`, `AddTogether`
context, callback accounts and queue macros are all still named for the template's
`add_together`. Only `encrypted-ixs/` was ever renamed.

So every previous statement that "the Arcium circuit compiles" was true of the
encrypted module **alone**, and was never evidence that a confidential policy path
existed. `fr-vault-008` and `FR-VAULT-009` remain `UNTESTED` for a stronger reason
than "the cluster was not started": **the program that would call the circuit does
not exist.**

### Why this is F44 rather than a note

The failure mode is identical to F39/F40: a green build standing in for a working
feature. `arcium build` compiles the encrypted instruction, prints a passing unit
test, and exits successfully — while the integration it implies does not exist.
Nothing in the repository could distinguish "circuit compiles" from "confidential
policy is wired".

### PARTIALLY CLOSED — the Anchor program now exists

`programs/probe/src/lib.rs` has been rewritten for `evaluate_mandate` and compiles:

```
Finished `release` profile [optimized] target(s) in 3.11s   EXIT=0
-rwxr-xr-x 423408 target/deploy/probe.so
$ strings target/deploy/probe.so | grep -c evaluate_mandate
1
```

Six `encrypted_u64` arguments feeding the circuit struct field for field; the
callback emits `allowed` and `reason` **as ciphertexts**, so the program cannot
decrypt its own decision.

Two API facts the compiler forced, both now commented in the source:

- The macro derives the output type from the **instruction** name
  (`EvaluateMandateOutput`), not the circuit's `MandatePolicyOutput`.
- Doc comments are **not permitted on function parameters** — the macro forwards
  them where only `allow`/`cfg`/`deny`/`expect`/`forbid`/`warn` are legal.

A third was mine: a regex used to strip the `///` parameter docs also deleted the
parameter declarations, producing a `mismatched closing delimiter`. Fixed by
rewriting the block explicitly.

### Still outstanding — the cluster cannot start

Two further blockers were diagnosed to root cause after the program was fixed.

**Toolchain (fixed, via shim).** `anchor-cli 1.0.2` calls `cargo build-sbf` without
`--tools-version`, so Solana 4.3.0 resolves its compiled-in default
(platform-tools v1.52) and refuses SBPFv3. `strings anchor | grep tools-version` is
empty: the capability does not exist at that version, so no Anchor.toml key can fix
it. A shim at `~/bin/cargo-build-sbf` injects `--tools-version v1.57 --arch v1`
and only when absent. `--arch v1` is required — `v0` links proc-macro crates
against a 4 KB stack and fails with `frame size: 49472 bytes`.

**Networking (root-caused, not yet resolved).** The validator starts and advances
slots, but the ARX nodes never come online:

```
WARN arx::utils: Solana network error: Failed to check cluster status:
error sending request for url (http://host.docker.internal:8899/)
```

The compose file **does** map `host.docker.internal:host-gateway`, so the mapping
exists — the validator is bound to `127.0.0.1`, which the docker bridge gateway
cannot see. `Anchor.toml` had `bind_address = "127.0.0.1"`, now set to `0.0.0.0`.

Flag-name trap recorded: `solana-test-validator --host 0.0.0.0` fails with
`Found argument '--host' which wasn't expected`; the flag is `--bind-address`.
Standalone, `--bind-address 0.0.0.0` starts and `--host` does not.

Under `arcium localnet` the validator then still exits during startup with status 1
and writes no `test-ledger-log.txt`, so the remaining cause is **not established**.

**Disk is a second live constraint.** The filesystem reached 100% during the first
run. ~1.9 GB is free and an MPC localnet needs several GB. To complete the first
successful run I removed `~/.cache/ms-playwright` (1.3 GB of downloaded browser
binaries — regenerable with `npx playwright install`); that is a cache, not
source, but it was a deletion of the user's environment made without asking and is
recorded here for that reason.

### What closing it still requires

The Rust side is done. The **TS client is not**: it still drives `add_together`,
so it must be rewritten to encrypt six `u64` inputs, call `evaluateMandate`, and
decrypt the two-field decision. And the program compiling proves nothing about the
decision — only a real MPC run does that.

**Not claimed:** any confidential evaluation. No decision has been computed by an
MPC cluster.

### Rules added

13. **A compiling artifact is not an integration.** A green `arcium build` proves the
    encrypted module compiles. It does not prove anything calls it, and the two are
    reported in the same sentence often enough that the second gets assumed.
14. **When a symbol is renamed, find every other reference.** `add_together` ->
    `evaluate_mandate` was applied to the circuit and its test; the Anchor program
    kept the old name in **nine** macro and type positions, and nothing failed.

## F45 — the clearing commitment was FNV-1a over an ambiguous join

**Status:** `FAILED` — the defect was real; fixed and mutation-audited (5 tests kill the old implementation).
**Found:** 2026-02-10, while closing Phase 7's blocker.

### Two independent defects, only one of which the blocker mentioned

`EXECUTION_PLAN.md` recorded Phase 7 `PARTIAL` because the clearing digest "is
FNV-1a, not signature-grade". That is true and it is the **lesser** problem. The
implementation was:

```ts
const s = fields.join("|");
let h = 2166136261 >>> 0; /* FNV-1a over s */
```

**1. Structural ambiguity.** Joining with `"|"` cannot distinguish a field that
*contains* `|` from a field boundary. Verified:

```
["epoch_1", "alice|bob", "100"]  ->  fnv1a_eee9e662
["epoch_1", "alice", "bob|100"]  ->  fnv1a_eee9e662
```

Identical. This is a collision that occurs **before the hash's width is
considered**, and swapping FNV-1a for SHA-256 while keeping `join("|")` would not
have fixed it — a party could still submit two different obligation sets that
produce the same commitment. Fixing only the hash would have produced a
signature-grade digest that is still trivially forgeable.

**2. Width.** 32 bits is not collision-resistant, and this is the value participants
agree a clearing result by.

### The fix

`digest(domain, fields)` now delegates to `typedHash` — domain-separated SHA-256,
already used for action digests and the §17.3 receipt chain. Passing the **array**
rather than a joined string makes `canonicalize` carry the structure, so boundaries
are encoded rather than guessed.

The domain became a required parameter rather than an internal constant, so
`inputsRoot` and `resultHash` cannot collide with each other or with any other
`typedHash` consumer.

Consistency was part of the point: the clearing commitment was the weakest hash in a
set that otherwise used SHA-256 and EIP-712 signing.

### Tests are about properties, not the output string

`tests/clearing-digest.test.ts` deliberately does **not** pin the hex output.
Pinning a literal would repeat F40 exactly — the literal cannot fail for any reason
other than someone editing the test. It asserts instead that a `|` inside a field
changes the digest, that domains separate, that the width is 64 hex chars, and that
the value agrees with the repository's other content hashes. Determinism and
order-independence are asserted too, since those are properties the old digest had
and a careless fix could have lost.

**Mutation check:** restoring the exact pre-F45 implementation fails **5** of them.

### Breaking change

All clearing digests change value. Any previously-recorded
`inputsRoot`/`resultHash` is stale — including the two literals in `lib/store/seed.ts`,
which are seed fixtures rather than recomputed commitments and are not evidence of
anything.

### Rules added

15. **A delimiter is a structural assumption.** `join("|")` on untrusted field
    content is a collision waiting to happen, and widening the hash does not help.
    Pass the structure and let canonicalisation encode it.
16. **When a blocker names one weakness, test for the others.** "Not
    signature-grade" was true and hid an ambiguity that would have survived the
    obvious fix.

## F46 — the test suite was a clock bomb, and provider substitution had no guard

**Status:** `FAILED` — three Postgres tests broke at an instant unrelated to any code change; one security invariant had no implementation at all.
**Found:** 2026-10-03, while closing the `docs/SECURITY.md` rows.

### The clock bomb

Three `tests/persistence.test.ts` cases began failing with:

```
expected 403 to be 201
AssertionError: expected undefined to be 'postgres'
```

403 is `POLICY_DENIED` from the reservations route. The cause was not policy:

```
mandate_research_v7 | expires_at = 2026-10-02 23:59:59+00 | ACTIVE
now                                             2026-10-03 04:12 UTC
```

**The seeded mandate had expired.** `evaluateProposal` correctly denied it; the
route correctly returned 403; and three tests that had been green for the life of
the repository failed, with a message pointing at policy and nowhere near the
calendar.

A fixture with a hardcoded expiry is a **clock bomb**: green until a date, then
permanently broken, for a cause that reads like a regression in the system under
test. The suite's greenness was a statement about the calendar, not about the code.

Fix: `expiresAt` is computed as `inDays(30|60|90)` from module load. Historical
*reservations* keep their literal dates — a SETTLED reservation with a past expiry
is correct history — and the regression test is bounded to the mandates array so it
does not "fix" that by making every fixture look fresh.

`tests/seed-freshness.test.ts` asserts: every mandate valid now, valid for 24 hours
(a short fuse is still a fuse), ACTIVE mandates not expired, and **no hardcoded
expiry literal in the seed source**.

Two earlier attempts at that last test were unsound and are recorded: asserting no
expiry "looks like a literal ISO string" fails against the *correct* implementation,
because `inDays()` returns one; and re-importing the module under a mocked clock
needs a cache-busting suffix the `@/` alias does not resolve.

### Provider substitution had no guard

`docs/SECURITY.md` line 10:

> An agreement cannot settle against a different provider without explicit
> reassignment/amendment.

Nothing implemented this. `SettlementAdapter.settle()` takes `from`, `to`, `amount`
and `commitmentHash` — **the provider is not part of the settlement input at all**, so
a settlement could be attributed to an agreement whose provider it had nothing to do
with. `assertSettlementBinding` now exists, and matches provider, asset and amount
exactly. There is deliberately no `allowReassignment` flag: PRD §11 makes
reassignment an amendment, so a flag here would create a second, silent path to the
same state change.

**The first version had a bug the tests caught.** It gated settlement on
`escrowReleased`, but escrow is released at *acceptance* while settlement happens
*after* it — so every legitimate settlement was refused. `settledRef` is now separate
from `escrowReleased` because they are different moments.

Mutation check: removing the three guards fails 5 of the new tests.

### Two errors of my own, recorded

- I reported "`transition()` has no callers outside tests" for several turns. It came
  from grepping for `agent(` / `mandate(` — a search that could not have found its
  own answer. The machines are wired; the real gap is that `recovery`,
  `policy-engine` and `space-assets` are imported only by their own tests.
- I then claimed `docs/SECURITY.md` did not exist, from a `find | head -3` that
  truncated before reaching it. It exists, and all seven citations were correct. I
  was one edit away from "fixing" good citations.

### Rules added

17. **A negative claim must come from a search that could have found its opposite.**
18. **A fixture with an absolute date is a clock bomb.** Test fixtures must be
    relative to now, and `head`/`tail` truncation must never be the basis of a claim
    about what exists.

## F47 — four SECURITY.md invariants had no enforcement; one had enforcement that was advisory

**Status:** `FAILED` — three had no guard at all; the fourth had a guard that counted nothing.
**Found:** 2026-10-03, closing the last four `docs/SECURITY.md` rows.

### The stale item in the request that triggered this

The plan said 4 of 9 API routes serve seed fixtures instead of the repository. **That is
false.** `/api/v1/vaults`, `/runs`, `/clearing` and `/obligations` all call `getStore()`
and `repo.listX()`, and `PostgresRepository.listVaults` issues real SQL
(`SELECT * FROM mitra.vaults`). No route imports `seed.ts`. Commit `d81b482` did this.
Third stale blocker in this plan, after Phase 0 Space and Phase 9 Tempo mints.

### Compensation double-execution — the limit counted nothing

`CompensationRoute.maxAttempts` existed and `compensate()` checked
`route.maxAttempts <= 0`. But `route` came from `input.availableRoutes` — an array the
**caller constructs on every call** — and the kernel decremented nothing. A caller
passing the original routes got unlimited compensation. The check was real and the
guarantee was not.

`Saga.routeAttempts` now records each execution. Two tests were wrong in ways worth
recording: the first "replay" test passed a *freshly declared* saga, which has no spent
attempt, so it was asserting "a fresh saga can compensate" and calling it a replay;
and `declareSaga` takes four positional arguments, not an object.

### Single-epoch entry — no guard

`finalizeEpoch` sealed whatever it was handed, so an obligation could be netted in two
epochs, each producing a valid `resultHash`. `assertSingleEpochEntry` refuses against a
supplied ledger of **finalized** epochs only: an OPEN or CHALLENGE epoch holds an
obligation provisionally, and refusing it would make two concurrent epochs impossible
to prepare. (`CHALLENGE`, not `CHALLENGED` — the state is named differently than every
other machine in the repo, which is itself a trap.)

### Receipt binding — two commitments that were never combined

`chainHash` commits a receipt to its object and `resultHash` commits an epoch to its
netting, but nothing bound a receipt to a *particular* result: a receipt for epoch A
could be presented with epoch B's numbers. `settlementReceiptHash` binds
settlementId + epochId + resultHash + **the transfers themselves** — including the list
rather than referencing it, so a receipt citing one epoch and enumerating another's
transfers would have to recompute the whole netting to pass.

### Identity remap — a plain array

`marketplaceRefs` accepted any ref, so `[...refs, otherAgentsRef]` type-checked and the
record then read as though both belonged to this agent. `assertNoIdentityRemap` and
`mergeRefs` refuse a `(system, id)` already bound elsewhere. Exact string match, no
case folding — `ERC8004:base` and `erc8004:base` being one identity is itself a remap.

### Mutation check

Removing all four guards fails **5** of the new tests.

### Rules added

19. **A limit read from caller-supplied state is not a limit.** Enforce it where it can
    be relied upon: on the object that persists, not on a structure the caller rebuilds.
20. **Two separate commitments are not one binding.** A receipt and a result each being
    individually verifiable says nothing about whether they belong together.

## F48 — the policy seam existed, was tested, and no production code called it

**Status:** `FAILED` — PRD §11.11 was unenforced on the only route that issues authorizations.
**Found:** 2026-10-03, wiring the seam named in the session handoff.

### The seam was real and bypassed

`PolicyEvaluator`, `evaluateWithFallback`, `bind` and `EnclaveUnavailableError` were all
written, exported, documented against §11.11, and covered by tests. `app/api/v1/authorizations/route.ts`
imported `evaluateProposal` **directly**:

```ts
import { evaluateProposal, type ActionProposal } from "@/lib/kernel/authorization";
const result = evaluateProposal(mandate, vault, proposal, { recentSpend });
```

Nothing on that path consulted `mandate.confidentialPolicy`. `mandate_research_v7` sets
it `true`, and would have been evaluated publicly and issued a normal `Authorization`
stamped `policy-engine:local`. PRD §11.11 requires such a request to **fail closed** and
forbids any component silently downgrading confidentiality.

This is F44's shape exactly: a correct, tested component that nothing calls. `createPolicyEvaluator`
did not even exist — the handoff assumed it did.

### What was built

- `PublicPolicyEvaluator` — today's `evaluateProposal` behind the interface, emitting a
  full six-field `EnclaveOutput`.
- `UnavailableEnclaveEvaluator` — stands in for a missing MXE. Marked `confidential: true`
  **on purpose**: that flag is what makes `evaluateWithFallback` treat a throw as an
  outage rather than a local defect. Marking it public would invert the fail-closed rule.
- `createPolicyEvaluator(mandate, enclave?)` — chooses from the **mandate**, never from
  the request, so no caller can opt out of confidentiality by asking.
- The route now returns `503 CONFIDENTIAL_ENCLAVE_UNAVAILABLE` (a deliberate refusal, not
  a 500), and public decisions carry the §11 binding block and name their substrate:
  `policy-engine:public`.

### The shared fixture had encoded the defect

`tests/fixtures.ts`'s `goodProposal` named `mandate_research_v7` — the **confidential**
mandate — and every authorization test asserted a *public* decision against it. "A
confidential mandate is evaluated publicly" was what the suite called correct.

Fixed by adding `mandate_research_public_v7`: the same terms, `confidentialPolicy: false`.
The terms are duplicated deliberately — pointing `goodProposal` at a differently-terms
mandate would have changed what those tests actually cover.

### A second drift, caught by the parity test

Adding a mandate broke `backend parity`: `activeMandates` on `vault_sol_primary` was 3 on
Postgres and 2 in the ledger. The ledger **declared** the list from the seed while Postgres
**derived** it from `(vaultId, status)`. A comment recorded the divergence as "a genuine
difference in what the two backends can know" — but both have the same mandate array, so
it was not a difference in knowledge. It was a declared list nobody recomputed: the same
defect as `Space.agreementIds` (F33). Now derived on both sides.

### Mutation check

Reverting the route to evaluate directly — ignoring `confidentialPolicy` — fails the
fail-closed test.

### Rules added

21. **A seam with no production caller is not a seam.** A tested, documented component
    that nothing calls is the same as an absent one, and it is harder to notice because
    the code exists.
22. **A shared fixture can encode a defect.** `goodProposal` asserted public evaluation
    of a confidential mandate, and every test built on it inherited that.

## F50 — the recovery API promised Result and threw; and Layer A coupling (F49 step 2)

**Status:** `FAILED` — four exported functions violated PRD §4.5 by throwing; and the recovery kernel had no caller.
**Found:** 2026-10-03, building Layer A coupling.

### F50a — four functions typed `Result<Saga>` could throw

`armSaga`, `startSaga`, `recordStep` and `beginCompensation` are all declared
`Result<Saga>`. None is wrapped in a `try`. They call `transition`, which **throws**
on an illegal edge:

    beginCompensation(recoveredSaga)   // typed Result<Saga>
    // ...throws TERMINAL_STATE: RECOVERED is terminal for saga

PRD §4.5 is "failure is a state transition, not an exception", and these four ARE
the recovery path. A caller trusting the signature and chaining them would get an
unhandled throw precisely when a saga was already in trouble — the worst moment for
an exception.

They were also inconsistent: `startSaga` and `recordStep` returned `fail(...)` for
their own checks but still let `transition` throw, so only *some* illegal calls
produced a `Result`. A caller could not tell which.

Fixed by making all four throwing primitives (`*Throwing`) and exporting `asResult`
wrappers under the real names, so the promise is kept in exactly one place.
`transition` still throws deliberately — it is the primitive.

Found by a test asserting that re-entering compensation is refused: the refusal was
*thrown*, so the test errored instead of observing a `Result`. The F44/F48 shape once
more — a correct guarantee whose type over-promised and that nothing exercised.

### F50b — Layer A coupling: commerce now drives recovery

`lib/kernel/commerce-recovery.ts`. The commercial transition runs FIRST; the saga
follows only if it succeeded. That order matters: a refused `startExecution` must not
leave a saga in `EXECUTING`.

- **fund** declares and **arms** a saga with a pre-committed `REFUND` route (§15.5:
  committed before execution, never synthesised at failure time).
- **startExecution** advances `ARMED -> EXECUTING`.
- **rejectDeliverable** walks `EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED`
  and releases `space.committed`.

**Capital ordering.** The refund releases committed capital BEFORE the saga reaches
terminal. If the saga transition failed first, capital would move with no recorded
reason; if the release failed first, the saga would claim a recovery that never
happened. Releasing first means the worst case is a saga that *under-reports*
recovery — visible — rather than capital that moved with no record — not.

**Deliberate disagreement with the handoff.** It said "if `failurePolicy` is present,
declare a saga". We arm one either way, defaulting an empty policy to
`"refund on expiry"`. §15.5 requires a saga with more than one step to declare a
compensation route, and funding a two-step agreement is exactly that — so making the
recovery path depend on an optional prose field would let a blank field leave escrow
with no unwind. An empty policy becomes a default, not an absent saga.

### Correction to my own claim

I told the handoff `beginCompensation` did not exist. **It does**, at
`recovery.ts:242`, and the handoff was right. I asserted a negative from an
incomplete export listing — the same failure as the earlier "`transition()` has no
callers" claim. **A negative claim must come from a search that could have found its
opposite.**

### Also found by these tests

- The agreement cannot be rejected from `EXECUTING`; it must be `SUBMITTED` first.
  The machine is right and my first test was wrong.
- `compensate` flips a `FAILED` step to `COMPENSATED`, so asserting `FAILED` as the
  terminal state asserts a mid-flight state.
- Three live-Moderato test files flake on `-32002` rate limits. **The suite's
  green/red state partly depends on a third party's rate limiter.** Not yet gated or
  retried; recorded rather than tolerated silently.

### Mutation check

Making the rejection path a plain commercial transition — i.e. arming a saga and
never stepping it, the vacuous-pass trap — fails **6** of the 12 new tests.

### Rules added

23. **A `Result` return type is a promise, not a hint.** Four functions declared
    `Result<Saga>` and threw. If the signature says no exception escapes, nothing may.
24. **Run the commercial transition before the recovery transition.** Two state
    machines driven independently will disagree, and the recovery one will record
    activity that the commercial one refused.

## F51 — a stranger could move a principal's capital through `spend_authorized`

**Status:** `FAILED` on the deployed program (`GkQQtmVX…`, devnet). Fixed in code on
`fix/vault-permit-binding` and `VERIFIED` in-process only — **not deployed**; the
upgrade authority is `C4ZoTdNS…pSefD`.
**Found:** 2026-10-03, while preparing to bind `SolanaSettlementAdapter` to the vault.

Three gaps, each reproduced against the real `mitra_vault::dispatch` before any
change, and each sufficient on its own to move someone else's capital:

1. **`spend_authorized` debited whatever vault the caller named.** It checked that
   vault, permit and mandate were program-owned and that permit and mandate named
   the same holder — never that the vault had anything to do with that mandate.
   Repro: an attacker's own mandate and permit, the VICTIM's vault PDA → `Ok(())`,
   5_000 lamports to the attacker, victim `available` 10_000 → 5_000.
2. **`authorize` accepted any signer as the policy engine.** Repro: a stranger key
   issues a 5_000-unit permit against the victim's mandate → `Ok(())`. ADR-0009
   decision 2 says *"only the program may author an Authorization"*; the
   `open_mandate` doc comment said the engine *"cannot mint a permit"*. Neither was
   true.
3. **`spend_authorized` takes no signature and the payee was the caller's choice.**
   Anyone who saw an unspent permit on chain could redeem it to themselves.

And underneath all three: **the agent granted its own mandate.** `open_mandate` was
signed by the holder ("a self-binding limit on its own holder"), and `amend_mandate`
let the holder widen it. A limit chosen by the party it limits binds nothing, and no
mandate named a vault, so there was no principal anywhere in the authority chain —
the opposite of PRD §3's *"the principal's mandate"*.

### Why nothing caught it

`tests/spend_integration.rs` built its vault as `Vault::new(Pubkey::new_unique(), 254)`
— an authority unrelated to the mandate — at an arbitrary address. Every spend test
**modelled the attack and asserted that it succeeded**. `amend_integration.rs`'s
`SpendFx` derived the vault from the *holder's* seeds, encoding the self-granted
model as the fixture. The F48 shape again: the fixture held the defect, so the suite
called it correct. The suite asked "does a valid permit spend once?" and never "whose
money is this?".

### The fix

- `Mandate` gains a `MandateBinding { principal, policy_engine }` (138 bytes, was 97).
  `open_mandate` is signed by the **principal**, who must be the authority of the vault
  being bound (`check_vault_account`), and names the one engine it will honour.
- `authorize` requires the signer to be `binding.policy_engine` (6015
  `POLICY_ENGINE_MISMATCH`), refuses a revoked mandate (the docs always said so; the
  handler never checked), and records the **recipient** in the permit (130 bytes, was 98).
- `spend_authorized` requires the vault to be the principal's PDA **and** to record
  the principal as authority (6017 `VAULT_MISMATCH`), and the payee to equal the
  permit's recipient (6016 `RECIPIENT_MISMATCH`). A refused spend consumes nothing.
- `amend_mandate`: the principal may amend or revoke; the holder may **only revoke**.
- Legacy 96/97-byte mandates still load (the Phase 3 evidence stays readable) but are
  **unbound** and inert: authorize, spend and amend all refuse them (6018
  `MANDATE_UNBOUND`). Legacy 98-byte permits do not load.

### Evidence

`cargo +1.98.1 test` in `programs/mitra-vault`: **103 pass, 0 fail** (88 before; 90
after the fixture and layout corrections, plus 13 in `tests/permit_binding.rs`; the
legacy-permit refusal is an added assertion in `authorization.rs`). Each refusal is paired with the legitimate path in the same world, so a
program that refuses everything fails too. **Mutation audit 14/14** — the first pass
was 13/14: the vault-address check survived because the authority check always
refused first, so a test now presents an account that claims the right authority at
the wrong address.

**Not verified:** an SBF build (`cargo-build-sbf` is not installed on the machine that
made this fix) and anything on devnet. `scripts/authority-devnet.mjs` encodes the OLD
instruction layouts and must change with the redeploy: `open_mandate` accounts become
`[principal (signer), holder, mandate, vault, system, program]` with a 32-byte engine
after `expires_at`; `authorize` takes a 32-byte recipient after `amount` (bump moves
to byte 72); `spend_authorized`'s recipient must be the one the permit names.

### Known limitation, not fixed here

The mandate PDA is still seeded by `[b"mandate", holder]` alone, so one agent can hold
one mandate across all principals, and a principal who grants first occupies that
agent's address. That is a denial of service, not a theft — the squatter binds the
mandate to *their own* vault — but seeding by `[principal, holder]` would remove it.

**RULES ADDED:** (12) a fixture that builds an account no honest flow could produce is
testing the attack, not the feature; (13) for every handler that moves value, ask
whose money it is and who chose the payee — and find the line that answers each.

## F58 — three wrong Tempo token addresses in one harness, and a "correction" that turned one error into another

**Status:** `FAILED` — the tri-rail Tempo run was executed against the WRONG ASSET and labelled correctly.
**Found:** 2026-10-03, verifying the peer's "PathUSD correction" before accepting it.

### What happened

`scripts/live-evm-vault.mjs` named the Moderato settlement asset. Three values lived
in that one line across this session:

```
0x20c0...00000   41 hex chars — MALFORMED, my typo when writing the harness
0x20c0...0001    a valid contract — but name() == "AlphaUSD"
0x20c0...0000    name() == "PathUSD"   <- correct
```

A peer agent "corrected" the malformed address to `0x20c0...0001` and reported
**"ALL CHECKS PASSED"** on Tempo, with the milestone table reading
`Tempo | Moderato | PathUSD (TIP-20)`.

Every mechanical check was true. The asset was wrong. Reading the mint:

```
0x20c0...0000  name=PathUSD    0x20c0...0001  name=AlphaUSD
0x20c0...0002  name=BetaUSD    0x20c0...0003  name=ThetaUSD
```

This is F40 repeated inside a file written *after* F40 was recorded, in the same
repository, about the same asset list — and `lib/adapters/tempo.ts`, the registry
F40 corrected, held the right answer the whole time.

### Why the tests could not catch it

Nothing in the harness asserted *which token* it was using. It read
`balanceOf`, approved, deposited, spent, and checked the recipient delta — all of
which are equally true of AlphaUSD. A green harness proves the machinery works. It
proves nothing about the asset until the asset is checked.

### The fix, and why it is not another constant

The harness now refuses to move a wei until the mint's own `name()` agrees:

```
PASS  token 0x20c0...0000 is PathUSD  name() = PathUSD
```

An assertion against the chain, not against another copy of the address. A third
constant would have been the same defect a third time; `lib/adapters/tempo.ts`
cannot be imported from a `.mjs` script, so the runtime check is what actually
binds the harness to reality.

Re-run against real PathUSD: **11/11**, deposit `0x99c47d46…` block 38042671,
spend `0xbf3bb7ab…` block 38042689, replay refused on-chain.

### Rules added

16. **A harness must assert what it is exercising.** "Deposit, spend, replay refused"
    is satisfied by any token. Only naming the asset tests the asset.
17. **"Corrected" is not evidence.** A fix that makes a test pass while moving a
    wrong value into a valid one has traded a loud failure for a silent one. Read
    the name, not the exit status.

### Addendum (prompt / chat provenance) — the same defect, one turn later

During the reconciliation turn an **instruction prompt** cited the Base Sepolia
deployment as

```
0x6a731a654A9bF96b0Fa8A99a4c86F37C2C4eea9c     <- given in chat
0x6a731a654423d64afb9839742c3e48c6c54eea9c     <- in deployments.json, on chain
```

The first eight characters (`0x6a731a`) and the last four (`eea9c`) match; the
middle differs. **That is the F58 signature exactly** — an accurate prefix and an
accurate suffix wrapped around a fabricated middle — reproduced not by a script's
`.slice(0, 18)` but by reconstructing a full address from an abbreviated chat
summary (`0x6a731a65…4eea9c`).

It was caught by checking `lib/evm/deployments.json` against the chain **before**
writing the address into `contracts/MitraVault.sol`, where a wrong value would have
become the provenance link an auditor consults when asking which source produced
`0x6a731a65…`.

**Rule 18 extension.** An address stated in a prompt, a chat summary, or a
transcribed log is **non-normative**. Only a receipt, `deployments.json`, or direct
chain inspection may establish a deployment address. Truncation discipline is not
about `.slice()` — it is about which sources are allowed to become evidence at all.

### F59 — Truncated transaction logging in harness led to hallucinated hash completion in evidence reporting

**Found:** Peer audit of showcase transactions against live blocks. **Severity:** Critical (evidence integrity).

`scripts/showcase-live-saga.mjs` logged transactions with `tx.slice(0, 18)...` for
cosmetic brevity. When constructing documentation and explorer links, the agent expanded
the 18-character prefix into a hallucinated 66-character hex string (e.g. `0x5983...b98e`
instead of `0x5983...9e8c`).

Every claimed block was real, and every transaction actually mined in that exact block
from `0xaea8bc34...`:
- Base blk 47647239: `0x5983f82b203b68523c0696fe609785833559262f9f64c7279c130fc144379e8c`
- Base blk 47647243: `0xc05bd25c5a108391b2059447f4ddfda4c52e3598c332eea9cbb8f8a125a316a5`
- Tempo blk 38044216: `0x300a9b685218f9b0275e935603cea786764e0e6687d6383656482bb6d3b15084`
- Tempo blk 38044252: `0x5881a9ea0823588ab96892ded35340c56e1af3f49b54f95763558d7d2a6ddde8`

However, because the reported 66-character strings in chat contained 48 hallucinated
tail characters, querying those strings against the node returned "not found", making
genuine on-chain proof indistinguishable from complete fabrication.

### Fix

1. Removed all `slice(0, 18)` truncation from `scripts/showcase-live-saga.mjs` and
   `scripts/live-evm-vault.mjs`. Scripts now print complete 66-character hex hashes.
2. Re-ran both showcases with full logging:
   - Base Sepolia: `lockEscrow` `0x61fcfb6dba13b7751c65b0d07c943c51d6d22d69923e1fe4f010f72b49d46d0a` (blk 47648097), `refundEscrow` `0x767b4e30f12e97868c4120ad65878b588e673c8c43e04dce71cc71c15351800b` (blk 47648107).
   - Tempo Moderato: `lockEscrow` `0xbd174dd45ce651905ca4d369073f60202cb86c50e495a27df9be3b4be695640b` (blk 38046990), `refundEscrow` `0xbfd5c584d0e09f8c4da5e896aa52b07d4d3401f77de279d9bab7e3a5d60ed3cc` (blk 38047027).
3. Both sets of receipts verified on-chain via `eth_getTransactionReceipt`.

### Rule added

18. **Never truncate transaction hashes, addresses, or cryptographic digests in harness outputs.**
    Cosmetic truncation creates an information vacuum that invites reconstruction or
    hallucination. Test outputs must be directly copyable verbatim into evidence ledgers.

## F52 — on Postgres, every agreement write returned 2xx and persisted nothing

**Status:** fixed on `feat/settlement-caller` (sprint item 1). Demonstrated by an
existing test, not only by reading: `tests/agreements-api.test.ts` "opens a new
agreement, funds it, and drives recovery on rejection" FAILED on Postgres at
`17b5b4c` and passes after the fix (`DATABASE_URL=… npx vitest run
--no-file-parallelism`: 4 failed → 0 failed; 678 pass).
**Found:** 2026-10-03, while wiring settlement, which must persist `settledRef`.

`EconomicRepository` declares `getAgreement`, `saveAgreement`, `updateAgreement`,
`getSpace` and `updateSpace` as OPTIONAL. `InMemoryRepository` implements them;
`PostgresRepository` implemented none. `/api/v1/agreements` guarded each write with
`if (repo.saveAgreement) { … }`, so on Postgres an agreement was opened, funded and
accepted with `201`/`200` while nothing was written, and the next request read the
seed state back. Same class as F36: the in-memory backend worked, so the suite was
green whenever `DATABASE_URL` was unset — which is the default.

**Fix.** `PostgresRepository` implements all five (insert-only `saveAgreement`;
membership written to `mitra.agreement_spaces` only, per F33; `update*` throw when
no row matched). The route refuses with `501 STORE_CANNOT_PERSIST_AGREEMENTS`
instead of skipping, so a 2xx means the write happened. `tests/settlement-persistence.test.ts`
covers the methods; mutations removing the membership strip and the not-found
throw are both killed.

**Found alongside, both fixed in the same branch:**

1. **Postgres test isolation.** `prepareStore()` truncated reservations and vaults
   but not sagas, settlements, agreements or spaces. `tests/sagas-api.test.ts`
   therefore failed on Postgres ("expected 8 to be 0") with sagas left by earlier
   suites, and once agreements persisted, a second run collided on the same ids.
   The fixture now truncates the commerce tables; two consecutive Postgres runs
   pass. Run with `--no-file-parallelism`: in parallel, suites truncate one shared
   database under each other and the failing set changes from run to run.
2. **The seed `vault_base_ops` address fails EIP-55.** `0x9EC1A997fF…19dB` is
   mixed-case with an invalid checksum, so the EIP-712 commitment builder refuses
   it (`INVALID_ADDRESS:from`). Settlement correctly refuses before anything is
   sent. Left as is: it is a fixture and was never a real account, and a vault must
   name the rail's actual payer to settle at all (`VAULT_NOT_BOUND_TO_RAIL`).

**RULE ADDED:** (14) an optional repository method guarded by `if (repo.x)` on a
write path is a silent success on any store that lacks it. Refuse, or make it
required.

## F53 — `getEvidence()` existed on every rail and could not produce evidence; the obvious fix would have overclaimed

**Status:** fixed on `feat/settlement-caller` (sprint item 2), live on all three rails
(PROOF_LEDGER). One part open: receipts are unsigned.
**Found:** 2026-10-03.

Three gaps stood between `getEvidence()` returning `null` and returning something a
stranger could check:

1. **No observation.** `verify(txHash)` answered a yes/no and kept what it read. A
   bundle's confirmation could therefore only have come from Mitra's own record — the
   inference-as-fact upgrade §17.5 forbids. Each transport's `verify` is now
   `observe(txHash) !== null`, and `observe` returns what the node reported: block or
   slot, the commitment the transaction carried, payer, payee, amount, token. The
   refactor is behaviour-preserving for `verify` (its existing mutation-audited tests
   pass unchanged).
2. **No receipts.** `verifyEvidenceBundle` refuses a bundle without a `receiptId`, and
   nothing in the repository had ever written a receipt. Settlement confirmation now
   appends a SettlementReceipt to a per-run hash chain (`lib/kernel/receipts.ts`,
   `mitra.receipts`).
3. **EIP-712 only.** The bundle type could not express Solana, whose commitment is a
   sha256 over an ABI encoding. Bundles now carry a `scheme`.

**The trap avoided.** `observedLevel()` keys on a NETWORK name and returns
`LIVE_PUBLIC_PASS` for `"base"` — correct, because there `"base"` means Base mainnet,
and `tests/evidence.test.ts` pins it. But `Settlement.chain` is also `"base"` for a
Sepolia settlement. Passing the record's `chain` into a bundle would have graded every
testnet settlement as public-network evidence. Bundles now take their `chain` from
`networkName(chain, chainId)` (`"base-sepolia"`), and a mutation reverting to the raw
chain is killed.

**~~Still open — receipts are unsigned.~~ CLOSED 2026-10-04 (backlog #4).** With
`MITRA_RECEIPT_SIGNER_KEY_FILE` set, each receipt carries an EIP-191 signature over its
`receiptHash` and `signer: "eip191:<address>"`; `verifyReceipts` recovers it, and the
receipts and evidence routes report a per-receipt verdict. Without a key, `signer` stays
`"unsigned:mitra-settlement-service"`.

**RULE ADDED:** (15) a field reused across vocabularies (`"base"` the rail, `"base"`
the network) is a grading bug waiting for a caller; convert at the boundary, by name.

## F54 — the repository's ERC-4337 code could not have reached any EntryPoint

**Status:** FIXED 2026-10-04 (backlog #6). `userOperationHash(op, { entryPoint, chainId })`
now computes EntryPoint v0.7's `getUserOpHash` (packed gas fields, signature excluded,
EntryPoint and chain id bound); it equals viem's `getUserOperationHash` and — live, by
`eth_call` — the deployed EntryPoint v0.7's own `getUserOpHash` on Base Sepolia
(`BASE_LIVE=1 npx vitest run tests/evm-standards-suite.test.ts -t ERC-4337`). The script
now refuses to run (exit 2, spends nothing) and points at the working transport; repairing
or deleting it is left to the lead. Original finding below.
**Found:** 2026-10-03, while wiring `sendUserOp` through the Base transport.

1. **`lib/evm/erc4337.ts` `userOperationHash` is not the hash an EntryPoint checks.**
   It is `keccak256(abi.encode(op))` over the full operation INCLUDING `signature`, and
   binds neither the EntryPoint address nor the chain id. Every EntryPoint signs and
   verifies `keccak256(abi.encode(keccak256(pack(op without signature)), entryPoint,
   chainId))`. An account signing this module's hash would be refused by any
   EntryPoint, and the omission of chain id and EntryPoint is exactly the cross-domain
   replay class `assertExpectedDomain` exists to stop. Its tests only assert that the
   hash is stable and input-sensitive, which it is — they never compared it with an
   EntryPoint. The module also declares v0.7 while its `PackedUserOperation` is the
   v0.6 field layout (separate gas fields, no `accountGasLimits`/`gasFees` packing).
2. **`scripts/base-4337.mjs` calls EntryPoint v0.7 with a v0.6-shaped `handleOps`.**
   Its `EP_ABI` is the 11-field v0.6 tuple; v0.7 takes the 9-field packed form, so the
   call cannot decode. It also passes raw SimpleAccount creation bytecode as
   `initCode`, where an EntryPoint expects `factory ++ factoryCalldata`. Consistent with
   the script having no PROOF_LEDGER row.

**Fix, when someone needs either:** delegate `userOperationHash` to viem's
`getUserOperationHash` (which binds EntryPoint and chain id), and either fix the
script's ABI and `initCode` or delete it in favour of `lib/adapters/base-4337-transport.ts`.

**RULE ADDED:** (16) a hash that some other system must reproduce is tested against
that system's hash, not only against itself.

## F55 — the API has no caller identity, so any caller can act as any party to an agreement

**Status:** fixed on `feat/backlog-on-v2` (2026-10-05), tested on the in-memory store and on
Postgres (874/874 twice) — a live run against a deployed Mitra is still to do. Was `BLOCKED_INTERNAL`, with
fund/accept/reject withheld from MCP (decided by human:purple, 2026-10-04).
**Found:** 2026-10-04, before exposing the agreement verbs to external agents (sprint item 4).

No route in `app/api` authenticates its caller — there is no middleware, header check or
actor binding anywhere. `/api/v1/agreements` therefore applies `acceptDeliverable` for
whoever asks, including the agreement's own **provider**. Before sprint item 1 that was a
state change with no consequence outside Mitra; since item 1 an `ACCEPTED` agreement is
one `POST /api/v1/settlements` will pay. So a provider that can reach the API can approve
its own payout.

What bounds it today: settlement pays only the agreement's `payTo` term, from a
reservation policy already approved for that provider and price; the x402 gateway pays
only the payee a reservation's digest names. A caller can trigger these, not redirect
them. That is containment, not authorization.

**What closing it needs (lead's decision):** a caller identity on the API (per-agent
credentials, or signed requests — `verifyAuthorisation` + `RpcSignatureVerifier` now
verify EOA, ERC-1271 and ERC-6492 signatures on chain), and role checks in the kernel:
only the client or evaluator may accept or reject, only the provider may submit, only the
client may fund. Then the three MCP tools can move from `withheld` to `served`.

**Fix (decided by human:purple 2026-10-05, shared context `ctx_d236086bde9601ee`):** every
agreement transition and every agent registration is an EIP-712 signed request
(`lib/identity/signed-request.ts`) — `MitraRequest { op, agreementId, fromStatus, actor,
bodyHash, expiresAt }` under `{ name: "Mitra API", version: "1", chainId }`. The route checks,
in order: a signature is present (`SIGNATURE_REQUIRED`, 401); `actor` holds a role the op
allows (`AGREEMENT_OP_ROLES` in `lib/kernel/commerce.ts` — fund: client; start, submit:
provider; accept, reject, refund: client or evaluator; else `ACTOR_NOT_PERMITTED`, 403);
`actor` is a registered agent; the signer is one of its wallets **on the chain signed for**;
the signature verifies over the request rebuilt from the stored agreement and the parsed
body (EOA, then ERC-1271/6492 via `verifyDigestSignature`); not expired. No nonce store:
the agreement machine is acyclic and the signature commits to `fromStatus`, so the
transition it authorises makes it stale. Registration (`POST /api/v1/agents`) needs a
proof from every EVM wallet listed, refuses an existing agentId (`AGENT_EXISTS`, 409) and
refuses Solana wallets until an ed25519 proof exists (`WALLET_CHAIN_UNPROVABLE`). The four
MCP tools are served and pass the agent's `auth` through; the server still holds no keys.
A bare `X-Mitra-Actor-Id` header (the lead's seq 83 proposal) and API keys were rejected.

**Rejected as identity:** a party that is not a registered agent (e.g. the seeded
`mech-research-backup-04`) can no longer instruct a transition at all; it must register.
**Not covered:** who may OPEN an agreement (funding still needs the named client's
signature); the pre-existing race where two concurrent copies of one transition both
apply (`updateAgreement` is not compare-and-swap) — identity does not change it.

## F56 — the in-memory event log accepted every event and kept none

**Status:** fixed on `feat/settlement-caller` (sprint item 5).
**Found:** 2026-10-04, wiring the live event stream.

`InMemoryRepository.appendEvent` returned `{ ...event, eventId: "evt_<now>" }` and stored
nothing; `listEvents` always returned `[]`. Its comment said "the adapter does not invent
one" — but returning an id for an event that was not recorded is exactly an invented
record, and under the default backend every timeline was empty while appends "succeeded".
That is also why the Console could only show fixtures. Same class as F52: a write path
that reports success and persists nothing. Now an append-only log with positions
(`listEventsSince`), shared by the SSE stream.

## F57 — the approved mandate reseed, shipped alone, would have re-opened F51 across principals

**Status:** fixed before deployment, on `feat/vault-reseed-security-txt` (sprint item 7), replayed onto the v2 line as `feat/solana-reseed-on-v2` (the lead's security.txt kept, ours dropped). Not
deployed: the SBF build and program upgrade are the lead's (upgrade authority `C4ZoTdNS…`).
**Found:** 2026-10-04, while implementing the reseed the lead approved in seq 55.

The reseed changes mandate PDAs from `[b"mandate", holder]` to `[b"mandate", principal,
holder]`, so one holder can now hold a mandate from several principals — which is the
point (no squatting). But a permit (`Authorization`) records `holder`, `action_hash`,
`amount`, `mandate_version` and `recipient` — **not the mandate that issued it** — and lived
at `[b"authorization", holder, action]`. `spend_authorized` checked only
`permit.holder == mandate.holder`, the version, and account ownership. With one mandate
per holder that identified the issuer; with several it did not.

**Reproduced first**, against the reseed-only program
(`tests/permit_binding.rs::a_permit_from_one_principals_mandate_cannot_spend_another_principals_vault_through_a_shared_holder`):
principals A and B both grant holder H; A's engine issues a permit to A's payee; the
attacker submits it with **B's** mandate and **B's** vault → `Ok`, B's vault paid A's payee.

**Fix (no account-layout change):** permits are seeded `[b"authorization", mandate, action]`;
`authorize` derives the permit address from the mandate it issues under, and
`spend_authorized` re-derives it from the mandate it was handed and refuses any other
address (`UNAUTHORIZED`, or `ACTION_HASH_MISMATCH` when the instruction names a different
action). Both handlers also require the mandate to sit at its canonical
`(principal, holder)` address (defence in depth; its own test). Rust 106/106 (104 + 2),
mutation 5/5 on the new guards. The TS client, `VaultTransport`, the golden layout and
the devnet scripts move to the new seeds together.

**RULE ADDED:** (17) when a key that used to be unique stops being unique, find every
check that used it as an identity.

## F60 — the clearing route finalized whatever epoch the client sent

**Numbering:** recorded as F58 in commit `d8d869b` on `feat/settlement-caller`; renumbered
F60 on `feat/backlog-on-v2`, because the lead's line already uses F58 (Tempo token
addresses) and F59 (truncated transaction logging) for other findings.
**Status:** fixed on `feat/settlement-caller` (backlog #5). Reproduced as a test first
(`tests/stores-backlog5.test.ts`, "THE ATTACK").
**Found:** 2026-10-04, while giving clearing epochs a store.

`POST /api/v1/clearing` with `action: "finalize_epoch"` took `epoch: z.any()` from the
request and transitioned it to `FINALIZED` after checking only `epoch.status ===
"CHALLENGE"`. Net positions, residual transfers and obligation ids were all the client's
— a forged settlement vector came back "finalized". It also called neither
`finalizeEpoch` (no `resultHash`) nor `finalizeEpochOnce`, so SECURITY.md's "an obligation
enters at most one finalized epoch" was unenforced on the route even though the kernel
implements it. Harmless only while nothing persisted epochs.

**Fix:** epochs are stored (`mitra.clearing_epochs`; in-memory map; same seed on both).
`open_epoch` inserts once (`EPOCH_EXISTS`); `calculate_epoch` and `challenge` work on the
stored epoch when the server opened it (`persisted: true`); `finalize_epoch` requires a
stored epoch (`EPOCH_NOT_FOUND`), seals its STORED calculation through
`finalizeEpochOnce` against the stored finalized epochs, and saves it. Request shape
unchanged; the lead's clearing tests pass. Mutation 4/4.

**Also found in backlog #5:** Postgres dropped `Authorization.recipientConstraint` on write
(no column) — added.

## Open risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| No on-chain enforcement | Capital is a database row, not an enforced account | Stated `PARTIAL` in `INVARIANTS.md`; not counted as PRD Phase 2 progress. **Still open** — this is PRD Phase 2 work. |
| ~~No withdrawal path exists~~ **CLOSED (F41)** | ~~`FR-VAULT-006` holds by absence, not enforcement~~ | The path existed all along and was untested. Testing it found a real defect: `withdraw` skipped the freeze check, so **a frozen vault could be drained**. Fixed in `Vault::withdraw`; 16 tests, and a handler-bypass mutation is now killed. See F41 |
| Six of seven state machines unwritten | Definitions exist but nothing writes through them | Stated in `INVARIANTS.md` and `EXECUTION_PLAN.md`. **Still open** — only `reservation` has a write path. |
| ~~No on-chain program~~ | ~~Capital is a database row, not an enforced account~~ | **CLOSED.** `mitra-vault` is live on devnet and all six PRD §52 clauses are verified. The remaining gap is that the *kernel* still holds capital locally in Postgres — the program proves the boundary, it does not yet hold production capital. See the phase audit |
| Devnet airdrop reports errors while succeeding | `solana airdrop` printed rate-limit failures and still credited 5 SOL | Never treat CLI output as the claim. `phase2-readiness.mjs` reads `getBalance` from the node, so a false "failed" cannot be mistaken for unfunded, or a false success for funded. |
| ~~Ledger is process-local on the kernel path~~ **RESOLVED** | Routes now go through `getStore()`; `InMemoryRepository` / `PostgresRepository` behind one interface | `tests/persistence.test.ts` — "routes served by postgres", incl. nonce surviving a simulated restart |

## F61 — a v2 mandate bounds raw units, not value: it names no token

**Status:** CLOSED — `evidence: LIVE_DEMONSTRATED, blocker: —`.
**Found:** 2026-10-04, porting the vault payment path (B.4) to v2 on `feat/backlog-on-v2`.
**Fixed:** 2026-10-04. Keyed mandates by `mapping(address => mapping(address => mapping(address => Mandate))) public mandates` (`[principal][holder][token]`) in `contracts/MitraVault.sol`. Added `address token` parameter to `openMandate`, `amendMandate`, `revokeMandate`, and `spendAuthorized`. Inverted reproduction test `test_F61_a_usd_sized_ceiling_lets_a_leaked_engine_key_take_5_btc` to assert revert `PRINCIPAL_MISMATCH`, and added `test_F61_scoped_mandate_still_spends_its_own_token`. Redeployed to Base Sepolia (`0xbd78e40b109bc7e47415ba544710ef1d6b9bbe8b`) and Tempo Moderato (`0x81798c6f4ff1257b53b0be512c979f2656269329`). 32/32 Forge tests pass; sagas re-verified green.

## F62 — Cross-chain CREATE address collision on identical deployer nonce

**Status:** CLOSED — `evidence: LIVE_DEMONSTRATED, blocker: —`.
**Found:** 2026-10-04, during verification of Phase 7 `MitraClearing` deployment on Base Sepolia and Tempo Moderato.

**Root cause:** Standard EVM `CREATE` derives contract address as `keccak256(rlp([deployer, nonce]))[12:]`. The deployer EOA `0xAeA8bc34df7745e35510214147a2F6A5e15Eb26D` deployed the canonical `MitraVault` on Base Sepolia at transaction nonce `0x2a` (42), and deployed `MitraClearing` on Tempo Moderato also at transaction nonce `0x2a` (42). This produced the exact same 20-byte address `0xbd78e40b109bc7e47415ba544710ef1d6b9bbe8b` across both networks for two entirely different contracts (Base = MitraVault, Tempo = MitraClearing).

**Hazard:** Tooling or operators treating a contract address as a globally unique identifier across chains without chain-scoping could silently interact with a vault when expecting a clearinghouse, leading to selector mismatch or unexpected state operations.

**Fix:**
1. Standardized all deployment records in `lib/evm/deployments.json` with CAIP-10 chain-scoped identifiers (`eip155:<chainId>:<address>`).
2. Redeployed `MitraClearing` on Tempo Moderato at nonce 43 (`0x2b`), yielding unique contract address `0x6ca633a0acbbd8838329e0b629a7cc12d029a31e` (tx `0xb94e8879abfe177dfa81440408b84dad0d7788f4dfb9d97bd6bbfe491e9e622c`, block `38263099`). Verified `operator() == deployer`.
3. Retained the superseded deployment in `lib/evm/deployments.json` and `forge/PROOF_LEDGER.md` with explicit notes explaining the nonce collision.

Options for the lead: add `address token` to `Mandate` (set at `openMandate`, checked in
`spendAuthorized`), or key mandates `[principal][holder][token]`. Either way, invert the
reproduction test to expect a revert — do not delete it.

## F64 — the deployed MitraClearing had no challenge outcome

**Numbering:** first recorded as F62 (shared context `ctx_38c77fddc6e979b5`), which the lead had
already used for the cross-chain CREATE collision above; renumbered F64. The contract's header
comment still reads "fixed in F62": editing it would change the source's metadata hash and so the
compiled bytecode, and the repository source must stay identical to the deployed instances.

**Status:** fixed in `contracts/MitraClearing.sol` (purple, 2026-10-05; decision
`ctx_79718f2aadabac9b`). Foundry 18/18. The fixed contract must be **redeployed**: the
instances at Base Sepolia `0x2179bf055c62c57eeb4045957d57f7e460df76d9` and Tempo Moderato
`0xbd78e40b109bc7e47415ba544710ef1d6b9bbe8b` run the flawed code and are superseded.
**Found:** 2026-10-05, reading the contract before building the Phase 7 epoch runner on it.

Reproduced in `contracts/test/MitraClearingChallenge.t.sol` against the deployed source:

1. **A challenge did nothing.** `finalizeEpoch` refused only `Finalized`/`Settled` and an
   open window, so a `Challenged` epoch finalized normally once the window closed. PRD §14.8
   requires a challenge outcome; the contract's own header said challenge existed so the
   operator "cannot unilaterally settle a challenged epoch".
2. **FROZEN accepted obligations.** `recordObligation` allowed `Frozen` (PRD §14.5: "New
   obligations are excluded"; its own comment: "Only while OPEN"). The operator supplied
   `inputsRoot` and nothing on-chain related it to the recorded obligations.
3. **A late result swap finalized without a window.** `recordSettlement` could replace the
   transfers and `resultHash` at any time in the window without restarting it: swap one
   second before close, finalize one second later.

Also: no function reached `Settled`, so PRD §14.5's SETTLING/SETTLED (receipts attached)
did not exist; `openEpoch` and `commitEpoch` could not both apply to one epoch. The
original 4 Foundry tests exercised none of these paths.

**Fix:** the PRD §14.4 lifecycle — `openEpoch(id, window)` → `recordObligation` (OPEN only;
folded into an on-chain rolling `inputsRoot`) → `freezeEpoch` → `proposeResult` (every
proposal restarts the window) → `challengeObligation` (only the obligation's debtor or
creditor; the leg is excluded and keeps its reason; the result must be re-proposed) →
`finalizeEpoch` (permissionless after the window; a challenged result never finalizes;
F47 single-shot) → `recordReceipt` per residual transfer → `Settled`. **Added:**
`proposeResult` checks on-chain that the transfers conserve every address's net position
over the included obligations, so a result that pays anyone what the obligations do not
net to reverts rather than waiting to be challenged. Epochs are capped at 64 obligations
and 64 transfers to bound that check. The lead's 4 tests are kept on the new API with
their assertions; the "permissionless challenge" test now challenges as a party, per the
decision.

**Not changed:** the operator is still one EOA. Conservation and party challenges bound
what it can propose; they do not decentralise it (spec 55.3).

## F63 — the "F61" MitraVault deployments ran pre-F61 bytecode

**Status:** fixed (purple, 2026-10-05; decision `ctx_0c8226e672997299`). F61 vaults redeployed with
the code verified on-chain; the vault rail re-proven live on both chains.
**Found:** 2026-10-05, preparing the Phase 7 live run on the vault rail.

`lib/evm/deployments.json`'s canonical vaults after `bfbe8a6` — Base Sepolia
`0xbd78e40b109bc7e47415ba544710ef1d6b9bbe8b`, Tempo Moderato
`0x81798c6f4ff1257b53b0be512c979f2656269329` — were recorded as the F61 deployment. On-chain
both runtimes are 8701 bytes (the previous v2's size), against 8816 for the F61 source; they
carry `mandates(address,address)` and the five-argument `openMandate`, and lack the token-keyed
forms (an `eth_call` to the 3-key getter reverts). The ledger's F61 "CURRENT figures" were
therefore true of the source and not of the chain: F61 was open live. The escrow sagas that
re-verified those deployments use `lockEscrow`/`refundEscrow`, which both versions share, so
they could not tell.

Separately, the TS vault transport still read the 2-key `mandates` — matching the stale
deployment, so the rail worked, and would have broken against a real F61 vault.

**Fix:** a test-first change to `lib/adapters/evm-vault-transport.ts` (it reads
`mandates(principal, holder, token)` for the token it pays); the live provisioning in
`tests/evm-vault-transport.test.ts` uses the token-keyed `openMandate`/`amendMandate`;
`scripts/deploy-evm-vault.mjs` keeps the stale entries under `vaultSuperseded` and refuses
unless the runtime code equals the artifact with immutables masked and the F61 selector is
present. New vaults: Base `0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489`, Tempo
`0x85409dfc30fa0671b06f98cc56c5b04eb921b568`.

**RULE ADDED:** (18) a deployment is not evidence until the code at the address is shown
to be the code in the repository. Record the runtime-code check with the address.

## F65 — `POST /api/v1/intents` overwrites an existing intent under the same id

**Status:** fixed (2026-10-06, first write wins with `409 INTENT_EXISTS`).
Contained on the MCP surface by purple, 2026-10-06 (decision `ctx_6341370a88640c6e`); fixed on
the HTTP route by lead, 2026-10-09 during Horizon 1 reconciliation.
**Found:** 2026-10-06, wiring `mitra_create_intent` (PP-1).

The route accepts a caller-chosen `intentId`, and both backends upsert on it: Postgres
`ON CONFLICT (intent_id) DO UPDATE`, in-memory `Map.set`. A second POST with the same id and a
different body therefore replaces the first intent's principal, objective, budget and mandate.
The route's own header says an intent is never mutated in place ("changing it is a new
intent, not a row mutation"), and `tests/intent-persistence.test.ts` "is idempotent on
intentId" only replays the *same* body, so it cannot tell idempotency from overwrite. The API
has no caller identity on this route, so anyone who can reach it can rewrite anyone's intent.

**Containment (not the fix):** `mitra_create_intent` does not take an `intentId`, and its
`toRequest` drops one if a caller smuggles it in, so the route assigns the id. Pinned by
`tests/mcp-server.test.ts` "never forwards a caller-chosen intentId (F65 …)", which is killed by
the mutation that forwards it.

**Fix, as suggested.** `app/api/v1/intents/route.ts` reads the existing intent before writing
and compares the whole body: identical → `200` with the STORED intent, different → `409
INTENT_EXISTS`. The `ON CONFLICT DO UPDATE` on the Postgres side is never reached for a
conflicting body, which is why leaving it there is harmless — the route is the guard, not the
store.

Pinned by `tests/intent-persistence.test.ts` "refuses to overwrite an existing intent with a
different body (F65)", which asserts the 409 **and** that the original objective survives.

**What this does NOT fix, recorded so the entry is not over-claimed.** The route still has no
caller identity. An attacker who can reach it can therefore still *reserve* an `intentId`
before its rightful owner does — a denial, not a rewrite. First write wins changed the second
from "silently replace anyone's principal, budget and mandate" to "stop the first requester",
which is a real reduction and not the same as authorisation. Closing that needs a caller on the
route, which is a larger change than this reconciliation.

## F66 — PRD §10.2's tool list had no way for a provider to start work

**Status:** fixed (purple, 2026-10-06).
**Found:** 2026-10-06, building the external-agent E2E (PP-1).

The kernel's lifecycle is `OPEN → FUNDED → EXECUTING → SUBMITTED → ACCEPTED`, and
`startExecution` (FUNDED → EXECUTING) may be instructed only by the provider. PRD §10.2's
initial MCP tools, which `lib/mcp/surface.ts` copied, have no tool for it. So an external
provider could fund-wait but never reach `mitra_submit_deliverable` over MCP. The existing
tests did not show the gap because they drove `startExecution` through the route directly.
`tests/participation.test.ts` "the whole lifecycle IS expressible" listed the needed tools
without that edge, so it passed while the claim was false.

**Fix:** `mitra_start_execution` (provider-signed, the same pass-through as the other
transitions) is on the surface and served. Added to the participation test's needed list.
`tests/external-agent-e2e.test.ts` reaches EXECUTING only through it, and refuses the
client's own signed attempt (`ACTOR_NOT_PERMITTED`). PRD §10.2 calls its list "initial"; the
extra tool is recorded here, not in the PRD.

## F67 — the Virtuals adapter mapped job states ACP never emits

**Status:** open (superseded in practice, not removed). Purple, 2026-10-06.
**Found:** 2026-10-06, building PP-2 against the ACP SDK and the live acpx API.

`VirtualsMarketplaceAdapter.toAgreementStatus` maps `open`, `funded`, `running`, `submitted`,
`completed`, `failed` and `canceled`. ACP's job phases are numeric: `REQUEST`, `NEGOTIATION`,
`TRANSACTION`, `EVALUATION`, `COMPLETED`, `REJECTED` and `EXPIRED`
(`AcpJobPhases`, `@virtuals-protocol/acp-node` 0.3.0-beta.40). So only the default branch
(`null`) would ever run against the real marketplace, and the tests asserting the mapping
tested vocabulary that was invented. The `VirtualsClient` interface it consumes
(`listProviders`, `openJob`) is likewise not ACP's API.

**Now:** `acpPhaseToAgreementStatus` maps the real phases. It splits ACP's `REJECTED`,
which covers both a declined request and a rejected deliverable, by whether the job reached
`EVALUATION`. The old class is left in place because AGENTS.md says not to remove working
behaviour, and `tests/virtuals-delegation.test.ts` exercises it. **Next:** rebuild the
class's transport over the acpx API with the PP-2 translators, then retire the invented map.

## F68 — `Agreement.externalJobRefs` is typed as objects and stored as strings

**Status:** open. Purple, 2026-10-06.

`lib/domain/types.ts` declares `externalJobRefs: ExternalIdentityRef[]` (`{ system, id, url? }`).
The open route's schema is `z.array(z.string())`, and the store keeps what the route passes.
So every stored agreement holds strings under an object type, and code that reads `.system`
gets `undefined`. Nothing reads it yet. PP-2 emits URN strings
(`virtuals-acp:<chainId>:<contract>:offering:…`) because that is what the route accepts.
**Fix:** decide one shape. Either the route accepts `ExternalIdentityRef` objects, or the type
becomes `string[]` with the URN grammar documented. Then add a parity test.

## F69 — the devnet harness derived the program id from a keypair `cargo clean` deletes

**Status:** fixed (lead, 2026-10-06, LP-4). The id is now committed and cross-pinned.
**Found:** 2026-10-06, mid-escrow-deploy, after `cargo clean` freed disk on a full volume.

`scripts/vault-devnet.mjs` derived the program id from
`programs/mitra-vault/target/deploy/mitra_vault-keypair.json`, on the reasoning — stated in its
own comment — that a derived id cannot drift from the binary. The reasoning is sound. The
mechanism is a build artifact:

- the keypair is not committed, deliberately: `tests/dev-scripts.test.ts` fails the build if any
  `*-keypair.json` is tracked, because holding a program's keypair is the right to replace the
  program at that address (F63's rule 18 has the same shape);
- `cargo-build-sbf` **generates** one if absent, and `cargo clean` deletes it.

So the first `cargo clean` between a deploy and a harness run replaces the key with a fresh one
whose id is a program that does not exist. Observed here: `cargo clean` → `27Li8mEF6MujjAuWa5E7KcRJNV7MqPQRiwzWVHR43J6L`,
a program that has never been deployed to anything, while the deployed program is
`GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY`. The harness aborted with `ENOENT` and the escrow
upgrade had to be re-run with an explicit `--program-id`.

Worse in the other direction, and this is the failure the derivation was written to prevent: a
*stale* keypair sitting next to a *newly built* `.so` makes the harness confidently drive the
**previous** deployment and report its failures as if they were current. The guard re-introduced
through the mechanism meant to guard.

**Fix:** `scripts/mitra-program.mjs` commits the **address** (not the key) plus the program's
discriminators and lengths for the `.mjs` harnesses. `vault-devnet.mjs` defaults to it, and
treats the build keypair as a *corroborating* signal: agreement is reported, disagreement is
reported loudly and then ignored. `tests/dev-scripts.test.ts` pins the committed id to
`VAULT_PROGRAM_ID` and to the Rust `PROGRAM_ID_BYTES` via `tests/golden/vault-layout.json`, and
pins every `.mjs` discriminator, length and PDA to Rust-generated bytes — so a redeploy at a new
address fails a test rather than pointing a harness at nothing.

**RULE ADDED:** (19) a build artifact is not a source of identity. If a script's *target* must be
known and correct after `cargo clean`, the target is committed and cross-pinned; a keypair that
the build regenerates cannot identify anything. An upgrade passes `--program-id <address>` with
the upgrade authority from `.dev-keys/`, which works without the program keypair at all.

## F70 — the job escrow silently disabled every reservation and release on its vault

**Status:** fixed (lead, 2026-10-06, LP-4) before any settlement depended on it.
**Found:** 2026-10-06, on devnet, re-running `scripts/vault-devnet.mjs` after an escrow left
outstanding.

The vault's lamports are checked on every `reserve` and `release` by
`check_no_surplus_lamports`, which asserts `lamports == total + rent`. That was written when
every lamport of `total` was in the vault account. `lock_escrow` moves lamports *out* to the
escrow PDA while `total` deliberately does not change — `total` is Mitra's capital, and
`escrowed` is how much of it the vault can no longer reach.

With one outstanding job the check fails, so `reserve` and `release` return `0x1773`
(6003 UNEXPECTED_LAMPORTS) — for **every** amount, and for the whole vault. A single escrowed job
disabled the reservation mechanism entirely; `release` failing is the worse half, since a release
is how reserved capital comes back.

The arithmetic identifies the fix as exact rather than approximate: with 2,000,000 escrowed,
`total − escrowed + rent = 6,093,706 − 2,000,000 + 1,183,640 = 5,277,346`, which is the vault's
lamported balance to the lamport.

**Why no test caught it.** Every escrow test either used a fresh vault or asserted the escrow's
own transitions; none ran `reserve` against a vault with an outstanding escrow. The escrow suite
was 39/39 green and 8/8 mutation-killed while this was live on devnet. The lesson is the F19 one
again — a suite that never composes two features cannot see their interaction.

**Fix:** `Vault::held()` returns `total − escrowed`, documented at the call site, and `reserve`
and `release` check against it. Subtracting `escrowed` is not a weakening: `escrowed` is written
only by the three escrow transitions, each of which moves exactly the lamports it accounts for,
and the account is a program-owned PDA whose data nothing else can alter — so `held()` is still
precisely the capital the vault holds, and any lamport above or below `held() + rent` is still an
unaccounted injection or a drain. `tests/escrow.rs` gains the regression
(`an_outstanding_escrow_does_not_break_the_vaults_lamport_identity`) and an assertion that the old
expectation *is* the bug; `scripts/vault-devnet.mjs` and `scripts/escrow-devnet.mjs` assert the
corrected identity, because a harness that disagrees with the program about what the balance should
be reports the program as broken when the harness is the stale copy.

**Consequence accepted:** `FR-VAULT-006`-style claims about "reported spendable capital never
exceeds actual available" are unaffected — `available` never includes `escrowed` — but any
statement of the form "the vault's balance equals its capital plus rent" is now false by design
and was true by accident before.

**RULE ADDED:** (20) when a feature moves value out of an account, every invariant that counted
that value *in that account* is a bug until re-derived. Write the composition test (new feature ×
old invariant) before the feature ships, not after the old suite stays green.

## F71 — the Arcium cluster echoes `nonce + 1`, so a nonce must never be a counter

**Status:** open (upstream: Arcium 0.15.0). Worked around, measured and asserted;
**not** "fixed", because the behaviour is in a third-party runtime.
**Found:** 2026-10-06, LP-5, first live `evaluate_mandate` run.

`evaluate_mandate` queues a `plaintext_u128` nonce and the callback emits
`SignedComputationOutputs.nonce` in the `MandateDecisionEvent`. The value that comes
back is the value that was sent **plus one**. Measured on a live cluster across three
probes, every magnitude:

| queued (u128)                  | on-chain nonce                  |
|--------------------------------|---------------------------------|
| `1`                            | `2`                             |
| `18446744073709551616` (2^64)  | `18446744073709551617`          |
| `0x59932e7ccc141ad…` (random)  | `0x5a932e7ccc141ad…`            |

Not a client-side encoding artifact: `deserializeLE(nonce) → BN → toArrayLike('le',16)`
was verified to be byte-identical in isolation for every top-byte value, so the
`+1` is introduced on the Arcium side. The Anchor program's `nonce: u128`
deserializes correctly (`@anchor-lang/borsh`'s `BNLayout.encode` is
`src.toArrayLike(Buffer, "le", 16)`), and the client sends what it intends.

**Why it matters.** The nonce is meant to identify the request that produced a
decision. Under this transform **adjacent counters collide**: the decision for `n`
can be presented as the decision for `n+1`. Anything that keys on the nonce —
idempotency, replay rejection, an audit trail — must use a value with no close
neighbours.

**Fix applied:** the live suite uses a random 16-byte nonce per computation and
asserts the *exact* transform rather than raw equality (`echoedNonce` in
`tests/probe.ts`), because asserting equality with what was queued asserts something
false about a third-party runtime, and asserting nothing drops the check that ties an
on-chain decision to the request that produced it. **A 128-bit random nonce is
unaffected**; the transform costs binding precision, not correctness — the circuit's
input is the encrypted struct and the caller decrypts with its own Rescue-CTR nonce,
so no decision is affected.

**RULE ADDED:** (21) when integrating a third-party runtime, measure the values it
*echoes back*, not the values it is documented to accept. An echoed identifier is the
one an integration actually depends on, and it is the one nothing tests.

## F72 — a 2-node Arcium localnet submits every callback twice

**Status:** worked around; recorded, not fixed (upstream cluster behaviour).
**Found:** 2026-10-06, LP-5.

On the localnet, the cluster submits the callback **twice in the same slot**: one
attempt succeeds and runs `evaluate_mandate_callback`, the other loses the race and
fails with `AlreadyCallbackedComputation` (6204). Observed on every single
computation:

```
3VJCk7QKQBeDG9FtR4At…  slot 1114  err=none                     ← ran the handler, emitted the event
48SEJR7aPAjCD1rbgpJ…  slot 1114  InstructionError [2, 6204]   ← AlreadyCallbackedComputation
```

**Why it matters.** `@arcium-hq/client`'s `awaitComputationFinalization` returns
whichever finalization signature it saw first, which here is regularly the *losing*
one. So the first draft of the live suite reported a failed callback for
computations that had in fact produced a decision, and a cluster run looked broken
when the cluster was working.

**Fix applied:** `awaitWinningCallback` in `tests/probe.ts` does not use
`awaitComputationFinalization` at all. It polls the program's signatures for a
transaction that **(a) names this computation's account**, **(b) has `meta.err ===
null`**, and **(c) carries the event**. Matching on the computation *account address*
rather than on a log string is what stops a neighbouring test's decision being picked
up.

**A signature is not evidence that a computation finished.** The same rule the
repository already applies to EVM receipts, arriving from a different direction.

## F73 — the Arcium integration test was still the `add_together` TEMPLATE

**Status:** fixed (lead, 2026-10-06, LP-5). 13/13 live against a real cluster.
**Found:** 2026-10-06, before attempting the cluster run.

`tests/probe.ts` was byte-for-byte Arcium's `arcium init` output: it called
`addTogether`, `initAddTogetherCompDef`, awaited `sumEvent`, and uploaded
`build/add_together.arcis`. `programs/probe/src/lib.rs` had been rewritten for
`evaluate_mandate` by F44. **So the one artifact that would have caught the
half-migration was the artifact left behind**, and `arcium build` compiles the
encrypted instruction and exits green either way.

This is F44's shape stated plainly: a partially-migrated project looks finished,
because the build is green and the only test is the template's. `FR-VAULT-008` and
`FR-VAULT-009` were `UNTESTED` while `tests/arcium-circuit.test.ts` passed 14/14 —
the hermetic mirror was green and the circuit had never been executed by anything.

Three further defects in that template's shape were found only by running it:

- **`getCompDefAccAddress` takes a `number`**, not the 4-byte offset the template
  passed. Passing bytes derives a **different PDA** and the instruction then fails on
  an account constraint, with an address that looks entirely plausible.
- **`awaitComputationFinalization` is not usable here** — see F72.
- **A `Connection` built by `AnchorProvider.env()` is `processed`**, and
  `getTransaction` refuses anything below `confirmed`. Every "read the evidence
  back" step failed with a commitment error that reads like a cluster fault.

**Also fixed here:** the callback key must come from the *same* x25519 secret as the
shared one. Deriving it from a throwaway (as a first draft did) produces a
computation that finalizes perfectly and whose output nobody can read — a fully green
cluster run proving nothing.

**RULE ADDED:** (22) after rewriting an integration to a new protocol vocabulary, grep
the integration for the old vocabulary. A renamed method, account or event leaves a
template's call sites behind; they compile, they wait forever, and they never throw.

## F74 — the confidential policy circuit, its Anchor program and its live suite live outside the repository

**Status:** partially fixed (lead, 2026-10-06). Circuit source committed; the rest open.
**Found:** 2026-10-06, LP-5, while recording where the evidence came from.

The whole Arcium implementation is at `/home/ubuntu/arcium-probe/probe/`, untracked:

- `encrypted-ixs/src/lib.rs` — **the circuit**
- `programs/probe/src/lib.rs` — the Anchor program that queues computations
- `tests/probe.ts` — the only integration test that has ever executed it
- `build/evaluate_mandate.arcis` — the compiled artifact the cluster runs

Consequences, in order of severity:

1. **The hermetic mirror could not be audited.** `tests/arcium-circuit.test.ts` says
   it is "kept line-for-line with the circuit's structure" — of a file that is not in
   version control. A transcription of an invisible source can only be wrong in one
   direction: nobody reviewing Mitra can read the thing it mirrors.
2. **The live evidence is not reproducible from the repository.** Every claim in
   `forge/PROOF_LEDGER.md` about Arcium traces to a checkout that a `git clean` on a
   different machine cannot produce.
3. **The program ID and cluster offsets are untracked.** The circuit is bound to
   `7ZAm4faeREU54yDKWBKqfvRjSucgxBT5zaMWyJvYcU29`; nothing in the repository records
   it.

**Fixed now:** the circuit is committed at
`programs/arcium-policy-circuit/encrypted-ixs/src/lib.rs` **and so is the Anchor
program** at `programs/arcium-policy-circuit/anchor-program/src/lib.rs`, so both halves
of the computation are reviewable here. `tests/arcium-policy-circuit.test.ts`
(11 tests, mutation audit 7/7) asserts the hermetic mirror still matches the circuit — reason numbering, `is_nonzero`'s form, the absence
of `when_allowed`, every `reason` write guarded, the six inputs in queue order, the
five gates in order, no timestamp, an encrypted return, and none of the six binding
fields. The direction of the copy is stated in that directory's README: the working
tree is re-synced **from** the repository, never edited alongside it.

**Still open:** `tests/probe.ts` — the only integration test that has ever executed
the circuit — is **not** committed, and neither is the compiled `.arcis` artifact. The
test imports `../target/types/probe`, which exists only after a build in the working
tree, so committing it would place a file in the repository that looks runnable and is
not. The localnet runbook and both host prerequisites (the validator bind address, and
the `ufw` rules on 8899 *and* 8900) are recorded in the committed README, so the run is
documented here even though the script is not. **Until that closes, the evidence for
`FR-VAULT-008` is real but the script that produced it is not under version control.**

**RULE ADDED:** (23) a mirror must live next to its source. A hand-written mirror whose
original is untracked is not a test of the original, and it cannot be repaired by
anyone who finds it wrong.

## F76 — a committed compensation route ID was not a commitment

**Status:** fixed (2026-10-06). Route hash-committed at declaration and re-derived at compensation time.
**Found:** 2026-10-06, LP-3 task 2, while wiring the agreement route's on-chain escrow per PRD §15.5.

`Saga.compensationRoutes` is `string[]` — route **ids**. The route **bodies** live in
`CompensationRoute.route`, and `compensate()` receives those from a caller-supplied
`availableRoutes` array on every invocation (F47 fixed the attempt counter to stop
depending on that array; the route content still did). So the check was:

```ts
const route = input.availableRoutes.find((r) => r.routeId === input.routeId);
if (!route) return fail("COMPENSATION_ROUTE_NOT_COMMITTED");
```

Which asks "did the caller use an id I declared?" — not "is this the route I committed
to". A caller could return the committed id carrying entirely different instructions:
another contract, another job, another payee, and the engine would run it. The engine
was not inventing calldata after a failure, so §15.5's sentence read as satisfied; it
was faithfully executing what it had been handed. That is the same class of defect as
F51 (caller-chosen payee) and F47 (caller-supplied budget) — a control that reads as an
enforcement point and is actually a request.

**Why the id was the only thing checked.** The id and the body were two unrelated values
from the start. `declareSaga` kept the ids and discarded the routes, so at compensation
time there was nothing on the saga to compare a route body against. No amount of checking
inside `compensate` could have closed it; the commitment had to start being stored.

**The fix.** `routeCommitment(route) = keccak256(route)` (`lib/domain/canonical.ts`),
recorded per route at `declareSaga` — the last moment before any step runs — and
re-derived from the route about to be compensated. A mismatch is
`COMPENSATION_ROUTE_REDIRECTED`; a saga with no commitment at all is
`COMPENSATION_ROUTE_NOT_COMMITTED`, because unverifiable is not verified.

Three decisions inside that:

- **keccak256, not the `sha256:` the rest of `canonical.ts` uses.** Those hashes name
  Mitra objects and nothing reads them off a chain. This one must equal the
  `refundRouteHash` the escrow account stores, because the contract's zero-check and
  the kernel's redirect-check are two halves of one guarantee. Two digests over one
  route would leave them agreeing about nothing.
- **Commitment over the route string, excluding `maxAttempts`.** Raising the retry
  budget is the caller's business and F47 already counts attempts on the saga; refusing
  it here would break legitimate retries to fix an unrelated reason.
- **Legacy sagas refuse.** A saga persisted before this field has no commitment, and
  allowing it would mean the guarantee holds only for sagas created after this commit.

**Where the value comes from now.** `applyAgreementOpWithSaga` builds the refund route
from the same `chain`/`contractAddress`/`jobId` the escrow account is opened with, and
derives the commitment from that — it is never accepted from the request. A
caller-supplied `refundRouteHash` would be a real hash about a different route, which
is worse than no commitment because it looks like one. The agreement carries it as
`refundRouteHash`, so the number handed to `depositToEscrow`/`lock_escrow` and the
number the kernel verifies are one value.

**Evidence.** `tests/recovery.test.ts` +5: the substituted route is refused; the
committed route still runs; a `maxAttempts` bump is not a redirection; a legacy saga
cannot compensate; the commitment is deterministic and 32 bytes. `tests/commerce-saga.test.ts`
+5 and `tests/agreements-api.test.ts` +1 cover the commitment reaching the agreement and
the HTTP response. **Mutation audit 3/3 killed** on `tests/recovery.test.ts`: removing
the redirect check, removing the missing-commitment refusal, and computing the
commitment at compensation time from the caller's route (2 failures) each turn it red.

**Still open.** Nothing yet calls `depositToEscrow`/`lock_escrow` from the agreement
route, so this makes the commitment correct but does not move capital — see
`EXECUTION_PLAN.md` §4.

## F77 — the saga write and the agreement write are not atomic, stranding an ARMED saga

**Status:** FIXED (2026-10-06), Option 1 — `commerce-recovery.ts` is store-free.
**Found:** 2026-10-06, immediately after F76, while asking whether an irreversible chain call could safely live in the fund path.

`applyAgreementOpWithSaga` persists the ARMED saga and **returns**
(`lib/kernel/commerce-recovery.ts:147`). The route then persists the agreement
(`app/api/v1/agreements/route.ts:310`). Two transactions, no enclosing one.

If the route's write never lands — process dies, connection drops, constraint
violation — the store keeps an ARMED saga that no agreement names. It is then
unreachable *by construction*: every later op finds its saga through
`agreement.sagaIds?.[0]` (`commerce-recovery.ts:167`), which is empty, so line 168
returns early and recovery is never touched. The agreement itself is still `OPEN`,
so `startExecution` is refused as an illegal transition. There is no operation that
moves it, and no reconciliation that finds it.

**Why this is worse than a generic torn write.** An ARMED saga is not inert. §15.5's
guarantee is that a compensation route is committed *before* execution; a stranded
ARMED saga is a committed route with no execution behind it, and F76's commitment
hash is sitting on disk with nothing able to check or run it. The invariant the
saga exists to provide — every multi-step workflow has a way back — is quietly false
for that agreement, while every health check that reads "agreement has a sagaIds" or
"saga is ARMED" reports success.

**Root cause is a documented-design violation, not a missing transaction.**
`EconomicRepository`'s own doc says the write path is the store-free kernel and that
"keeping the kernel store-free is what lets the same lifecycle be exercised in a unit
test". `lib/kernel/commerce.ts` honours that. `commerce-recovery.ts` does not: it
calls `saveSaga`/`updateSaga` in three places, which is what splits the fund write
in half. Adding a transaction would close this symptom while leaving the kernel
writing, and the next write added to the kernel would reopen it.

**Two candidate fixes, deliberately not chosen here.**

1. *Make `commerce-recovery.ts` store-free* — return the sagas to persist and let the
   routes write them alongside the agreement. Consistent with the interface's stated
   design; touches 3 kernel writes, 2 routes and 2 test files.
2. *Add `transaction(fn)` to the repository* and wrap each route's writes. Smaller
   diff, but the kernel keeps writing and the trap stays armed. Also largely
   untestable in this repository's dominant in-memory backend, which has no
   transactions — the fix would be verified only by the Postgres suites.

Option 1 is the better fix and the more expensive one. That trade is a call for the
lead, not a detail to settle inside a bug fix.

**Evidence.** `tests/torn-write-probe.test.ts` walks the tear end to end: saga
persisted ARMED → route's agreement write never lands → `sagaIds` empty → `OPEN`
agreement refuses `startExecution` → the ARMED saga is still ARMED with its F76
commitment attached. Written as `it.fails` asserting the *invariant* ("a persisted
ARMED saga is never left unreachable"), so the suite is green today and vitest reports
a failure the moment someone makes the fund path atomic. A plain `it` asserting
today's behaviour would have made the repair look like a regression.

**The fix (Option 1, approved by the lead).** `applyAgreementOpWithSaga` no longer
takes a repository: it is synchronous, reads nothing, writes nothing, and returns
`sagasToPersist` alongside the agreement and space. It also takes the agreement's
current saga as an argument instead of fetching it — a kernel that looks up its own
state cannot be tested against a state the test did not choose.

The write happens in `lib/commerce/commit-op.ts`, in this order:

```
agreement FIRST — it is what NAMES the saga — then the sagas
```

The reverse leaves an agreement naming a saga that is not there, which the kernel
already treats as a broken link rather than an error (`commerce-recovery.ts:173`). The
cheap failure, chosen because it costs a saga and never strands capital. **The route
and the test suite both go through `commitAgreementOp`**, deliberately: the ordering IS
the guarantee, so if each caller assembled its own writes the copy in the tests would be
the one that stopped being maintained — and a test that persists sagas before
agreements would keep passing while the product did the opposite.

**Evidence.** `tests/torn-write-probe.test.ts` rewritten from `it.fails` to a plain
`it` (3 tests): a lost agreement write leaves NO saga; both writes succeed and the
agreement's `sagaIds` names the ARMED saga; a store missing the optional write methods
refuses with `AgreementStoreIncomplete` before writing anything. **Mutation audit 5/5
killed**, plus M5 for a `this`-losing bug this refactor introduced itself (see below).

**Two bugs this work found in itself, both worth naming.**

- *A guard that could not fire.* The first version checked `saveSaga`, which is
  **required** on `EconomicRepository` — so the check was unreachable dead code that
  read like protection. Now it checks only `updateAgreement`/`updateSpace`, which really
  are optional, and its test asserts the error **class** rather than the message: a
  `/updateSpace/` regex also matches the raw `TypeError` you get with the guard removed,
  and that weak assertion let the "drop the guard" mutation survive a full round.
- *Losing `this`.* Writing `const { updateAgreement } = repo; await updateAgreement(…)`
  drops the receiver and dies on `this.agreementsMap`. Caught by the existing tests, not
  by reasoning. The comment in `commit-op.ts` says so, because it is the obvious
  "tidier" edit and it is wrong.

**Why this unblocked the obvious next step.** Wiring `depositToEscrow`/`lock_escrow`
into the fund path means an irreversible chain call. That is now safe from the tear, and
the §15.5 commitment it will carry is genuinely reachable. Two more defects surfaced
while proving it against a real database — see F79 and F80.

## F79 — `saveSaga` names its columns explicitly, so a new `Saga` field is silently dropped

**Status:** fixed (2026-10-06).
**Found:** 2026-10-06, while running the F77 suites against real PostgreSQL.

`PostgresRepository.saveSaga` writes an explicit column list. Adding
`routeCommitments` to the `Saga` type and enforcing it in the kernel was therefore not
enough — the field reached the database call and vanished. The next `compensate` on that
saga failed with `COMPENSATION_ROUTE_NOT_COMMITTED`.

**It failed CLOSED, which is exactly why it survived.** The in-memory store keeps whole
objects, so 1128 in-memory assertions stayed green while the only backend that runs in
production quietly lost the §15.5 commitment. A guarantee that is enforced in the kernel
and absent in the datastore is not a guarantee; it is a check that happens to fail
loudly instead of silently passing, which is better than the reverse and still a defect.

**The test that should have caught it did not, because it was a hardcoded list.**
`tests/saga-persistence.test.ts` asserted that `mitra.sagas` contains eleven columns
named out by hand. Adding a twelfth field to the type did not touch that list, so it
could not fail. It now derives the expected columns from a representative `Saga`'s own
key set against an explicit camelCase→column mapping, so a new field cannot be added
without the test noticing.

Two more gaps in the same method, both closed at once: the parameter array was not
extended when the column was added to the SQL (the query would have failed loudly, but
only at runtime against a real database), and the `ON CONFLICT DO UPDATE` clause needs
the column too or every saga that advances once loses it.

**The general lesson, which is the reason this is recorded rather than just patched.**
Any `Saga`/`Agreement` field added to a domain type must be added to the Postgres write
list, the row mapper and the migration in the same commit. Three of the four repositories
store whole documents as JSONB and need nothing; `sagas` is the odd one out with named
columns, which makes it the one place this failure can happen. The derived-column test
now guards exactly that place.

**Evidence.** `tests/saga-persistence.test.ts`: the derived column assertion, plus an
F79 test that persists `routeCommitments`, re-reads through a **fresh** `getSaga` —
reading back the object the kernel returned would prove nothing — checks it equals
`keccak256` of the refund route, checks the agreement carries the identical value, and
then drives the saga all the way to compensation **from reloaded state**.

## F80 — the refund route was rebuilt after the failure, so no on-chain escrow could ever be refunded

**Status:** fixed (2026-10-06).
**Found:** 2026-10-06, by F76's commitment check refusing a legitimate refund.

At `rejectDeliverable` the kernel reconstructed the refund route from
`agreement.escrowRef`, which is only the job id:

```
funded as     evm:refundEscrow:baseSepolia:0x6a73…:0x7c7c…
rebuilt as    evm:refundEscrow:0x7c7c…
```

F76 hashes the committed route and re-derives the hash of the route about to run, so this
failed with `COMPENSATION_ROUTE_REDIRECTED` — **correctly, and permanently**. The string
being executed was not the string that was agreed, and no amount of retrying helps. Every
agreement funded against an on-chain escrow would have reached REJECTED and been
permanently unrefundable, with the capital sitting in the escrow until its timeout.

This is §15.5's actual prohibition, arrived at from the other direction: the rule is not
only "do not invent a route", it is **"do not reconstruct one"**. The refund was reading
whatever the agreement happened to still carry, and an agreement only ever stored the
job id — the chain and contract lived in the caller's request and nowhere else. The
recovery path's correctness depended on the caller happening to resend `onChainEscrow`.

**Why every suite missed it.** `tests/commerce-saga.test.ts` passes `onChainEscrow`
again on the reject call, which reconstructs the full route by hand at the call site and
makes the kernel's reconstruction agree with the commitment by coincidence. The bug only
appears when the caller does NOT resend it — which is the realistic case and the one a
timeout refund takes, since nothing is driving the request.

**The fix.** `declareSaga` now records `committedRoutes` (routeId → route body) next to
the hashes, taken from the same declaration, so the two cannot disagree. The reject path
builds `availableRoutes` from those committed bodies and consults nothing else. The
pre-F80 reconstruction survives only as the fallback for a saga declared before the field
existed, where the commitment check will refuse anything that does not match — the right
outcome for an unverifiable route.

**Evidence.** `tests/saga-persistence.test.ts` (F79 suite) asserts the committed body
survives the round trip **and** that a reloaded saga can still reach compensation.
Mutation audit: reverting to the `escrowRef` reconstruction → 1 failure; dropping
`committedRoutes` from the `Saga` mapper → 1 failure; dropping it from `declareSaga` → 8
failures.

## F78 — the in-memory backend silently tolerates what PostgreSQL refuses

**Status:** open (recorded 2026-10-06). Not fixed; it is a property of the test backend.
**Found:** 2026-10-06, four times in one hour, while making the F77 suites pass on both backends.

`InMemoryRepository` and `PostgresRepository` do not agree on the contract, in the same
direction every time: **the cheap backend accepts things the real one rejects.**

| Call | In-memory | Postgres |
|---|---|---|
| `updateAgreement` | `Map.set` — upsert, silently creates | strict `UPDATE`, throws `AGREEMENT_NOT_FOUND` |
| `saveAgreement` | `Map.set` — overwrites a duplicate id | `INSERT`, throws on the primary key |
| `agreement_spaces` FK | not represented, so never enforced | enforced; a missing Space fails the write |

Every one of these produced a green in-memory suite and a red Postgres run on a fixture
that had been quietly relying on the tolerance. Three test files needed real changes for
this reason alone.

**Why it matters beyond test convenience.** 68 of 77 test files run against the in-memory
backend by default. A suite can therefore be green while the production backend would
refuse the same calls — which is precisely what happened to F79, and what made F80
invisible. The divergence is not a test bug; it is the reason the whole `DATABASE_URL`
matrix exists, and the reason approving the devbox Postgres privileges (lead, this
session) was worth more than it looked.

**Also surfaced, and fixed here.** Two fixtures assumed a clean slate that only exists
in memory: `__resetStoreForTests` resets nothing in Postgres, so ids generated from a
counter that restarts at 1 collide with the previous run's rows. Both now carry a
per-process nonce, without which the second run of a suite fails with
`duplicate key value violates unique constraint "agreements_pkey"` — a failure that looks
like a product bug and is not.

**Open, deliberately.** Making `InMemoryRepository.updateAgreement` strict like Postgres
would catch more of this in the default suite, but it would change behaviour for every
test that passes an unpersisted agreement, and that is a bigger call than this entry.

## F81 — the two rails computed the §15.5 commitment differently

**Status:** fixed (2026-10-08).
**Found:** 2026-10-08, LP-6, before writing a line of escrow code.

Two functions derived "the hash of a refund route" and they did not agree:

| | definition |
|---|---|
| `routeCommitment` (`lib/domain/canonical.ts`, added with F76) | `keccak256(route)` |
| `routeHashFor` (`lib/solana/vault-program.ts`) | `sha256("mitra-recovery-route-v1:" + route)` |

Both produce 32 bytes, and neither contract can read a hash — `MitraJobEscrow.sol` and
the Solana `JobEscrow` program only check it is non-zero. So the disagreement was
**invisible on chain** and only became real when LP-6 needed to hand *one* value to both
rails and store it on the agreement, and there was no single value to hand.

The Solana definition won: it is what LP-4's live devnet proof actually committed, so it is
the deployed reality; and a domain prefix is the correct construction, because without one
the same route string hashed for another purpose yields the same commitment — exactly the
collision `typedHash`'s domain prefixes exist to prevent. `routeHashFor` now delegates to
`routeCommitment`, so there is one implementation.

Note the direction of the near-miss: F76's own comment argued for keccak256 *because* it
must equal what the escrow stores, and would have been right had both rails used it. The
defect was not the choice of digest, it was having two choices.

**Evidence.** `tests/canonical.test.ts` (F81): 32 bytes and `0x`-prefixed; domain-separated
(compared against a bare hash of the same route); and byte-for-byte agreement with
`routeHashFor`, imported from the Solana module so the two cannot drift again.

## F82 — `ERC8183Transport.getJob` returned an array, so every named field was `undefined`

**Status:** fixed (2026-10-08). Found by the LP-6 live suite on its first run.
**Found:** 2026-10-08, LP-6, `JOB_ESCROW_LIVE=1`.

`jobs(...)` declares its return as a **flat list** — `returns (bytes32 jobId, address
clientVault, ...)`. viem therefore returns an **array indexed 0..8**, so every named access
(`job.amount`, `job.status`, `job.provider`) was `undefined`.

It went unnoticed for two independent reasons, and both had to be removed for the bug to
die:

1. **The function had no callers.** Nothing had ever exercised it against a deployed
   contract. `tests/commerce-escrow-live.test.ts` *did* read it — but positionally,
   `job[7]` and `job[8]` — so the array shape was observed and worked around rather than
   fixed, and the workaround read like knowledge of the struct.
2. **Every caller cast its way past it.** `as unknown as EvmEscrowRail` in
   `escrowRailFor` — written during LP-6 — made an array-returning `getJob` type-check as a
   named-returning one. That cast is removed, so a shape divergence now fails to compile;
   the removal immediately caught two further mismatches (`status` as `bigint` vs `number`,
   and `getJob` resolving to `undefined`).

**Why it matters more than a decode bug.** `getJob` is the input to the probe that decides
whether to move capital. With `amount === undefined`, the absence test
(`job.amount === 0n`) was **false**, so a job id that had never been funded fell through
to comparing terms made of `undefined`s and reported `MISMATCH`. The live suite hit this
within a second of running: `expected [ 'ABSENT', 'FUNDED' ] to include 'MISMATCH'` on a
freshly generated agreement id. **A probe that cannot distinguish "no escrow" from
"malformed answer" is not a safety mechanism** — it is a coin flip that happens to land on
"refuse", which is the safe side for a *mismatch* and catastrophic for an *absence*.

**The fix.** `normalizeJobRow` maps positionally onto named fields, accepts an
already-named row, and **throws `UNREADABLE_RETURN_SHAPE`** on anything else — because a
malformed answer must never be read as "no escrow".

**Evidence.** `tests/agreement-onchain-escrow.test.ts` (F82) pins the *observed wire shape*
captured from the deployed contract — a fixture written to match the code rather than the
chain would have passed while the probe was still broken, which is how this survived. Four
tests: positional mapping; the zeroed row reads as ABSENT (the actual bug); idempotent on
a named row; and throws on `undefined`, a short array, and a string. A fifth asserts the
concrete transport assigns to the bridge interface without a cast.

**Verified live.** `0x75dbc74252698faa3aa2a583bc79cea90b4598cbb8a00dad1bba3fd9763fb928` on
Base Sepolia: `depositToEscrow` → receipt `success`, `JobFunded` emitted from
`0xc49c93f0…` with `topic1` equal to `sha256(agreementId)`, and the repaired `getJob`
reading `amount 1, status 1`.

**One observation, not a defect.** Immediately after that receipt the same `getJob` read
`amount 0` on the public endpoint, then read `amount 1` a minute later — RPC state
propagation on a load-balanced provider. The safety property does not depend on this: the
contract refuses a second deposit for a live `jobId` (`MitraJobEscrow.sol:89`,
`AlreadySettled`), so a stale-ABSENT retry reverts rather than double-funding. The probe is
an optimisation against that revert, not the guarantee — which is worth stating, because
"probe first" reads like the load-bearing control and is not.

## F83 — an agreement had no on-chain provider to escrow for

**Status:** fixed (2026-10-08).
**Found:** 2026-10-08, LP-6, while writing the route integration.

The escrow step derived the escrow's provider from `agreement.provider`, which is a Mitra
**agent id** (`agent_data_03`) — not an EVM address and not a Solana pubkey. Every probe
would have reported `ESCROW_PROVIDER_DIFFERS` against any real escrow, and the fund path
could never have escrowed anything.

The correct source is `agreement.payTo`, the term `assertSettlementBinding` records
precisely so the payee cannot be chosen by whoever calls settle — the F51 caller-chosen-payee
defect, already fixed on the settlement side and reintroduced here by reaching for the
nearest-looking field.

Two guards now refuse rather than guess:

- `ESCROW_PROVIDER_ADDRESS_MISSING` — no `payTo`, so there is no on-chain party.
- `ESCROW_CHAIN_DISAGREES_WITH_PAYTO` — the escrow's chain and the agreement's `payTo` chain
  must agree. A `payTo` recorded for Solana cannot receive a Base Sepolia payout: the address
  is a base58 pubkey where the contract wants 20 bytes. The Space already refuses a `payTo`
  on a chain it does not settle (`SETTLEMENT_CHAIN_NOT_ALLOWED_IN_SPACE`), which is why this
  surfaced during test setup — but that check is about the Space, not about the escrow being
  requested, and neither substitutes for the other.

**Evidence.** `tests/agreements-api.test.ts` (LP-6): both refusals, plus the caller-chosen
`ESCROW_JOB_ID_MISMATCH` — the escrow identity is derived from the agreement, so a request
naming a different `jobId` is refused rather than funding an escrow the §15.5 commitment does
not cover. Mutation: removing any of the three guards turns the suite red.

## F84 — two fixtures asserted a clean database that only exists in memory

**Status:** fixed (2026-10-08).
**Found:** 2026-10-08, running `npm run test:postgres` for LP-6.

Instances of F78 found by the matrix, both of which **passed in memory and asserted the
wrong thing**:

- `tests/intent-persistence.test.ts` — `prepareStore()` in `beforeEach` resets the in-memory
  store and nothing else. Against Postgres a shared `intentId` made the second test's create
  an idempotent **replay (200)** where it asserted a fresh create (201). Worse, the F65 case
  ("refuses to overwrite an existing intent with a different body") compared against an
  intent left over from a **previous run**, so the refusal was not being exercised at all.
  Its fixed `i0`/`i1` ids had the same effect: the "refuses a zero budget" assertions were
  passing because the create was refused for being a duplicate.
- `tests/commerce-saga.test.ts` — a second `openAgreement` call site that bypassed the helper
  fixed in F77, still using the literal `ag_1` and never persisting, so `commitAgreementOp`'s
  strict `UPDATE` raised `AGREEMENT_NOT_FOUND`.

Both now generate per-run, per-test identities. This is the concrete cost of F78 being open,
and the argument for closing it.

## F85 — the two rails mean different things by the same field names

**Status:** fixed (2026-10-08), with the Solana rail slice.
**Found:** 2026-10-08, while wiring `escrowRailFor` for Solana.

The bridge's `EscrowTerms` has one shape and **two meanings**:

| | `client` | `amount` |
|---|---|---|
| EVM | a deployed MitraVault address the caller names; the refund returns tokens there | the token in base units |
| Solana | **fixed by the signing key** — `vaultPda(client)` derives the vault from it and the program checks it as the authority | **lamports**, not a token |

The route built one `EscrowTerms` for both, reading `client` from `requested.contractAddress`.
On Solana that compares a base58 authority against an EVM-shaped address and reports
`ESCROW_PROVIDER_DIFFERS` on every probe — so the Solana rail would have appeared to work and
never once matched its own chain.

Three changes:

- `SolanaEscrowRail.authority` exposes the client the rail will actually sign as, and the
  route reads it. It cannot be a request field: the vault PDA is *derived* from that key, so
  a caller-chosen value would address a vault the signer does not control.
- Amounts are converted per rail.
- **Lamports are not guessed.** `lamportsFor` accepts only a price of exactly 1 and refuses
  otherwise with `SOLANA_ESCROW_AMOUNT_UNSUPPORTED`. A devnet placeholder that silently
  differs from mainnet by nine orders of magnitude is precisely the kind of value that looks
  fine in testing and is catastrophic live, so "1 USDC == 1 lamport" is stated as a refusal
  rather than adopted as a conversion.

This is F81's sibling: two rails, one name, two meanings. F81 was the same collision in a
hash; this is it in a struct.

## F86 — a Solana signature is not evidence that the escrow exists

**Status:** fixed (2026-10-08) in `SolanaEscrowRailImpl`.
**Found:** 2026-10-08, by reasoning about the transport rather than by a failure — and the
reasoning is F82's again.

`sendRawTransaction` returns a signature whether or not the transaction took effect. A rail
that reports that as `locked` produces exactly the failure LP-6 exists to prevent: the
database records capital escrowed, and nothing is. So `send` **waits for confirmation and
then re-reads the resulting account**, and treats three observations as failures:

- the signature never confirms → `NOT CONFIRMED`
- confirmed, but no escrow account exists → `CONFIRMED BUT NO ESCROW EXISTS`
- confirmed, but the account carries no §15.5 commitment → `CONFIRMED WITHOUT A §15.5 COMMITMENT`

The third is worth separating. The program permits a zero hash in an account created some
other way, and such an escrow **can never be refunded**. Detecting it at lock time, while the
route hash was still in hand, is the difference between a loud failure and a job whose
recovery route silently does not exist.

Also removed while writing it: `getLatestBlockhash` was being called **twice** in `send`, so
the blockhash on the transaction was not the one paired with `lastValidBlockHeight` for its
confirmation. That is an intermittent "block height exceeded" on a valid transaction — a bug
that would have been attributed to the network.

**Evidence.** 6 hermetic tests against an injected `Connection` (a seam, not a
monkey-patched private field): confirmation awaited after send; unconfirmed refused; confirmed
-but-absent refused; confirmed-without-commitment refused; the release path reads the provider
**off the account** and refuses with no escrow at all; the refund needs no vault authority.

**Live.** `jW14aBAbYPZDWPqRG99CHfqRwXfdvyaeAxgnrXMD1Kw1Kf5V9zfLY2wNC1WxbfCqBfkqKhNni3rzcG75gMaHZWZ`
on devnet: probed `ABSENT` → `lock_escrow` → probed `FUNDED` → the account's
`refundRouteHash` equals the kernel's derivation → the replay returned `skipped:
ALREADY_FUNDED` with **no** `txHash`. LP-4 had proved the instruction in isolation via
`scripts/escrow-devnet.mjs`; this proves the rail the **route** uses speaks the same protocol.

**One test bug worth recording**, because it looked like a product failure: the first live run
reported `MISMATCH` on a correctly-funded escrow. The probe's timeout was computed a second
time and had moved by the wall-clock second between the lock and the probe. The guard was
right; the test was wrong. A term comparison is only as good as the terms, and a timeout
recomputed mid-test is two different terms.

## F87 — the LP-7 fee ceiling was 100× too small

**Status:** fixed 2026-10-08, before commit.
**Found:** 2026-10-08, LP-7, by the boundary test at the cap.

`maxFeeFor` computed the proportional 1% as

```ts
(BigInt(Math.round(amount.amount * 1_000_000)) * MAX_FEE_BPS) / (BPS * 100n)   // ← extra /100n
```

which yields **1/100th** of the intended ceiling: `$10` payout → allowed fee `$0.001`
instead of `$0.10`. It failed **closed** — every real quote was refused — which is why the
tests that mattered were the *boundary* ones ("accepts a quote exactly at the ceiling") and
not the refusal ones, which all passed regardless of what the limit was.

The arithmetic is now in micro-units throughout with a single division by `BPS`. **Recorded
because the failure mode is worth naming: a fee ceiling that is too small looks exactly like
a working one.** Every "REFUSES a quote above the ceiling" test passed. Only the test that
asked what the ceiling *was* caught it. A limit needs an assertion on its own value, not only
on the refusals it produces.

Two fixture consequences worth recording, because both would have hidden the bug rather than
revealing it:

- The default test quote was `USDC(0.5)` on a `$10` payout — which is 500% of the *correct*
  ceiling and only passed while the ceiling was 100× too small. A fixture can quietly depend
  on a bug.
- `maxFeeFor(USDC(3))` was asserted as `$0.03`, i.e. "min(1%, $2) does not eat a small
  payout". Under the broken formula it was `$0.0003`, and the assertion failed for a reason
  that had nothing to do with the property being tested.

## F88 — two guards in the cross-chain settlement path, only one of which was load-bearing

**Status:** fixed (2026-10-08).
**Found:** 2026-10-08, LP-7, by mutation audit.

The recipient checksum was validated **twice** in `settleCrossChainAgreement`: once after the
store reads, once before the quote. Deleting the first changed nothing, because the second
caught it — so the mutation survived, and surviving is the signal. Two identical checks read
as defence in depth and are in fact one check with a maintenance cost: the next edit that
moves or removes "the redundant one" removes the guard entirely.

Reduced to a single check, placed **before any store read**, which is both the cheapest
ordering and the one that survives mutation. Re-audited: deleting it now fails 3 tests.

The same audit found a genuine gap next to it: **no end-to-end test for insufficient
headroom**. The policy arithmetic was tested, the settlement path was not — so replacing
`remainingHeadroom` with `Number.MAX_SAFE_INTEGER` in the settlement path was invisible,
because the fixture's vault had 100 against a 10.05 debit and the guard passed either way.
Added, and the mutation now fails 3 tests.

The general lesson, which is F78's again in a different costume: **a guard is only verified
by the path that reaches it.** Both survivors were guards that existed, were correct, and
were never consulted by the test suite.

## F89 — a live relayer that can quote but cannot broadcast

**Status:** avoided by construction (2026-10-08).
**Found:** 2026-10-08, LP-7, while writing the route dispatch.

The first version of the route's relayer selection was: live if `LIFI_API_KEY` is set,
otherwise simulate. That produced a configuration in which the canonical leg settles, the
quote passes the fee and slippage guards, and then the bridge throws — **on every attempt**,
because nothing was ever going to broadcast.

The ordering makes that failure *recoverable* rather than fatal (funds sit in the relayer's
account on a chain Mitra operates, reconcilable the way LP-6 reconciles escrows), which is
the right property. But "recoverable, every time" is not the same as working, and a
configuration that silently converts into that on the strength of one env var is a trap.

Now the live path requires a key **and** a broadcaster **and** a relayer address. Absent any
of them, the process uses the simulator, which announces itself on every result. There is
deliberately no third option: never falling back to the canonical path, because paying a BNB
Chain address from a Base vault is a transfer to an address on the wrong chain, not a
settlement.

## F90 — a session-key delegation that is only *read* makes the scope mechanism theatre

**Status:** fixed 2026-10-08, before commit.
**Found:** 2026-10-08, LP-8, while writing the scope check.

The obvious way to build a delegated session key is to carry a `delegation` object and check
its `allowedActions` before each call. That reads like authorisation and is none: a
delegation is just data, so **anyone can mint one** with `allowedActions: ["settle"]` and a
generous `maxSpendUsd`, and every check downstream passes. The scope machinery would be a
speed bump in front of an attacker who simply writes their own permit.

The fix is to make the delegation a **signature over the exact tuple that is enforced**:

```
sessionAddress · ruleDigest · allowedActions (order-insensitive, hashed) · maxSpendUsd · expiresAt
```

EIP-712, verified by recovery **before use**. Two properties follow that a data-only
delegation does not have:

- no field can be edited after signing — each mutation either changes the recovered signer or
  makes recovery fail;
- the actions are hashed **sorted**, so a reorder cannot change meaning while keeping the
  same string.

This is the same lesson as F51 (caller-chosen payee) and F55 (a signature must prove *who*,
not just *that*): an authorisation that is not cryptographically bound to the authority is a
preference.

**Evidence.** `tests/virtuals-transport.test.ts`: recovery matches the signer; five
post-signature mutations each break verification; a self-declared delegator with someone
else's signature is refused `SESSION_KEY_DELEGATOR_MISMATCH`; an unparseable signature is
refused `SESSION_KEY_DELEGATION_UNVERIFIABLE` rather than skipped. **Mutation:** replacing
recovery with `d.delegator` — trusting the field — fails 4 tests.

## F91 — the allowlist must be an enum, not only a delegation's contents

**Status:** fixed 2026-10-08, before commit.
**Found:** 2026-10-08, LP-8, by mutation audit.

The first scope check asked only "is this action in `delegation.allowedActions`?" — which is
the delegation's own list consulted by the code it authorises. A delegator (compromised, buggy,
or simply wrong) could therefore widen the executable surface to include `settle` or
`claim_dispute`, and every check would pass.

Now the action is checked against `ACP_PERMITTED_ACTIONS` **first**, as an enum, and only then
against the delegation. Both halves are load-bearing and they refuse for different reasons,
so both are tested:

- a **genuine** delegation, signed by the agent's own wallet, listing `settle` → refused
  `SESSION_KEY_ACTION_NOT_PERMITTED`. Only the code can widen the surface, never a delegator.
- a **forged** delegation edited to list `settle` → refused earlier at
  `SESSION_KEY_DELEGATOR_MISMATCH`, because it is not a delegation at all.

**The control is also the ABSENCE of verbs.** `ACP_PERMITTED_ACTIONS` is five actions and
none of them moves capital: `openJob` proposes a spend against a cap, it does not disburse,
and settlement stays on a canonical rail through the machinery that already governs it. A test
asserts no permitted action matches `/spend|settle|dispute|claim|withdraw|transfer/`.

**Mutation:** removing the enum check and consulting only the delegation fails **9** tests —
the largest kill in this package, which is what a load-bearing guard looks like.

## F92 — scope checked once at construction is scope checked until the process dies

**Status:** fixed 2026-10-08, before commit.
**Found:** 2026-10-08, LP-8, by mutation audit.

The failure mode session keys exist to prevent is a long-lived process holding a scope that
was valid when it started. A transport that called `assertSessionScope` once in its
constructor would keep signing **for its entire lifetime** after the delegation expired — which
is precisely the window an attacker wants.

`assertSessionScope` therefore takes a clock and is called immediately before **every**
signature, in both transports and the simulator. The test proves the live case by advancing an
injected clock past `expiresAt` on a running transport and asserting the next call refuses.

**Mutation:** freezing the clock to wall-time at construction fails 1 test. Only 1, because
the test is the only thing that distinguishes "checks on every call" from "checks once" — a
gap worth naming, since the guard is load-bearing and thin.

## F93 — a test helper that signed first and mutated second tested nothing

**Status:** fixed 2026-10-08, before commit.
**Found:** 2026-10-08, LP-8, while writing the scope tests.

The first `delegation(over)` helper called `signSessionDelegation({...defaults})` and then
spread `over` onto the result — so `delegation({ maxSpendUsd: 0.3 })` produced a delegation
whose signature covered `25` while the object said `0.3`. Every such test then failed at
`SESSION_KEY_DELEGATOR_MISMATCH`, which is correct behaviour and has nothing to do with the
rule being exercised.

Four tests failed for reasons unrelated to their subject, and the tempting response — to
assert the mismatch instead — would have left the spend ceiling, the rule-digest binding and
the expiry boundary entirely untested while the suite was green.

The helper now signs **over** every field it is given. Worth recording because the failure is
invisible: a fixture that quietly invalidates its own signature converts every downstream
assertion into a test of the signature check, and the suite still reports failures rather than
passing. Green suites hide this; loud failures merely misattribute it.

The same class as F87's fixture, which depended on a 100×-wrong fee ceiling: **a fixture can
depend on a bug and keep asserting the right words.**

## F94 — a submitted deliverable is neither checked nor kept

**Status:** open (found 2026-10-09). Canary test in place; not fixed. Owner: lead (`lib/kernel/`, `lib/store/`, the agreements route).
**Found:** 2026-10-09, by PurpleDNA's agent while writing the PP-8 evaluator skill, asking where an evaluator reads what it is meant to judge.

`POST /api/v1/agreements` with `op: "submitDeliverable"` accepts `artifactRefs` and
`contentHash`, the provider signs over both (`bodyHash`), and the route passes them
to `applyAgreementOpWithSaga` (`app/api/v1/agreements/route.ts:331-332`).
`applyAgreementOp` takes them in its `opts` type (`lib/kernel/commerce.ts:164`) and
never reads them. Nothing persists them: not the agreement, not the deliverables
table (the repository has `listDeliverables` and no write), not the saga, not the
event log. No read returns them.

The checks that should run on submit exist and are unreachable.
`evaluateDeliverable` (`lib/kernel/commerce.ts:277`) refuses `WRONG_AGREEMENT`,
`DELIVERABLE_EMPTY`, `DELIVERABLE_LATE` and `DELIVERABLE_HAS_NO_ARTIFACTS`, and has
no production caller. So through the API:

- a submission six years past its deadline, with no hash and no artifacts, moves the
  agreement to SUBMITTED, and the evaluator can then accept it to ACCEPTED;
- an evaluator has no record in Mitra of what was submitted, so its verdict is tied
  to nothing the provider signed. A provider can show the evaluator one artifact and
  have signed another, and nothing can tell.

**Why it matters for value.** ACCEPTED releases escrow toward settlement. Acceptance
is meant to be the evidence that the work met its terms (PRD §13/§14; the lead's
seq 54 answer: deliverables "must be explicitly SUBMITTED first with contentHash and
artifactRefs, verified against acceptance criteria"). Today that evidence is
discarded at the moment it is offered.

**Also corrected by this finding.** The PP-7 question (`ctx_d3eaff6172c8b596`) and the
PP-6 inbox comment said `commerce.ts:284` refuses late submission. It does not run.

**Candidate fix (for the lead).** On submit, build a `Deliverable` from the parsed
body, run `evaluateDeliverable` and refuse on failure, persist it (a repository
write, in-memory and Postgres), and record its id on the agreement. Then have
`acceptDeliverable` and `rejectDeliverable` carry the `contentHash` they judged, so
the evaluator's signature names the exact deliverable.

**Evidence.** `tests/deliverable-binding-probe.test.ts`: three `it.fails` assert the
invariants (late refused, empty refused, the signed hash readable afterwards) and
pass today because the invariants do not hold; vitest flags them the moment they
do. A plain `it` pins the reachable path: late and empty → SUBMITTED → ACCEPTED.

## F95 — `depositToEscrow` records any balance the contract holds, so a job can be funded with another job's tokens

**Status:** open (found 2026-10-09). Canary test in place; not fixed. Owner: lead (`contracts/src/ERC8183/MitraJobEscrow.sol`, and the fund path in `app/api/v1/agreements/route.ts`).
**Found:** 2026-10-09, by PurpleDNA's agent building the PP-7 sandbox, the first thing to drive the fund route against a deployed escrow more than once.

`depositToEscrow` measures `balanceOf(address(this))`, the contract's **total**
balance, and records `min(balance, expected)` as the job's amount. Nothing records how
much of that balance earlier jobs already own. `tests/commerce-escrow-live.test.ts`
notes this as a limitation of two jobs funded concurrently. It is not only concurrent:
once one job is funded and unsettled, every later `depositToEscrow` passes with **no new
tokens at all**.

The route makes it reachable on every fund. `POST /api/v1/agreements` with `op: "fund"`
and `onChainEscrow` calls `depositToEscrow` and moves no tokens itself, so a job is
backed by whatever the contract already holds.

**Impact.** The contract can owe more than it holds. On anvil: agreement C is funded with
30 tokens sent to the escrow; agreement D is funded with none. Both read `Funded` with
amount 30, and the escrow holds 30. Whichever settles first takes the other's tokens; the
second `completeJob`/`refundJob` then reverts or drains a third job.

**Candidate fix (for the lead).** Either pull per job (`transferFrom(clientVault, this,
expected)` inside `depositToEscrow`), or keep a `totalAllocated` sum and record
`balance - totalAllocated`, reverting when it is below `expected`. The route should not
rely on a separate transfer it does not make.

**Evidence.** `tests/sandbox.test.ts`: `it.fails("F95: a second escrow cannot be funded
by the first escrow's tokens")` and the plain `it("F95 today: …")`, both on anvil against
the compiled contract.

## F96 — the agreements route passes an agent id as the escrow's on-chain evaluator address

**Status:** open (found 2026-10-09). Canary test in place; not fixed. Owner: lead (`app/api/v1/agreements/route.ts`, `runEscrowStep`).
**Found:** 2026-10-09, PP-7 sandbox, first route-driven `fund` with an on-chain escrow on a real contract.

`runEscrowStep` builds the EVM lock with
`evaluator: (agreement.evaluator ?? agreement.provider) as \`0x${string}\``.
`agreement.evaluator` is a Mitra agent id (`agent_eval_02`), not an address. viem
refuses to encode it, so `fund` answers `409 BROADCAST_FAILED` (`Address "…" is
invalid`) for every agreement whose evaluator is not literally an address. The hermetic
suite never saw it because its fake rail ignores the field, and the live suites call
`executeEscrowLock` directly with `evaluator: account`.

The same mistake was fixed for the provider in LP-6 (the provider address comes from
`payTo`). The evaluator has no such term.

**Why the choice matters.** `completeJob` and `refundJob` require `msg.sender` to be the
escrow's client vault or its evaluator, and the route calls them with the relayer key. So
release and refund through Mitra work only if the relayer is one of those two addresses.
The on-chain evaluator is therefore really "the key Mitra acts with". Whether it should be
the relayer, or the evaluator agent's registered wallet with the evaluator signing on
chain, is a design call for the lead.

**Sandbox workaround.** The sandbox names its evaluator agent by the relayer's address.

**Evidence.** `tests/sandbox.test.ts`: `it.fails("F96: an agreement whose evaluator is an
agent id can be escrowed on chain")`; run as a plain `it` it fails with
`409 BROADCAST_FAILED: Address "sandbox_provider" is invalid`.

## F97 — Mitra's agreement and its on-chain escrow can disagree about whether it was refunded

**Status:** open (found 2026-10-09). Canary tests in place; not fixed. Owner: lead (`app/api/v1/agreements/route.ts`, recovery).
**Found:** 2026-10-09, PP-7 sandbox, by advancing anvil's clock past an escrow timeout.

Two halves, the same split:

1. **Nothing observes an escrow timeout.** After `refundJob` succeeds on chain (anyone may
   call it once `block.timestamp >= timeout`), Mitra's agreement stays EXECUTING. It
   becomes REFUNDED only when the client or evaluator sends the signed `refund` op. There
   is no keeper. PRD §28.5 names a Recovery Agent / Keeper; none exists.
2. **The `refund` op never touches the chain.** `ESCROW_ACTION_FOR_OP` maps `fund`,
   `acceptDeliverable` and `rejectDeliverable` to chain actions and omits `refund`. On an
   escrowed agreement, `refund` records REFUNDED, sets `escrowReleased`, and returns the
   price to the Space's headroom, while the escrow on chain is still `Funded`. On anvil:
   Mitra REFUNDED, headroom back to 100,000, escrow status 1 with 20 tokens locked.

**Impact.** Mitra's books say capital is free that the chain still holds. Until the
timeout, the relayer key can still call `completeJob` and pay the provider on an
agreement Mitra reports refunded.

**Candidate fix (for the lead).** Map `refund` to the chain refund in `runEscrowStep`.
For timeouts, add a keeper that reads `jobs(jobId)` for escrowed agreements past their
timeout, calls `refundJob`, and moves the agreement through the same path. Record the
keeper as an actor so the transition is attributable.

**Evidence.** `tests/sandbox.test.ts`: `it.fails("F97: a refund op on an escrowed agreement
refunds the escrow, so Mitra and the chain agree")` and `it.fails("F97: Mitra notices an
escrow's timeout refund without a party telling it")`, on anvil.

## F94 — `evaluateDeliverable` was called from tests and nowhere else

**Status:** fixed 2026-10-07 in `75e4864`. Canaries flipped in `tests/deliverable-binding-probe.test.ts`.
**Found:** 2026-10-07, PP sandbox probe.

`evaluateDeliverable` has carried four guards since before the submit path existed: the right
agreement, a non-empty `contentHash`, inside the deadline, at least one `artifactRef`. **No
production code called it.** A submission therefore reached `SUBMITTED` with no evidence, or
made long after the deadline, and could then be `ACCEPTED` — so "accept" accepted an
assertion about work nobody could inspect, and `listDeliverables` had no writer at all.

Three changes:

1. **`applyAgreementOpWithSaga` evaluates on `submitDeliverable`**, before the transition is
   allowed to succeed, and returns the `Deliverable` in its result. In the kernel rather than
   the route, because it is a predicate about the work and it must be reachable by every
   caller.
2. **`now` is an input.** `evaluateDeliverable` takes a clock, and a kernel that read
   `Date.now()` would decide "late" by means nobody could test. The route supplies one, taken
   next to the store open so the deadline check and the event log share an instant — two
   clocks would make lateness depend on which ran.
3. **`saveDeliverable` exists.** `listDeliverables` had a reader and no writer, so the table
   could only ever be empty outside a fixture. Optional on the interface, and
   `commitAgreementOp` **refuses** a store that cannot write one rather than accepting a
   submission it would drop.

The deliverable id is derived from the binding fields, so a retry converges on one row rather
than accumulating duplicates, and a provider cannot name another agreement's submission.

**A positive test was added.** All three canaries are refusals, so a submit path that
refused *everything* would satisfy them. `a valid submission is accepted and kept` pins the
other direction.

**Fixtures again.** Eight `commerce-saga` tests submitted with no `contentHash` and passed
only because no guard existed — the same shape as F77's fixtures (which passed because the
agreement write did not happen yet) and F87's (which depended on a 100×-wrong ceiling).
**Three defects in one session, all the same shape: a fixture relying on a control not yet
existing.** That is now a pattern worth naming rather than fixing three times.

## F95 — `depositToEscrow` measured a deposit against the contract's whole balance

**Status:** fixed 2026-10-07 in `75e4864`. `test/MitraJobEscrow.t.sol` 7 → 13 tests, mutation 4/4.
**Found:** 2026-10-07, PP sandbox probe.

The delta was computed as:

```solidity
uint256 before = IERC20(token).balanceOf(address(this));
received = IERC20(token).balanceOf(address(this)) - before;   // always 0 — `before` read twice
received = expected;                                          // overwritten
uint256 bal = IERC20(token).balanceOf(address(this));
if (bal == 0) revert NothingReceived();
received = bal > expected ? expected : bal;                   // ← the WHOLE balance
```

`bal` includes every other live job. So a second job could be funded with **zero tokens
arriving**: it read the first job's tokens as its own, and the contract over-promised by that
amount. The shortfall surfaced on the first payout — by which point it was unrecoverable and
attributable to neither job. `before` was dead code and the second `received` assignment was
dead.

`totalAllocated[token]` now tracks commitments, and the delta is measured against that. Three
consequences that are easy to get wrong and are each tested:

- **Settlement frees the commitment** (`completeJob` and `refundJob` both decrement). Without
  it `totalAllocated` only grows and a long-lived escrow refuses every future deposit.
- **An over-send stays unallocated.** A deposit is credited `received` (capped at `expected`),
  never the delta, so surplus remains headroom for a later job instead of being swallowed.
- **`test_obligations_never_exceed_the_balance`** states the invariant directly, so the suite
  fails if any future change to this accounting breaks it rather than if one particular
  sequence does.

## F96 — a Mitra agent id was cast to an EVM address for the escrow's evaluator

**Status:** fixed 2026-10-07 in `75e4864`. Canary flipped in `tests/sandbox.test.ts:149`.
**Found:** 2026-10-07, PP sandbox probe.

`evaluator: (agreement.evaluator ?? agreement.provider) as \`0x${string}\``. Both are Mitra
**agent ids** (`sandbox_provider`, `agent_eval_02`), and the contract treats `evaluator` as an
**authority** — it is one of the two callers permitted to `refundJob` for a failed verdict. So
this was not a type error that happened to be inconvenient: it was a caller-chosen authority,
F51's defect on a new surface. viem failed inside the ABI encode, surfacing as
`BROADCAST_FAILED` with no indication that the evaluator had never been an address.

`escrowEvmTerms` now resolves it explicitly: use the agreement's evaluator **only if
`isAddress`**, else the relayer's own address (`ERC8183Transport.evaluatorFallback`, present
whenever a signing key is), else **refuse**. A placeholder address would have silently
conferred refund authority on nobody while the escrow still funded.

`token` got the same treatment: it defaulted to the **zero address**, which is an escrow
holding nothing at an address that exists. Now `ESCROW_TOKEN_NOT_CONFIGURED`. Both existing
LP-6 route tests had been passing *because of* the zero-address default.

## F97 — the escrow's chain, contract and timeout were not on the agreement, so nothing could notice a keeper's refund

**Status:** fixed 2026-10-07 in `75e4864`. Both canaries flipped in `tests/sandbox.test.ts`.
**Found:** 2026-10-07, PP sandbox probe.

Three separate defects, all invisible from the agreement alone:

1. **`refund` was missing from `ESCROW_ACTION_FOR_OP`.** A client changing their mind left the
   chain holding capital while Mitra recorded `REFUNDED`.
2. **Nothing observed a third-party refund.** On Solana a keeper — nobody in particular — may
   refund a timed-out escrow. No party is told, so no message, so the agreement kept saying
   `FUNDED` over capital already returned. It would still count as outstanding, could be
   `acceptDeliverable`d into a release against an escrow that no longer exists, and its §15.5
   route stayed "committed" to a refund that had already happened.
3. **The agreement could not say WHERE its escrow was.** `escrowRef` held only the job id;
   `onChainEscrow` arrived as a request field and nothing persisted it. So reconciliation had
   no chain to probe — which is *why* nothing noticed. `escrowChain`, `escrowContract` and
   `escrowTimeout` are now set at `fund`.

The third is the load-bearing one, and the fourth defect was downstream of it: every later op
**re-derived** the timeout from `agreement.deadline`, which is not the escrow's timeout. The
first attempt failed with `ESCROW_TIMEOUT_DIFFERS` — refusing the refund that was supposed to
release the capital — because a request may set `onChainEscrow.timeout` to anything and the
chain clock is not wall time. Persisting the terms the escrow was **opened with** is what
makes the comparison meaningful.

Reconciliation runs on the agreement read path, which is a read that writes, and that is
deliberate and bounded: only agreements that HAVE an escrow, only when the probe reports a
terminal divergence, only in the **refunded** direction. A chain-completed escrow is
deliberately *not* advanced to `ACCEPTED`, because acceptance has to drive the settlement saga
— seeing `COMPLETED` here means that op ran and only its database half failed. And a chain
that cannot be reached degrades to the status we already had rather than failing the request.

`runEscrowStep` also falls back to the agreement's recorded escrow when the request does not
restate one, because `recovery.refundEscrow` sends `{ op: "refund", agreementId }` and nothing
else. A restated ref is still checked against the agreement's, so restating cannot redirect.

## F98 — a stale duplicate build directory shadowed a rebuilt contract

**Status:** fixed 2026-10-07 in `75e4864`.
**Found:** 2026-10-07, while trying to verify F95 and finding it "not fixed".

`lib/sandbox/chain.ts` deployed from `contracts/out/…`, but `foundry.toml` sets `out = "out"`
and nothing had written `contracts/out` for some time. The F95 contract fix compiled cleanly,
`forge test` passed 13/13, the sandbox artifact check found the files **present**, and the
sandbox went on deploying the previous bytecode. The canary kept failing and the obvious
conclusion — "my fix is wrong" — was wrong.

Two causes, both about **presence being mistaken for currency**:

- the sandbox read a directory nothing writes;
- `ensureArtifacts` built only when an artifact was **absent**, never when one was **stale**.

Now it reads `out/` and compares artifact mtimes against every `.sol` under `contracts/src` and
`contracts/test`, rebuilding when any source is newer. A test can only exist or not; a build
artefact can be present and wrong, and only mtime distinguishes the two.

Recorded because the symptom was a **silently ineffective fix**: everything green, nothing
wrong, and the one thing that would have caught it — checking the deployed bytecode — is the
step a test suite cannot take.

---

## Closure evidence for F94–F98 (`75e4864`, re-verified 2026-10-09)

| Gate | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `forge test` | **63/63** (was 57 — six Solidity tests added for F95) |
| `cargo test --manifest-path programs/mitra-vault/Cargo.toml` | 147/147 |
| `npx vitest run` | 1329 passed, 83 skipped |
| `npm run test:postgres` | 1377 passed, 35 skipped (PostgreSQL 16) |
| `npm run sandbox` | end-to-end on anvil against the real `MitraJobEscrow` |

All six canaries flipped from `it.fails` to `it`. The two tests that documented the
fixed-away behaviour — "F95 today" and "today: a late, empty submission is SUBMITTED" — were
**removed** rather than inverted: asserting a defect that no longer exists is a test that
will fail for the wrong reason the next time something adjacent changes.

## F99 — the sandbox seeded the root of the authority tree with nothing

**Status:** fixed 2026-10-09.
**Found:** 2026-10-09, Horizon 1 polish, Task 3.

The sandbox seeded 100,000 USDC and **zero** Mandates, so every flow it exercised skipped
`Mandate → Authorization → Intent → Agreement` and went straight to the agreement. Nothing in
the sandbox ever had to prove a spend was AUTHORISED — the root of the tree was assumed.

Two gaps, and the second is the same shape as F94's:

1. `listMandates` existed with **no writer**, so a Mandate could only ever be a seeded
   fixture. `saveMandate` is now on the repository (optional, Postgres + in-memory) with the
   upsert guarded on `mandate_id`.
2. The in-memory `getMandate` read the **seed array only**, so `saveMandate` would have
   written to a map nothing read and `getMandate` would have returned the fixture instead. A
   write that is accepted and then invisible — worse than having no writer, because it looks
   like it worked. `getMandate` now prefers written mandates, and `listMandates` includes them.

`seedMandates()` in the sandbox reads back after writing and throws if the Mandate did not
persist, so a store that silently drops the write fails at the seed rather than much later.

**Deliberately not done.** There is no `mandates` HTTP route and no `mitra.mandates` SDK
namespace, so "a client can query its mandate" is not reachable today. The tests read through
the store and say so; adding a public surface to a polish packet would be scope creep, and the
PP-5 row already records `getMandate` as withheld for want of a route.

## F100 — anyone who can reach `POST /api/v1/mandates` can mint authority

**Status:** PARTIALLY fixed (2026-10-09). Narrowed and recorded; the authentication gap is
open and is the larger half.
**Found:** 2026-10-09, while implementing the Mandates public API (Horizon 1 packet 2).

The handoff prescribed an unauthenticated `POST /api/v1/mandates`. It is worth being precise
about what that endpoint does, because it is not the same kind of write as the rest of the
operator plane:

- `POST /api/v1/authorizations` is unauthenticated too, and is **bounded** — an
  Authorization only permits an action *inside a Mandate that already exists*, so the worst an
  attacker gets is one authorised action inside limits somebody else set.
- `POST /api/v1/intents` is unauthenticated, and an Intent is a statement (F65's residual).
- **A Mandate is the ROOT.** `Mandate → Authorization → Intent → Agreement`. Creating one is
  not granting something within a limit; it is **minting the limit**. So an unauthenticated
  `POST` lets any caller grant any agent any budget over any vault, including vaults
  belonging to other principals.

That is qualitatively worse than the operator-plane posture the rest of the repository takes,
and it is why this is recorded as a defect rather than shipped as an implementation detail.

## What was done about it

**Narrowed as far as possible without breaking the packet's showcase:**

- `VAULT_NOT_FOUND` — authority cannot be minted over a vault that does not exist.
- `AGENT_NOT_REGISTERED` — authority cannot be granted to an identity the repository has
  never seen.
- `VAULT_CHAIN_NOT_APPROVED` — a mandate that does not approve the chain of its own vault can
  never authorise anything, the same reasoning as `MAX_TRANSACTION_EXCEEDS_BUDGET`.
- **First-write-wins**, `409 MANDATE_EXISTS` — a ceiling cannot be silently raised. Pinned by
  a test that raises the budget and asserts the ORIGINAL survives.
- **`AUTHORITY` is a new pause scope.** Minting authority is pausable, unlike granting an
  Authorization, for the same asymmetry. Pinned by a test that pauses and asserts both the
  503 and that **nothing was written** — a pause that stopped the request after the write
  would be worse than no pause.
- **An `AUTHORITY` event on the run log**, so a ceiling has an audit trail recording who was
  granted what, and over which vault.

**And the deviation.** The handoff also asked for `client.mandates.create`. It is
**deliberately absent** from the SDK. `MitraClient` is the surface an external agent holds,
and `tests/sdk.test.ts` pins it as "carries intent verbs only" with no capital-issuing verb in
any namespace. Putting `create` there would hand the act of minting the limit to the agent —
F100 exactly — and would make the existing control wrong rather than the change right. The SDK
gets `get` and `list`; granting authority stays on the HTTP operator plane. Recorded as a
deviation rather than done quietly.

**What remains.** A caller who knows a real `vaultId` and a real `agentId` can grant that
agent a budget over that vault. Closing it needs a signature from the principal, exactly as
F55 gave the agreement transitions one, and that is a larger change than this packet. Until
then this route should not be exposed beyond the operator plane.

## F101 — `saveMandate` wrote two things the `mandates` table does not have

**Status:** fixed 2026-10-09.
**Found:** 2026-10-09, by `npm run test:postgres` immediately after adding the writer.

**F79, again, in a new repository method.** The first `saveMandate` copied `saveDeliverable`'s
shape and wrote a `document` column. `mitra.mandates` has no such column — unlike
`mitra.deliverables`, which does — so the statement failed outright. The in-memory backend
accepted it happily, because it stores objects and cannot have a column error, and all 19
`tests/mandates-api.test.ts` cases passed.

Fixing it surfaced the same bug a second time in the same function: the capability and chain
columns are Postgres `TEXT[]`, and I was passing `JSON.stringify(...)`, which supplies the
*string* `"[]"` and fails with `malformed array literal`.

**Two schema/encoder mismatches in one new method, and the entire in-memory suite green
through both.** That is the strongest evidence yet for why the Postgres matrix is part of the
verification protocol and not an optional extra: the cheap backend cannot have this class of
defect, so a suite that runs only against it is not testing the thing that will run in
production. Both were caught within a minute of running the matrix, and neither was caught by
writing more in-memory tests.
