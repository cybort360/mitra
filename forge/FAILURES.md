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

## Open risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| No on-chain enforcement | Capital is a database row, not an enforced account | Stated `PARTIAL` in `INVARIANTS.md`; not counted as PRD Phase 2 progress. **Still open** — this is PRD Phase 2 work. |
| No withdrawal path exists | `FR-VAULT-006` holds by absence, not enforcement | Recorded `UNTESTED`, not `VERIFIED`. **Still open.** |
| Six of seven state machines unwritten | Definitions exist but nothing writes through them | Stated in `INVARIANTS.md` and `EXECUTION_PLAN.md`. **Still open** — only `reservation` has a write path. |
| ~~No on-chain program~~ | ~~Capital is a database row, not an enforced account~~ | **CLOSED.** `mitra-vault` is live on devnet and all six PRD §52 clauses are verified. The remaining gap is that the *kernel* still holds capital locally in Postgres — the program proves the boundary, it does not yet hold production capital. See the phase audit |
| Devnet airdrop reports errors while succeeding | `solana airdrop` printed rate-limit failures and still credited 5 SOL | Never treat CLI output as the claim. `phase2-readiness.mjs` reads `getBalance` from the node, so a false "failed" cannot be mistaken for unfunded, or a false success for funded. |
| ~~Ledger is process-local on the kernel path~~ **RESOLVED** | Routes now go through `getStore()`; `InMemoryRepository` / `PostgresRepository` behind one interface | `tests/persistence.test.ts` — "routes served by postgres", incl. nonce surviving a simulated restart |
