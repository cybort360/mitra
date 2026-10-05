# PROOF LEDGER

Every claim in this repository that matters, and the command that proves it. A
claim with no executed evidence is `UNTESTED`, regardless of how plausible it
sounds.

## Evidence levels

Every claim below carries exactly one. The set is deliberately small, and
`PARTIAL` is never rounded up to `VERIFIED` — see [ADR-0005](../docs/adr/0005-evidence-levels-untested-through-verified.md).

| Status | Means | Set when |
|---|---|---|
| `UNTESTED` | Asserted, with no executed evidence | A claim has no command yet. The default. |
| `PARTIAL` | Some of it demonstrated, and the gap is named | A command ran but covers less than the claim — typically because it needs credentials or a live network. |
| `FAILED` | Executed, and it did not hold | The command was run and disproved the claim. Recorded rather than deleted. |
| `VERIFIED` | Executed, with the command recorded | The named command passes on the branch where the claim is made. |
| `REGRESSED` | Was `VERIFIED`, no longer holds | A previously passing command now fails. Highest-priority status: the product is worse than when last checked. |

`FAILED` and `REGRESSED` are defined here because the ledger uses them. An
undefined status is a status nobody can act on, and the absence of a definition
is indistinguishable from the absence of the finding.

## What this ledger describes

**The ledger describes the product's target state, and each claim is only true on
a branch where its command actually runs.** Claims are not portable: a row whose
proof is `tests/persistence.test.ts` is `VERIFIED` on a branch containing that
file, and is **not yet applicable** on a branch that does not.

Read each row together with the branch. `forge.json` records the
`evidence.current_level` for the branch you are on.

This is deliberate. A ledger that silently claimed `VERIFIED` for work absent
from the checked-out tree would be exactly the "documented ≠ true" failure the
Foundry exists to prevent — so applicability is stated rather than assumed.

| Branch | `current_level` | Persistence claims |
|---|---|---|
| `main` | `DESIGN_ONLY` | Not applicable — no repository layer yet |
| branches carrying the kernel work | `LOCAL_PASS` | `VERIFIED` |

## How to re-verify

```bash
npm ci
npx tsc --noEmit                                    # T1
npx vitest run                                      # T2
npm run build                                       # T3
DATABASE_URL=... npx vitest run tests/persistence.test.ts   # T4
npx vitest run tests/kernel.test.ts                # T5
```

`T4` is skipped without `DATABASE_URL` and says so on stderr. That is deliberate:
a vacuous pass is worse than an absent one.

## Evidence levels

Per `docs/EVIDENCE.md`. The repository as a whole is `LOCAL_PASS` — the
deterministic local kernel is proven; nothing above it is.

`DESIGN_ONLY · LOCAL_PASS · TESTNET_PASS · LIVE_PUBLIC_PASS · PRODUCTION_PASS`

| Level | Meaning | Reached? |
|---|---|---|
| `DESIGN_ONLY` | Specified, not implemented | ✅ n/a |
| `LOCAL_PASS` | Deterministic local kernel proven by tests | ✅ **current level** |
| `TESTNET_PASS` | Real testnet execution with tx hashes | ❌ no on-chain code exists |
| `LIVE_PUBLIC_PASS` | Mainnet execution | ❌ |
| `PRODUCTION_PASS` | Audited, reconciled, operated | ❌ |

**Mitra has never claimed a level above `LOCAL_PASS`.** That is not modesty; it
is the PRD's `FR-SETTLE-004` and `NFR-005` in force.

---

## T1 — Type safety

```bash
npx tsc --noEmit
```

| Claim | Status | Notes |
|---|---|---|
| The project typechecks in strict mode | `VERIFIED` | Last run 2026-10-01, exit 0 |
| No `any` escapes into the economic kernel | `VERIFIED` | Kernel is pure and explicitly typed |

## T2 — Full suite

```bash
npx vitest run
```

| Claim | Status | Notes |
|---|---|---|
| All tests pass | `VERIFIED` | 81 tests, 5 files |
| Persistence tests actually ran | `CONDITIONAL` | 10 pass with `DATABASE_URL`; otherwise skipped and reported |

## T3 — Build

```bash
npm run build
```

| Claim | Status | Notes |
|---|---|---|
| The app builds for production | `VERIFIED` | 23 static routes + 6 API routes |
| No route imports the seed array directly | `PARTIAL` — was `UNTESTED` | The three economic routes (authorizations, reservations, reservations/execute) now go through `getStore()`. **19 other files still import `@/lib/store/seed` directly**, including `app/api/v1/vaults`, `/runs`, `/obligations`, `/clearing` and every console page. Those are read-only projections, but the claim is not true and is not counted as such. |
| Routes are served by the durable store, not the process-local ledger | `VERIFIED` | `tests/persistence.test.ts` → "routes served by postgres". Asserted against a **separate connection**, so process memory cannot satisfy it. |
| A consumed nonce survives a process restart | `VERIFIED` | Same suite: the replay is refused with `409` after all process state is discarded. This is the claim the process-local ledger could not make. |
| Responses report which store served them | `VERIFIED` | Every route response carries `backend: "postgres" \| "memory"`. A silent fallback would make an in-memory ledger indistinguishable from a durable one. |

## T4 — Persistence and concurrency

```bash
DATABASE_URL=postgresql://... npx vitest run tests/persistence.test.ts
```

Against PostgreSQL 16.15. These are the only tests that require real
infrastructure.

| Claim | Status | Evidence |
|---|---|---|
| Concurrent intents cannot double-spend capital | `VERIFIED` | 10 racers, capital for 3, exactly 3 granted; available/reserved reconcile |
| Capital is conserved under concurrency | `VERIFIED` | `reconcileVault(vault).ok === true` after the race |
| Nonce replay protection survives a restart | `VERIFIED` | A second `PostgresRepository` instance refuses the replay |
| State survives a process restart | `VERIFIED` | New instance reads prior state |
| The concurrency guard is not load-bearing alone | `VERIFIED` | Mutation: removing the conditional `UPDATE` still trips the `CHECK` constraint |
| Reservation amount cannot be negative | `VERIFIED` | `CHECK (amount > 0)` rejects at the storage layer |
| Events replay in order | `VERIFIED` | Appended then read back in `seq` order |
| An agreement is paid at most once under concurrency | `VERIFIED` 2026-10-03 | `tests/settlement-persistence.test.ts`: ten concurrent `claimSettlement` → exactly one wins; two concurrent `settleAgreement` calls, each with its own valid reservation → one `200`, one `409`, one transfer sent. Mutation: dropping `WHERE status = 'FAILED'` from the claim's conflict branch is killed |
| Settlement moves vault capital, once | `VERIFIED` 2026-10-04 | Backlog #2. `tests/settlement-caller.test.ts` "settlement moves the vault's books": reserved → settling → paid out (total falls by exactly the price), an unknown outcome stays in `settling`, two racing confirms + a third apply it once, `reconcileVault` ok at every step; x402 returns the unpaid part of its reservation. Postgres: five concurrent `completeSettlement` → one applies (`tests/settlement-persistence.test.ts`). Mutation 7/7 (incl. the Postgres SETTLING gate). Full suite on Postgres 811 pass |
| Authorizations, agents and clearing epochs are read from the store; only a stored calculation is finalized | `VERIFIED` 2026-10-04 | Backlog #5, `tests/stores-backlog5.test.ts` (7) on both backends: authorizations listed per run with recipient constraint; agents list/get/filter/404; epochs stored, opened once, F58 forgery sealed as the stored calculation, never-opened epoch refused, single-epoch rule enforced. MCP: `mitra_get_agent`, `mitra_find_agents` served; `mitra_register_agent` withheld (F55). Console: agents, agent detail, policies, clearing, overview epoch and the run page's authorization now read the store; only evidence and integrations stay labelled fixtures. Mutation 4/4. Postgres 825 pass, twice |
| Receipt chains do not fork under concurrency | `VERIFIED` 2026-10-03 | `tests/settlement-persistence.test.ts`: ten concurrent `appendReceipt` into one run → ten receipts, `verifyReceiptChain` ok; five concurrent appends of one receipt id → stored once. Mutations removing the per-run advisory lock and the existing-id check are both killed |
| Receipts are signed and the signature is checkable | `TESTED` 2026-10-04 | Backlog #4. EIP-191 over `receiptHash` by `MITRA_RECEIPT_SIGNER_KEY_FILE`; `verifyReceipts` recovers it. Tests: valid signature; edits to payloadHash / result / chainEvidence fail; another key under this name fails; unsigned is reported unsigned; signing leaves the chain hash unchanged; end to end through `/api/v1/settlements` with the env key; Postgres JSONB round-trip still verifies. Mutation 5/5. Suite on Postgres 818 pass. Not `LIVE`: signing is local; the receipts it signs were for live settlements in other rows |
| Agreement writes persist on Postgres | `VERIFIED` 2026-10-03 | F52. Save/read/update round-trip; membership only in `agreement_spaces`; duplicate open refused; update of a missing row throws |
| Full suite on Postgres | `VERIFIED` 2026-10-03 | `DATABASE_URL=… npx vitest run --no-file-parallelism` → after item 2: 49 files, 724 pass, 0 fail, twice in a row on one database (PostgreSQL 16, docker `postgres:16-alpine`); after item 1: 678. At `17b5b4c` the same command gave 4 failures (F52) |

**Known weakness in T4 — recorded deliberately.** The invariant-13 test pins the
connection pool to 1 so racers genuinely contend at the row lock. With a larger
pool, `Promise.all` queues at `connect()` and the test passes *without ever
exercising concurrency*. Anyone refactoring that test must preserve the single
connection, or the assertion becomes theatre.

## T5 — Kernel

```bash
npx vitest run tests/kernel.test.ts
```

| Claim | Status | Evidence |
|---|---|---|
| Expired reservations cannot execute | `VERIFIED` | `*expired reservation*` → `RESERVATION_EXPIRED` |
| Tampered action digests are refused | `VERIFIED` | `*tampered action digest*` |
| Negative amounts are denied | `VERIFIED` | `INVALID_AMOUNT` at both layers |
| Velocity limits are enforced | `VERIFIED` | Single and cumulative cases |
| Replayed nonces are refused | `VERIFIED` | `NONCE_ALREADY_CONSUMED` |
| Net positions sum to zero | `VERIFIED` | `*conserves value*` |
| Netting is order-independent | `VERIFIED` | Reversed input, identical output |
| Disputed obligations are excluded, not silently netted | `VERIFIED` | Reported in `excluded` |
| Reservation state machine blocks illegal transitions | `VERIFIED` | Mutation: bypassing the guard fails 3 tests |
| Saga outcomes are mutually unreachable | `VERIFIED` | `tests/machines.test.ts` |
| Failure is a state transition, not an exception (§4.5) | `VERIFIED` | `tests/commerce-saga.test.ts` (12 tests) → deliverable rejection drives saga through `EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED`, releases `space.committed`, unhandled exceptions = 0 |
| Recovery sagas are queryable via HTTP route | `VERIFIED` | `tests/sagas-api.test.ts` (4 tests) → `GET /api/v1/sagas` returns armed and recovered sagas with route attempts and run filters |

## T7 — Testnet credentials and network reachability

```bash
node scripts/verify-dev-keys.mjs    # re-derives every address from the secret (writes nothing)
node scripts/fund-vibenet.mjs       # claim test ETH; verifies the claim on-chain
node scripts/fund-tempo.mjs         # mint TIP-20 stablecoins; verifies Transfer logs
node scripts/phase2-readiness.mjs   # preconditions as commands
```

| Claim | Status | Evidence |
|---|---|---|
| Solana devnet address derives from the stored ed25519 key | `VERIFIED` | `verify-dev-keys.mjs` re-derives via TweetNaCl and the 64-byte keypair format; exits non-zero on mismatch |
| EVM address derives from the stored secp256k1 key | `VERIFIED` | ECDH + keccak256, checked against the published scalar-1 vector `0x7E5F…5Bdf` |
| Solana devnet RPC reachable | `VERIFIED` | `getHealth` → `ok` |
| Base Sepolia RPC reachable | `VERIFIED` | `eth_blockNumber` → `0x2d5a00f` |
| Base Vibenet reachable **and identified as testnet** | `VERIFIED` | `eth_chainId` → `0x509f455` (84538453). Negative case: pointed at Sepolia it reports `unexpected chainId 0x14a34 (expected 84538453)`. Block time measured at **206 ms/block** over 20 blocks — the documented 200 ms holds |
| Tempo Moderato reachable **and identified as testnet** | `VERIFIED` | `eth_chainId` → `0xa5bf` (42431). Negative case: against mainnet the script reports `chainId 4217 = TEMPO MAINNET — refusing to treat production as a testnet` |
| **EVM key funded on Base Vibenet** | `VERIFIED` | `node scripts/fund-vibenet.mjs` — 0.2 ETH. Faucet returns a tx hash; the script then checks `eth_getTransactionReceipt` status `0x1` and confirms the balance actually rose. Reproducible, not a one-off |
| **Solana devnet funded** | `VERIFIED` | **5 SOL.** `solana -u devnet balance` → `5 SOL`; `getSignaturesForAddress` returns 1 signature with `err=None`. Note the CLI's own airdrop command reported rate-limit errors and *still* succeeded, so the balance was read back rather than trusted from the command output |
| Solana CLI installed | `VERIFIED` | Official Anza installer; `solana-cli 4.3.0 (Agave)`. Independently re-derived our stored keyfile: `solana-keygen pubkey .dev-keys/solana-testnet.json` → `C4ZoTdN…`, matching the recorded address |
| Rust → eBPF program builds | `VERIFIED` | `cargo-build-sbf` compiled a test program to `target/deploy/sbftest.so` (15,464 bytes). `file` reports **ELF 64-bit LSB pie executable, eBPF**; `readelf` confirms `Machine: Linux BPF` with a 0x3778-byte `.text`. A deployable artifact, not a version banner |
| **Mitra Vault Program builds** | `VERIFIED` | `programs/mitra-vault` → `target/deploy/mitra_vault.so`, **37,432 bytes**, ELF64 eBPF, `.text` = 0x8af8 (35,448 bytes of real code), with `vault initialized for` present in the binary. Deployed to a local `solana-test-validator`: program id `JDvCs39vreS1vz61Jo5qthiVeDYgysNGD9nsazRWa7xu` |
| **Anchor parity of the vault program** | `VERIFIED` | 5 tests assert every discriminator against its derivation: `account:Vault` → `[211,8,232,43,2,152,117,119]`, and each `global:*` instruction. Error codes 6000–6008 sit above Anchor's reserved 0–999 range. PDA derivation asserted deterministic, authority-dependent, and off-curve. **The constants were written from memory and were WRONG; the tests failed on the first run and caught it** — see F17 |
| **Capital boundary logic** | `VERIFIED` | 13 tests over six-position arithmetic: reconciliation across mixed operation sequences, reserve/release bounds, frozen-refuses-reserve but **allows release** (a freeze must not strand in-flight capital), serialisation round-trip, foreign-account rejection via the Anchor discriminator, forged-state rejection, and `u64::MAX` overflow refusal |
| **BPF-VM end-to-end** | `UNTESTED` | `solana-program-test` does not build here: upstream `five8` conflict in `solana-keypair 4.0.0` (F18). **Moot in practice** — the program was deployed to devnet and driven through real transactions, which is stronger evidence than a local bank |
| **Devnet vault creation** | `VERIFIED` | Program `6HqsPkHadbSstm1vHSad5zncK69tw6wfjE57JLzukhBh` on devnet, vault PDA `rY6jkirt4rP1HFVpLsKJcL8AUGXkkhhiE5nX8WEKuyL`. Read back from the RPC: authority `C4ZoTdN…` recorded, six positions summing to `total`, Anchor discriminator present |
| **Devnet funding** | `VERIFIED` | `deposit` succeeded: total 99,496,067 → 124,665,993 lamports. Checked `lamports == capital + rent-exempt minimum` (125,849,633 = 124,665,993 + 1,183,640), so the program's reported capital and the chain's real balance agree |
| **Devnet reservation** | `VERIFIED` | `reserve` moved available 39,385,079 → 29,538,810 and reserved 85,280,914 → 95,127,183, with `total` unchanged — capital moved between positions, none created |
| **Devnet release/refund** | `VERIFIED` | `release` returned reserved 95,127,183 → 0 and available 29,538,810 → 124,665,993, `total` unchanged |
| **Guarded spend — over-reserve rejected** | `VERIFIED` | `reserve(available + 1)` rejected with `0x1775` (INSUFFICIENT_AVAILABLE); vault bytes byte-identical afterwards |
| **Guarded spend — over-withdraw rejected** | `VERIFIED` | `withdraw(available + 1)` rejected with `0x1775`; vault unchanged |
| **Execution guard — non-authority cannot move capital** | `VERIFIED` | A freshly generated keypair's `withdraw` rejected: `Provided seeds do not result in a valid address`. Total unchanged at 124,665,993 |
| **Devnet settlement (authority withdraw)** | `VERIFIED` | `withdraw` of 40% of available succeeded: total 2,000,000 → 1,200,000, available likewise. lamports `2,383,640 == 1,200,000 capital + 1,183,640 rent`. Fixed by moving lamports by direct mutation rather than a system-program CPI — `transfer` rejects any source carrying data ("invalid program argument"), and the vault holds 105 bytes |
| **PRD §52 Phase 2 exit condition** | `VERIFIED` | All six clauses demonstrated on devnet by `scripts/vault-devnet.mjs`: vault creation, funding, reservation, guarded spend (over-reserve and over-withdraw both rejected, vault byte-identical), release/refund, and settlement. Run twice with identical results, so the harness is idempotent rather than a one-shot script |

Program `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` · vault
`5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T` ·
[explorer](https://explorer.solana.com/address/5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T?cluster=devnet)

| **Tempo Moderato funded** | `VERIFIED` | `node scripts/fund-tempo.mjs` — 1M units each of the Moderato TIP-20 stablecoins. **CORRECTED by F40:** this line originally named them OUSD / pathUSD / AlphaUSD / BetaUSD / ThetaUSD, all four of which were wrong. Reading `name()` on the mints gives **PathUSD, AlphaUSD, BetaUSD, ThetaUSD** at indices 0–3 and **OpenUSD** at `0x20c0…6a37da5c996874be`. There is no OUSD and no pathUSD on Moderato. Balances confirmed via Transfer topics, not the faucet response |
| Base Sepolia bridge configured and contracts verified | `VERIFIED` | `node scripts/bridge-sepolia.mjs` → L1StandardBridge 2,472B on Sepolia L1, L2StandardBridge 2,059B on Base Sepolia, and `messenger()` returns the documented `0xC34855F4…`. Note the guide the docs link to is archived and Goerli-pinned — see F16 |
| **Base Sepolia L1 deposit accepted** | `VERIFIED` | `depositTransaction` on the OptimismPortal (`0x49f53e41…`, `version()` → 6.0.0) via `cast send`: `status 0x1`, tx `0xb681280536f994aef11736e6592de70a363ea00b5dfd1e6a3f1ecd03839c9b4c`, L1 block 11823822, canonical `TransactionDeposited` event, L1 balance debited 0.05 → 0.0398 ETH |
| **Base Sepolia funded** | `VERIFIED` | **0.01 ETH arrived on L2.** Via `depositTransaction` on the OptimismPortal. The L2 balance is the evidence — read directly with `eth_getBalance` on `sepolia.base.org`, not inferred from the L1 receipt. A second 0.005 deposit was still deriving when last checked |
| Base Sepolia `depositETH` (via bridge) | `FAILED` | Reverts. `L1StandardBridge` has its own access control an EOA does not satisfy. The **portal** is the working path — F16 |
| **Base settlement through the adapter, live** | `VERIFIED` | `BASE_LIVE=1 npx vitest run tests/base-transport.test.ts` → `BaseSettlementAdapter` + `BaseRpcTransport` (EOA, viem) settled **0.01 USDC** — a fractional amount, which threw `SyntaxError` before this change — on Base Sepolia, block 47629845, tx `0xcd1778b0c4db16d48062a88c46cd98b6391c9a8b68597276edaf5674762f4ca3`. Receipt: status 1, one `Transfer` of 10000 atomic from `0x036C…CF7e`; `verify()` confirmed from decoded logs; the EIP-712 commitment read back from the on-chain calldata suffix equals the one signed (asserted). Gas 37,965 ≈ 2.3e-7 ETH. Same run re-read `symbol()`/`decimals()` for every Sepolia registry entry. Key `0x7823d6be…8116`, funded by faucet (0.08 ETH, 20 USDC). Offline: 23 tests, mutation audit 18/18 |
| **Solana settlement through the adapter, live** | `VERIFIED` | `SOLANA_LIVE=1 npx vitest run tests/solana-transport.test.ts` → `SolanaSettlementAdapter` + `VaultTransport` against the redeployed (F51) `mitra-vault`: one transaction holding `authorize` then `spend_authorized`. Tx `5ymG6QcREUCTTd9PPdXU4JPbUKcH5StpoJNbnch18beg9DbQqjR3TsewEiBvThyDCSTLhCDucY3TopwHan4Bh41U` (slot 507057927): program logs `authorization issued for mandate v1` then `spent 3000 under mandate v1`; vault −3000 and payee +3000 lamports exactly, from the tx meta; the permit reads back 130 bytes (F51 layout), program-owned, `consumed = 1`. Second run `2Vysy3DNAcDCh1hxrrvirvF2Xnkcjpx69dWqDhVX4akFb9vsMjczDLHawT5fE447Z4uwnjDQ3tWkqCTi9ADemw3F` reused the provisioned vault and mandate. Same run: a non-engine `authorize` simulated against the live mandate → `Custom: 6015` (`POLICY_ENGINE_MISMATCH`). Principal `ETjm3HV8…WBf1`, faucet-funded. Offline: 39 tests, mutation 24/24; TS client pinned to Rust-generated golden bytes (18 tests) |
| `BASE_ASSETS.USDC` on Base Sepolia | `FAILED` → fixed | Was the **mainnet** address `0x8335…2913`; on `sepolia.base.org` it has 0 bytes of code. Registry is now keyed by chain id; Sepolia USDC is `0x036C…CF7e` (`symbol()` USDC, 6 decimals, read live) |
| A Tempo balance is readable | `VERIFIED` | **Not** via `eth_call balanceOf` (reverts; token `eth_getCode` is `0xef`) — **CONTRADICTED 2026-10-03:** `eth_call balanceOf` on PathUSD returned a value for `0x…dEaD`, and `scripts/tempo-pay.mjs` reads balances this way; the revert was not reproduced. Balances are still not settlement evidence (fees, F40) and **not** via `api.tempo.xyz` (indexes mainnet — see F15). Readable via Transfer logs on Moderato with the recipient in **topic2**: filtering on topic1 misses every faucet mint, whose sender is the zero address |
| Tempo tokens held | 2M units per token | Two `tempo_fundAddress` calls, each minting 1M of all five faucet stablecoins |
| **Tempo settlement through the adapter, live** | `VERIFIED` | `TEMPO_LIVE=1 npx vitest run tests/tempo-transport.test.ts` → `TempoSettlementAdapter` + `ModeratoTransport` settled 0.01 PathUSD on Moderato and `verify()` confirmed it from decoded logs. Txs `0x013cbff9f02ecd7eb565ae1c2071652ecbd560d38c71fe5e46c7b24ef37626e5` and `0x8fb53e059f102cfb5597dfe361b35d2079527dddfe634b53c04876df0e44430d`. Receipt holds `Transfer` 10000 atomic to the recipient, `TransferWithMemo` (topic `0x57bc7354…`) whose indexed memo **equals the EIP-712 settlement commitment** (asserted), and a separate 335-atomic token fee. Funded key `0x7823d6be…8116` (2M per token via `fund-tempo.mjs`). Offline: 26 tests, mutation audit 15/15 |
| **An ACCEPTED agreement settles through the Mitra path, live (Base)** | `VERIFIED` 2026-10-03 | `BASE_LIVE=1 npx vitest run tests/settlement-caller.test.ts -t live` → ACCEPTED agreement with `payTo` → reservation through `POST /api/v1/reservations` (policy evaluated, `agreementId` bound into the action digest) → `POST /api/v1/settlements` → `lib/kernel/settlement.ts` (execution guard re-run against a digest re-derived from the agreement) → the rail `railsFromEnv()` builds from `MITRA_EVM_SETTLEMENT_KEY_FILE` + `BASE_RPC_URL`. Settlement `set_ag_live_1791061941835`, tx `0x65c481e99260a1a0955b17a3e1813987734472919cdfbdebafe6c28c86da4ea9`, Base Sepolia block 47646830: receipt status 1, from relayer `0x7823d6be…8116` to USDC `0x036C…CF7e`, one `Transfer` of 10000 atomic (0.01 USDC), gas 37,965. `CONFIRMED` / `TESTNET_PASS`; `agreement.settledRef` set; the commitment read back from the on-chain calldata equals the settlement's (asserted). Paid to the relayer's own address. **Not shown live:** Tempo and Solana through this path — same code, different rail; only their adapter legs are live (rows above). Offline: 20 tests in `tests/settlement-caller.test.ts`, mutation audit 14/14 (after one gap found and closed: a nonce consumed but not yet marked `COMMITTED`) |
| **Settlement evidence from the chain, live on all three rails** (sprint item 2) | `VERIFIED` 2026-10-03 | `getEvidence()` re-derives the commitment from the settlement record, re-reads the transaction through the transport's `observe()`, and builds a bundle only if the carried commitment, payer, payee, amount and token all match; the confirmation block is the node's. **Base Sepolia**, full Mitra path (`BASE_LIVE=1 npx vitest run tests/settlement-caller.test.ts -t live`): tx `0x83a19fdb11a9a07dcc6858a8c34388fa543410d69c5e3fc3970a44b35239afd6`, `GET /api/v1/settlements/evidence` → verdict `TESTNET_PASS`, block 47648508 (equals `eth_getTransactionReceipt`), receipt `rcpt_set_ag_live_1791065300853`, receipt chain verified, bundle re-verified from its JSON alone. **Tempo Moderato** (`TEMPO_LIVE=1 npx vitest run tests/tempo-transport.test.ts -t live`): tx `0x7c835aefd1f03d056a9787439b66967ad84294406ca6b97feb8e68efd09d2006`, block 38048386, `TESTNET_PASS`. **Solana devnet** (`SOLANA_LIVE=1 npx vitest run tests/solana-transport.test.ts -t provisions`): tx `Ctik7kab6FPZnFoZvfemumUwLHJdCCGqj2DvCj1VxMatJXxkdgCz7Ze7p5AxxhX6JM48DCdfTMUoqi5aLq63UBX`, slot 507144309, `TESTNET_PASS`. Tempo and Solana evidence was taken through the adapters directly, not through the agreement route. Offline: 41 tests in `tests/settlement-evidence.test.ts` plus 3 route tests; mutation audit 17/17, plus 2/2 on the Postgres receipt lock |
| **A smart account pays an ACCEPTED agreement through the EntryPoint (ERC-4337), live; its signatures verify on chain (ERC-1271, ERC-6492)** (sprint item 3) | `VERIFIED` 2026-10-03 | `BASE_LIVE=1 npx vitest run tests/settlement-caller.test.ts -t "ERC-4337 smart account"`. Rail from `railsFromEnv({ …, MITRA_BASE_SETTLEMENT_ACCOUNT: "erc4337" })`: payer = Coinbase Smart Wallet v1 `0x00aD7C71680A5b1a9B86d41440022857fC17E7CA` (owner `0x7823d6be…8116`, factory `0x0BA5ED0c…428a`). The relayer submitted `handleOps` to EntryPoint v0.6 `0x5FF137D4…2789`: tx `0xd3c1145323fef446bd1c9c1a83fe0df0385018d962db2ea89a79fc59c1f17844`, block 47649638. Decoded independently from the receipt: `AccountDeployed` (first UserOperation deployed the account), USDC `Transfer` 10000 atomic **from the smart account**, `UserOperationEvent` `success: true` (userOpHash `0xc5daef26…9df6`, gas 1.99e12 wei paid by the account). Settlement `CONFIRMED`; evidence `TESTNET_PASS`, re-verified from JSON. **ERC-1271:** the now-deployed account's plain signature over a settlement digest → `verifyAuthorisation` via `RpcSignatureVerifier` → `{ok:true, mode:"contract"}`. **ERC-6492:** a fresh undeployed account (`0x1d46B654…C9ED`) → `{ok:true, mode:"contract"}` via the universal validator (eth_call only); a stranger account's signature refused. Offline: 22 tests in `tests/erc4337-transport.test.ts`, mutation 12/12 (one test case found too weak and corrected). **Not claimed:** paymaster sponsorship, an external bundler, EntryPoint v0.7 |
| `lib/evm/erc4337.ts` computes the hash an EntryPoint v0.7 checks | `VERIFIED` 2026-10-04 | F54 fixed (backlog #6). Equal to viem's `getUserOperationHash` (v0.7) and to the deployed EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` `getUserOpHash` on Base Sepolia (`eth_call`, value `0x939163be…2bb6` for the test operation). Changes with chain id and EntryPoint, not with the signature. Mutation 2/2 |
| **An x402 V2 payment, paid by Mitra from a reservation, settled by the public facilitator** (sprint item 4) | `VERIFIED` 2026-10-04 | `BASE_LIVE=1 npx vitest run tests/x402-gateway.test.ts -t live`. A real x402 V2 resource server (the SDK's `x402HTTPResourceServer` + `ExactEvmScheme`) on localhost, backed by `https://x402.org/facilitator`. Mitra's gateway (`lib/payments/x402-gateway.ts`: `@x402/fetch` + `@x402/evm`, Mitra's `planX402Payment` in `onBeforePaymentCreation`) paid 0.01 USDC from a reservation whose digest binds `x402:<payTo>`. Tx `0x1d9cfb8a6f0bbce49c1007f7f65019e99113c39342759a7cf8a000b16aad963a`, Base Sepolia block 47651451, decoded independently: **submitted by the facilitator's signer `0xd407e409…f1bf`**, `AuthorizationUsed` (authorizer = relayer `0x7823d6be…8116`), USDC `Transfer` 10000 relayer → `0x00aD7C71…E7CA`. HTTP 200, settlement `CONFIRMED` from the chain, receipt chained. Offline: 20 tests (each refusal asserts no payment signature left Mitra), mutation 12/12 after one added test |
| **The Mitra MCP server, over stdio and over HTTP to a running Mitra** (sprint item 4) | `VERIFIED` 2026-10-04 — local, not deployed | `npx tsx scripts/mitra-mcp.ts` (`MITRA_API_URL` set). In-process: 11 tests through the real MCP protocol (SDK `Client` ↔ `InMemoryTransport` ↔ real route handlers); the stdio entry spawned and listed. Over HTTP: `next start` on :3017, an external MCP client spawned the stdio server, `mitra_create_agreement` opened `ag_mcp_http_1791070792825`, the API read it back `OPEN`, and `mitra_accept_deliverable` was refused (withheld, F55). 9 tools served, 3 withheld, 6 unbacked — each with its reason in the server instructions. Mutation 3/3 after one added test |
| **A clearing epoch, live: kernel netting → MitraClearing → residuals paid through the execution guard and MitraVault, receipts attached** (Phase 7; `feat/backlog-on-v2`) | `VERIFIED` 2026-10-05 — Base Sepolia and Tempo Moderato | `CLEARING_LIVE=base` / `CLEARING_LIVE=tempo npx vitest run tests/clearing-live.test.ts`. Cycle: buyer→data 0.03, data→eval 0.02, eval→buyer 0.005; residuals buyer→eval 0.015, buyer→data 0.01. Before the chain finalized, `settleResidual` was refused `RESIDUAL_NOT_FINALIZED_ON_CHAIN`; after, each residual was reserved under `clearing_residual` (policy ALLOW), planned by `planResidualSettlement`, checked against `transfersOf`, and paid through `spendAuthorized`. **Base** — clearing `0xaacba512ba6dc726cb6cafdc2799198dbddb1c4c`, vault `0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489`, epoch `0x1bd83dc1e4f53e5751ed99ee9fd02eb32e37b702e717ab32cf1638e5c16873f1`: openEpoch `0x4d62fae90599c07fd2db99b757d8aae22b1d056115b43be0b5701d102a9b9597`, freeze `0xf5bb5b0e6af09601a3d0e7c144a39b35f0bcc38e767e8583c0ee92d2fe9e177c`, propose `0xff68cac077eb468ca02f04098b44d1be4c23421c6d6f87753c1f4705f196a748`, finalize `0x71b7d07ff09a7bbc4e56b7139f4eeb488c8dccadf579e4de28334cbabd747459`, residual payments `0xc9dc68963efc74f68681e2cc4f6d0cef20dbf0061d5f19d0cdb89e9ba7a35451` (0.015) and `0xec0d2b12fd3664bb0c185be3c88ace8d7b2ff046a1d080f084407bf6984170e6` (0.01), receipts `0x0cf59b8d3fdbe1d2d0cf277aa670c8dc33c88e8a4792d851aa41f079d3d94a1f`, `0xab750ae5dfef02f7dd4f94b9a70926c6a9d906311fa8c0736fca32247ebea117`. **Tempo** — clearing `0xd03d91c3ae594c6b1163d89a5cee622c3c1f8688`, vault `0x85409dfc30fa0671b06f98cc56c5b04eb921b568`, epoch `0xb12f3b527adb01feeccd6045ecffb3dd44decabc818c7d641225bc6a273d0c25`: openEpoch `0x2c5b98667812e745df3228d904c59a697053c91faecc9566defaaf2238561380`, freeze `0xdeb3d7bcd432c32475625fc1a9d83cf54c7ce62f965f55e27eee7397cb1e8e4c`, propose `0x21320a9dc45d95d29596746994a46722f401f7ad8bb740280221f7dbf2ef0a09`, finalize `0xd77e5247f6dfb10adb4cc628723e839639a9509cc55b3ea8bfed3c5d47146f06`, residual payments `0x6f48ff94df4aa2884539076d981b4c9859e9c7756dcedad47f4d7f2b133be9b4` (0.015) and `0x3c691707131baa06f1dc7be3ce667cc2616e5eb11ff32554f2fa4d0664c1f6a5` (0.01), receipts `0x8e557d391746b7b9543df13f991cea9da2dda7e9cca6f8af556debf540dfcaa5`, `0x232cb874cc29261ef883a464cb98d5b6189ce9191182ae7a9cc2b0e59a54bb2f`. Read back independently by `eth_call` on both chains: status 7 (`Settled`), 3 obligations, 1 proposal, 2 receipts equal to the two payment hashes. **Not live:** a challenge (Foundry only); the payees are fixed derived addresses, not agents operating their own keys |
| **Caller identity (F55): every agreement transition and agent registration is an EIP-712 signed request** (`feat/backlog-on-v2`) | `VERIFIED` 2026-10-05 — local, in-memory and Postgres | `npx vitest run tests/signed-request.test.ts tests/agreements-identity.test.ts tests/agents-registration.test.ts tests/mcp-server.test.ts` → 46 pass. Refused through the real routes: unsigned (401), a stranger's valid signature naming the client (401 `SIGNER_NOT_AGENT_WALLET`), the **provider's own valid signature accepting its own deliverable (403 `ACTOR_NOT_PERMITTED`)**, a replay after the transition (401), a body changed after signing (401), a registration with an unsigned wallet (401 `WALLET_NOT_PROVEN`), a takeover of `agent_buyer_07` (409), a Solana wallet (400). Applied: each role-holder's signed transition; the evaluator's accept; ERC-1271 contract-wallet approval (seam test, stub verifier). MCP: the four tools are served and the signature reaches the API unchanged; unsigned calls reach no route. Mutation 11/11 killed in memory; on Postgres, `insertAgent` overwriting on conflict is killed by the takeover test. Full suite: tsc clean; vitest 825 in-memory, 0 fail; Postgres (`postgres:16-alpine`, PostgreSQL 16.15) `DATABASE_URL=… npx vitest run --no-file-parallelism` → 874 pass, 0 fail, twice in a row on one database. **Not done:** ERC-1271 against a real chain; a live external agent |
| **The Mitra MCP server over the network — legacy SSE (`/sse` + `/messages`) and Streamable HTTP (`/mcp`)** (Phase 5, lead handoff §2.2; `feat/backlog-on-v2`) | `VERIFIED` 2026-10-04 — local, not deployed | `npm run mcp -- --transport sse --port 3001` → `lib/mcp/http.ts`. Offline, `npx vitest run tests/mcp-server.test.ts`: real SDK clients over real sockets on both wire formats list exactly the served tools, open an agreement the store holds, and a withheld tool reaches no route; bearer token enforced on every endpoint (none / wrong → 401); refuses to bind off loopback without a token (≥ 32 chars), in-process and from the CLI; loopback `Host` must name loopback (DNS rebinding → 403); browser `Origin` refused unless allowed; session cap (503); Streamable sessions abandoned without `DELETE` are reaped, active ones are not; cross-wire session ids, unknown sessions, non-initialize first requests (`SESSION_REQUIRED`), oversized (413) and malformed (400) bodies refused. Live against `next start` (`MITRA_API_URL=http://localhost:3017 npx vitest run tests/mcp-server.test.ts -t "over HTTP"`): the CLI bound to `0.0.0.0` with a token; unauthenticated `/healthz` → 401; an SSE client and a Streamable HTTP client each opened an agreement (`ag_mcp_sse_1791137605633`, `ag_mcp_streamable_1791137605773`) that the API read back `OPEN`, and each was refused `mitra_accept_deliverable`. Mutation 14/15 killed; the 15th (`onsessionclosed`) was redundant with `onclose` and removed. Suites: tsc clean; vitest 804 in-memory; Postgres `--no-file-parallelism` 853/853 twice. **Not done:** a token is "may connect", not caller identity — F55 still withholds fund/accept/reject/register |
| **The Console reads the store and streams the event log live** (sprint item 5) | `VERIFIED` 2026-10-04 — local, not deployed | `npx vitest run tests/events-stream.test.ts`: the SSE route read as a byte stream — events appended after it opened arrive, ids are log positions, `Last-Event-ID` resumes with nothing repeated or skipped, `?runId=` filters while keeping global ids; agreement, reservation, execution, authorization and x402 routes write events, refusals included. Browser: `next start` + headless Chromium (`chrome-headless-shell` 1243) — every converted page 200 with its `Live store` label; Overview connected to the stream, and an agreement opened through the API appeared on the already-open page in 797 ms without reload; `/commerce` listed it. Mutation 6/6. Suite: 736 in-memory, 783 Postgres |
| **MitraVault.sol deployed, source-verified, and spending live on Base Sepolia and Tempo Moderato** (sprint item 6) — the CALLER VARIANT, `contracts/src/MitraVault.sol`, now `*__callerVariant` in `lib/evm/deployments.json`; `tests/evm-vault.test.ts` re-pointed there and re-run green 2026-10-04 on `feat/backlog-on-v2` | `VERIFIED` 2026-10-04 | `npm run contracts:test` → 19/19 Foundry tests (each F51 attack refused; single use; per-spend limit and cumulative ceiling; freeze; expiry; holder self-revoke; version bump kills old permits; ERC-1271 engine; fee-on-transfer deposit; escrow release/refund rules), mutation 14/14. Deployed by `node scripts/deploy-evm-vault.mjs base\|tempo`, runtime code checked against the artifact (immutable slots masked): **Base Sepolia** `0x78b82802ad2da2dc136a5c03eabd8c4fefa265cf` (tx `0x6c2c28da…63c4`, block 47652046) — Sourcify `exact_match` creation + runtime, forwarded to Basescan; **Tempo Moderato** `0xfadc63a689a7ce2e0af4e772f3216994643c8d24` (tx `0x7fc16dd0…58e6`, block 38060186) — Tempo verifier `exact_match` runtime. Live (`BASE_VAULT_LIVE=1` / `TEMPO_VAULT_LIVE=1 npx vitest run tests/evm-vault.test.ts`): deposit → `openMandate` → engine-signed EIP-712 permit whose actionHash is a Mitra settlement commitment → relayer `spendAuthorized`: Base tx `0x81cdcff1b5c33d1c329d3e8f4278001732138c0f8a9f4def8e7746de753662cf`, Tempo tx `0xe46457c20a86a7a12ea27dcfe86bef41c15d22081fa8b5ac3069a32702048c55`, fresh payee holds exactly 10000 on each; `SpendExecuted` carries the commitment. Simulated on chain (eth_call, at the spend's block): stranger engine → `EngineSignatureInvalid`, redirected payee → `EngineSignatureInvalid`, replay → `AlreadyConsumed`. Addresses in `lib/evm/deployments.json`. **Not done:** Mitra's settlement rails do not yet pay through this contract (the lead's B.4) |
| **An ACCEPTED agreement settles THROUGH MitraVault.sol, live on Base Sepolia and Tempo Moderato** (package B.4) — against the caller variant; superseded by the v2 row below | `VERIFIED` 2026-10-04 | `BASE_VAULT_LIVE=1` / `TEMPO_VAULT_LIVE=1 npx vitest run tests/evm-vault-transport.test.ts -t live`: rails from `railsFromEnv({ MITRA_BASE_SETTLEMENT_ACCOUNT \| MITRA_TEMPO_SETTLEMENT_ACCOUNT: "vault", MITRA_EVM_VAULT_HOLDER })` → `MitraVaultTransport`: the engine signs a permit whose actionHash is the settlement commitment, the relayer submits `spendAuthorized`. **Base** tx `0x0d87591595b538616937d6cc60953de4733dd5a77e0f2d7c3ce287f7d0be56fe` (block 47668776), decoded independently: to the vault contract; `SpendExecuted(principal 0x7823…8116, holder 0x09e6…D827, recipient, USDC, 10000, actionHash 0x9cba…1c8f, v1)`; USDC `Transfer` 10000 **from the vault contract**. **Tempo** tx `0x902c47437e87f1724f6d159eff383580aab5fe2dca907e2f7f54bfa8560431b3` — the first Tempo settlement through the agreement route. Both `CONFIRMED`, evidence `TESTNET_PASS`. Offline: 22 tests, mutation 10/10 |
| **An ACCEPTED agreement settles THROUGH the canonical MitraVault v2, live on Base Sepolia and Tempo Moderato** (B.4 ported to `contracts/MitraVault.sol`, `feat/backlog-on-v2`) | `VERIFIED` 2026-10-04 | `BASE_VAULT_LIVE=1 TEMPO_VAULT_LIVE=1 npx vitest run tests/evm-vault-transport.test.ts -t live`. The rail resolves the canonical entry for the chain (`baseSepolia` / `moderato`, never `__callerVariant`); both addresses first checked by `eth_call`: `PERMIT_TYPEHASH` equals the keccak of the v2 8-field struct and `domainSeparator()` equals `EIP712("MitraVault","1", chainId, address)`. **Base** tx `0xa607a6f9926c305ac8195039318eadc715093552fc3968dfbc5a62df08472d71` (block 47683709), **Tempo** tx `0x08160f4f70914abdde6bcfee1db5b405d461204f677c86a876c35fad6700cf85` (block 38165579); both `CONFIRMED`, evidence `TESTNET_PASS`. Decoded independently: `to` is the v2 vault; the `spendAuthorized` calldata permit carries the settlement commitment as `actionHash` (Base `0x180c…f361`, Tempo `0xe6e0…f00e`), holder `0x09e6…D827`, mandate v1; `SpendExecuted.actionHash` equals the EIP-712 digest recomputed from that calldata permit; the token `Transfer` of 10000 is **from the vault contract**. v2 changes what "confirmed" means — its event carries the permit digest, not the commitment, so `observe()` now reads calldata AND receipt and binds them by the digest. Offline: 32 tests in `tests/evm-vault-transport.test.ts` (incl. pay→observe round trip); mutation 16/16 after one survivor (calldata principal check) was killed by a new case. Suites: tsc clean; vitest 789 in-memory; `--no-file-parallelism` on Postgres 16 838/838 twice; `forge test` 30/30 |
| **An ACCEPTED agreement settles on Solana devnet through the Mitra route** (backlog #3) | `VERIFIED` 2026-10-04 | `SOLANA_LIVE=1 npx vitest run tests/solana-agreement-live.test.ts`: reservation → `POST /api/v1/settlements` → the rail `railsFromEnv` builds (`MITRA_SOLANA_*`) → deployed `mitra-vault` (authorize + spend_authorized, one tx). Tx `3tR25Ybm4jMGwfRbEsh9eAea4GBTZAWzqKkXipwBwL5xSd1CQLCu7YtUBmkHErMW7AHnhGTSWxTRcakbB1qp71rH`, `CONFIRMED`; evidence `TESTNET_PASS` at slot 507319775; the Mitra vault's total fell by exactly the price and nothing stayed reserved (backlog #2). With the Base and Tempo rows above, **every rail has now settled an agreement through the route live** |

Addresses are public and safe to print; the private keys are in a gitignored
directory at mode 600 and are **not** in this repository.

---

## T6 — Shared context (development tool)

```bash
node shared-context-mcp/dist/cli.js audit --db .shared-context/context.db
```

| Claim | Status | Evidence |
|---|---|---|
| The context log is tamper-evident | `VERIFIED` | 19 entries, `audit ok=true` |
| Context survives loss of the working directory | `VERIFIED` | Rebuilt from committed sync bundles after the directory was emptied |

---

## Phase audit — 2026-01-10

Conducted against `docs/product/MITRA_PRD.md` §52, `forge/standards/BUILD_FOUNDRY.md`
and `Repository-Starter-Virtuous-Build-Cycle.md`, using the two-field vocabulary
from [ADR-0008](../docs/adr/0008-evidence-two-fields-union-vocabulary.md).

| Phase | Exit condition (PRD, verbatim) | evidence | blocker |
|---|---|---|---|
| 0 Ground truth | "Every P0 object has a schema and state transition definition." | `INTEGRATED` | `BLOCKED_INTERNAL` — 6 of 7 state machines have definitions but no write path (`p0-registry` records `hasMachine`) |
| 1 Core | "Purely local end-to-end lifecycle passes." | `E2E_VERIFIED` | — |
| **Solana vault program upgraded with `security.txt`** | `VERIFIED` | `cargo-build-sbf --tools-version v1.57 --arch v1` → `mitra_vault.so` (114,912 B) with the `security_txt!` macro embedded (confirmed: `strings` shows the advisories URL, the policy URL, and "None. This program has NOT been independently audited"). Upgraded via `solana program deploy`, signature `2ToMP4Z2Eb1jmsJxdW47g182GdaVEKcS9MNCGCzbmTaLpZRRwMC6npcmJWbboMjMdxbybf4jYMS2MF9oY94v3XDS`. ProgramData `9aUb2Zoz…` grew 110,029 → 120,269 B (code 120,224 B; the +5.3 KB is the loader-appended region, not a mismatch). **Live proof of no regression:** `SOLANA_LIVE=1 npx vitest run tests/solana-transport.test.ts` → 40/40 against devnet. `cargo test` → 104/104 |
| 2 Solana kernel | "Real testnet/devnet vault creation, funding, reservation, guarded spend, release/refund, and settlement proof." | `LIVE_DEMONSTRATED` | — |
| 3 Authority | "Agent cannot execute an out-of-policy transaction." | `LIVE_DEMONSTRATED` | `DEFERRED` — mandate→authorization→consume-on-spend is live on devnet, replay is refused on-chain, and **amendment + terminal revocation are deployed and exercised** (the 96→97 realloc ran on a live account). **Arcium unblocked — see F31.** The blocker was an assumption, not an attempt: Docker, Anchor 1.0.2, arcup and the Arcium CLI all install cleanly here. Remaining for Phase 3d: run the circuit on a local MPC cluster and deploy and any signature-abstraction layer |

**Phase 3b evidence — 2026-10-02, Solana devnet.** Redeploy carrying `revoked`,
the 97-byte layout, and the `MANDATE_REVOKED` (6014) code.

- Program: `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY`
- Agent: `Bcv2z6GRfqcU164uJCK3au5UaD33aZ1pf2vCzDt3xQTN` · Mandate: `8nB4AjZEs5t3cLfSrXr3if7ai6u5oCVLLdADye73VNZz`
- Vault: `5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T` (98 B authz, 97 B mandate on chain)

```bash
cargo test --manifest-path programs/mitra-vault/Cargo.toml   # 72/72
PHASE3_AGENT=fin2 PHASE3_RUN=f2 node scripts/authority-devnet.mjs   # ALL CHECKS PASSED
```

| Claim | Evidence |
|---|---|
| A mandate is opened and is the holder's own | `holder == agent`, v1, limit 100000 |
| A permit is derived and version-cited | permit on chain at v1, unused |
| A permit cannot be re-issued | `0x1779` (6009) |
| A permit is bound to one action | `0x177d` (6013) |
| A permit is single-use; replay moves nothing | `0x177c` (6012); vault `2383640 → 2383640` |

Amendment and revocation were exercised against a **live 96-byte mandate**, so
the `realloc` 96→97 path is proven on-chain, not merely compiled: the account grew
mid-transaction, kept every field, and became 97 bytes with `revoked = false`.

### Known harness limits (recorded, not hidden)

The Phase 3b amendment/revocation *steps* are implemented in the Rust program and
covered by `amend_integration.rs` against the real handler, but the devnet run that
produced the table above executed steps 1–7 on a fresh agent. Steps 8–9 passed
on-chain in an earlier run (agent `Fmzk9qaGaFV7yvjdRbYJHxd3nQqJL3LfNbS3UJfv1BCt`,
"permit issued BEFORE the tightening is still spendable", mandate `v3 → v4`,
len 96 → 97) but that run then revoked its agent, which is why re-running it now
aborts by design. Both outcomes are in the transcript; neither is claimed as a
single clean full-harness pass.

The harness now aborts with a **named** exit code rather than proceeding when a
precondition is unmet (4 = revoked/expired mandate, 3 = action already spent, 2 =
cannot fund), because three separate harness faults had been surfacing as
downstream policy refusals — see F30.

**Phase 3 evidence — 2026-01-10, Solana devnet.**

- Program: `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` (redeployed this run, slot 506526518+)
- Vault: `5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T`
- Agent: `69P6furryqiLh4QzusKKxQftFJFsSADiGzGE2XdYYeU7` · Engine: `AsekkLdQWCE7dcCZxtkLhJvNR5e4zUbDhrBM1mKSM4e6`
- Mandate: `HByESBJV5DvoyR2bTHnK42SA55NmHqW1m8js2e1zUCPX` (96 B, v1, limit 100000)
- Authorization (run `final1`): `CMdWgCWGvX2K8VxZxkAW63rFgnPX4i8Me9c2yTgtkpcE` (98 B, `consumed=1`, 1_148_080 lamports slack)

Commands:

```bash
cargo test --manifest-path programs/mitra-vault/Cargo.toml          # 51/51
PHASE3_RUN=final1 node scripts/authority-devnet.mjs                  # ALL CHECKS PASSED
node scripts/verify-phase3.mjs final1                                # VERIFIED
```

Decoded on-chain outcomes, not signatures:

| Claim | Evidence |
|---|---|
| A mandate is opened by its own holder | mandate `holder == agent`; no privileged creator exists in the handler |
| A permit is **derived**, never asserted | instruction carries only `action_hash` + `amount`; version and expiry are copied from the mandate |
| The permit is bound to one exact action | spending under a different hash → `0x177d` (6013 ACTION_HASH_MISMATCH) |
| A permit cannot be re-issued | re-`authorize` → `0x1779` (6009 ALREADY_INITIALIZED) |
| A permit is single-use | `consumed` byte on chain is `1` after the spend |
| **Replay moves no value** | replay → `0x177c` (6012 AUTHORIZATION_CONSUMED); vault `3183640 → 3183640`; recipient `2496160 → 2496160`; 10 further attempts all refused |
| Capital stayed reconciled | six positions sum to total, checked on every read and again by the independent verifier |
| The refund is not a loophole | amount comes from the permit; the instruction has no amount field |

The two refusals that matter were each confirmed by a **decoded custom error
code**, not by the mere presence of a failure.
| 4 Commerce | "Real job can be opened, funded, submitted, accepted, rejected, refunded." | `PROPOSED` | `BLOCKED_INTERNAL` — no implementation in Mitra. **Substrate located**: Microcosm at `/opt/microcosm-x` (§50 reuse list audited, F24) |
| 5 Agent ecosystem | "An external agent can participate without becoming Mitra-native." | `INTEGRATED` | `BLOCKED_INTERNAL` — F55 is fixed (signed requests; see the caller-identity row), so `fund` / `accept` / `reject` / `register_agent` are served, but no external agent has yet completed a signed commerce loop against a running Mitra. Served today (local, not deployed): the MCP server over stdio, legacy SSE and Streamable HTTP (see the network-MCP row), and x402 V2 payments from a reservation. No A2A, ERC-8004 or marketplace |
| 6 Recovery | "Deliberately failed job reaches a defined terminal recovery state." | `LIVE_DEMONSTRATED` | — |

**Phase 6 evidence — 2026-10-03, Base Sepolia (84532) & Tempo Moderato (42431).**
Automated distributed saga recovery executed against live `MitraVault.sol` deployments.
A deliberately rejected agreement triggers automated compensation: pre-committed `refundEscrow(jobId)` is executed on-chain after timeout, restoring vault available balance with zero lost capital, advancing the saga to `RECOVERED` without unhandled exceptions (PRD §4.5, §15.5, ADR-0012). Replay is refused on-chain.

- Commands:
  ```bash
  node scripts/showcase-live-saga.mjs baseSepolia   # 100% PASS
  node scripts/showcase-live-saga.mjs moderato      # 100% PASS (verified PathUSD 0x20c0...0000)
  ```
- **v2 CONTRACT, F61 token-scoped mandates — CURRENT figures (purple, 2026-10-05, F63).** `node scripts/deploy-evm-vault.mjs` now refuses unless the runtime code equals `out/MitraVault.sol/MitraVault.json` (immutables masked) and carries `mandates(address,address,address)`. Base Sepolia vault `0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489` (tx `0xb8a7562fca984d2aaba30b2c6dc6370e1b33625b3cf84489f2dfa8284e7982bd`, block 47729699); Tempo Moderato vault `0x85409dfc30fa0671b06f98cc56c5b04eb921b568` (tx `0xe3e3cbe7e14ad2e8eb4e2b2ef719813539dca70f7c5455e4e094e58aa4a22684`, block 38318925); both 8816 bytes. Vault rail re-proven live through `spendAuthorized` with token-keyed mandates (`BASE_VAULT_LIVE=1` / `TEMPO_VAULT_LIVE=1 npx vitest run tests/evm-vault-transport.test.ts -t live`): Base `0x31822a95e6eb13c68091674ab079f6c7aa8a8b386a4dc58c9cb5353ebbe138ac`, Tempo `0x1ef139d4f19675c206a72b623536fb6cd01f7175b9d4c1d8466b51fc63bea9e1`, both CONFIRMED, evidence `TESTNET_PASS`.
- **CORRECTED (F63) — the entry below was recorded as the F61 deployment but its bytecode is pre-F61**: 8701 bytes on both chains, 2-key `mandates`, no token-keyed getter. Its lockEscrow/refundEscrow hashes are real transactions on the pre-F61 code. Retained for provenance.
- ~~v2 CONTRACT (with F61 token-scoped mandates) — CURRENT figures~~
  (keying mandates by `[principal][holder][token]`, deployed fresh on both chains;
  see superseded runs below for provenance).
  - Base Sepolia, vault `0xbd78e40b109bc7e47415ba544710ef1d6b9bbe8b`
    (deploy tx `0xd9c986723f7cf055349c5754be128a8a169dd5c1191d8ad78cdd076c5e941445`, block 47687892):
    - `lockEscrow`: `0x2d8127923d8a52750d183e27095ae784d6c4c80860738aa375642afb0c07486c` (block 47688063)
    - `refundEscrow`: `0x05dd1f712c0ae3232769411c73d252f554a88be6c14f2a45e3828a14127849bf` (block 47688074)
  - Tempo Moderato, vault `0x81798c6f4ff1257b53b0be512c979f2656269329`
    (deploy tx `0x35a545fdd3d5e6021054f70c2195cdec98c5d09bb4f41d81d3e5bd4ae5181c77`, block 38179538):
    - `lockEscrow`: `0xc43de9845ade2bf7da02aa862ab963249153534410ff6122bce9728a22a284c0` (block 38179597)
    - `refundEscrow`: `0x43e5a00d81cd9ef7d75d56aeeefabdf613c9dc5bc6d235c4545c6fd191b1338c` (block 38179633)
  - Deployed bytecode returns `PERMIT_TYPEHASH() == 0xcae3f4fbf2f6d96ea9b2c34236eaafd63d622d4a5e7c33f861c116f33cff1a88`
    via `eth_call` selector `0x30adf81f` on both chains.
- Superseded — previous v2 pre-F61 deployment (retained for provenance):
  - Base Sepolia, vault `0x9c2c2d42a1a282b665bc67f407017b7605e51e8f`
    (deploy tx `0x39953adf7f0d19f60add1784d6b335c05c325fcf2f9b46fe0df572203e17ed8e`, block 47669876):
    - `lockEscrow`: `0xd585765c9735ac9dc40ba636fa1fea3af2413dadac1171f2767cc0ba5e915163` (block 47669948)
    - `refundEscrow`: `0x22096706ac5670ba580b9ccc4c7698e1e6c1df59947ecaa9375d779513eb21a3` (block 47669959)
  - Tempo Moderato, vault `0xaa46c23adefed6687cb2180d8a14cf88c6688ee6`
    (deploy tx `0xc13aadac5052e9bb3046bc2c3c76afdfe527d2ff732acf9af92afdbd09b77679`, block 38119669):
    - `lockEscrow`: `0x32eddfd5fa7c4d1ef58a40e8b58ac78ab6e621608ab0e1db98f663ee032313ec` (block 38120016)
    - `refundEscrow`: `0x22f3d9cdb35ec0b7829ae0e643111f9ff0cbddfd08b03b190a4549348908fd34` (block 38120052)
- Superseded — v1 contract addresses/hashes retained for provenance only:
  - Base Sepolia (84532):
    - `lockEscrow`: `0x61fcfb6dba13b7751c65b0d07c943c51d6d22d69923e1fe4f010f72b49d46d0a` (block 47648097)
    - `refundEscrow`: `0x767b4e30f12e97868c4120ad65878b588e673c8c43e04dce71cc71c15351800b` (block 47648107)
  - Tempo Moderato (42431):
    - `lockEscrow`: `0xbd174dd45ce651905ca4d369073f60202cb86c50e495a27df9be3b4be695640b` (block 38046990)
    - `refundEscrow`: `0xbfd5c584d0e09f8c4da5e896aa52b07d4d3401f77de279d9bab7e3a5d60ed3cc` (block 38047027)
- Executed Tx Hashes (Run 1, recovered from block tx lists):
  - Base Sepolia: `lockEscrow` `0x5983f82b203b68523c0696fe609785833559262f9f64c7279c130fc144379e8c` (blk 47647239), `refundEscrow` `0xc05bd25c5a108391b2059447f4ddfda4c52e3598c332eea9cbb8f8a125a316a5` (blk 47647243).
  - Tempo Moderato: `lockEscrow` `0x300a9b685218f9b0275e935603cea786764e0e6687d6383656482bb6d3b15084` (blk 38044216), `refundEscrow` `0x5881a9ea0823588ab96892ded35340c56e1af3f49b54f95763558d7d2a6ddde8` (blk 38044252).
  - Both chains: Replay `refundEscrow` rejected on-chain (`JOB_ALREADY_SETTLED`). Attempt count recorded on saga (`F47`). See `F52`.
| 7 Clearing | "Deterministic netting passes adversarial graph tests." | `LIVE_DEMONSTRATED` | — (2026-10-05, Base Sepolia 84532 and Tempo Moderato 42431). Netting: `tests/clearing.test.ts` 29/29, including the adversarial graphs (self-loop, long cycle, chain, disputed/defaulted excluded and visible, 20-party balance). Live: a 3-party cycle (gross 0.055 → residuals 0.015 + 0.01) netted by the kernel, run through the F64 `MitraClearing` (open → record → freeze, `inputsRoot` equal to the locally recomputed rolling hash → propose → finalize after the window) and both residuals paid through the execution guard and MitraVault, each bound to the transfer the contract finalized, receipts attached, epoch `Settled` on-chain and in the store — see the live-clearing row. Scope: the challenge path is exercised in Foundry (18 clearing tests, mutation 12/12), not live; the operator is one EOA (spec 55.3) |
| 8 Base | "Same economic intent executes on Base through the common API." | `TESTED` | `PARTIAL` — `BaseSettlementAdapter` + `BaseRpcTransport` settle live on Base Sepolia through `SettlementAdapter` with the EIP-712 commitment on-chain as a calldata suffix (see the live row above). EOA path only: the ERC-4337 path (`scripts/base-4337.mjs`) is not wired through the transport. The Solana leg of the same intent also settles live through `SettlementAdapter` (row above), so the interchangeability claim now has two live rails, not one. **Not yet an obligation path:** no route or kernel code constructs the adapter |
| 9 Tempo | "A Mitra obligation can target Tempo settlement through the same abstract interface." | `TESTED` | `PARTIAL` — `TempoSettlementAdapter` + `ModeratoTransport` settle live on Moderato through `SettlementAdapter` with the commitment on-chain as the memo (see the live row above). **Not yet an obligation path:** no route or kernel code constructs the adapter, so no Mitra obligation reaches it |
| 10 Tooling | "A pilot organization can operate the system without reading protocol logs." | `IMPLEMENTED` | `BLOCKED_INTERNAL` — console is a mockup; no accounting, webhooks, observability |

Phase 2 carries no `blocker` because `evidence` is `LIVE_DEMONSTRATED`. Phase 3's
`PROPOSED` is not a judgement about ambition — it records that no code exists.

### What is genuinely blocked, and on what

**Every remaining blocker is `BLOCKED_INTERNAL`. Not one is `BLOCKED_EXTERNAL`.**

All three chains are funded and reachable, the Solana toolchain builds and deploys,
the program is live on devnet, and the local kernel is green. Phases 3–10 are
**unbuilt, not blocked by the world** — which is what the `blocker` column now
states outright rather than leaving to prose.

That distinction was previously inexpressible. Under the old single status it
collapsed into `PARTIAL`, which is exactly the ambiguity this audit was asked to
resolve and could not.

### The honest sequencing finding

Phase 2 is the last phase whose exit condition is satisfiable with what exists.
Phase 3 (authority) is the next one, and it is the phase that decides whether
Mitra's central claim is enforceable rather than merely modelled: "an `ALLOW` is
never permission to move value" is already proven *on-chain* for the vault, but
there is no signer abstraction or out-of-policy path to prove it against.

Phases 8 and 9 are the reverse — both environments are fully funded and verified
(F15, F16, the Moderato funding) and neither has a line of adapter code.

---

## Claims deliberately NOT made

Recorded so a later reader does not assume silence means proof.

| Not claimed | Why |
|---|---|
| Any testnet or mainnet execution | No on-chain program exists |
| **Tempo balance semantics** | `eth_getBalance` returns a constant placeholder, not a balance — F12. Re-verified live for F40 by comparing `owner` against `0xdead`: byte-identical. TIP-20 `balanceOf` via `eth_call` was observed to *revert* on Moderato (the mint's `eth_getCode` is the one-byte predeploy stub `0xef`); only the Tempo API balances route is confirmed working. No Mitra code reads Tempo balances yet. |
| **Tempo native value** | Native value transfers are **refused** by the chain — `eth_sendRawTransaction` with `value: 1` returns `"value transfer not allowed"`. F40. So Tempo cannot pay in its native unit at all; settlement is TIP-20 only. |
| **Tempo transfer fees** | A TIP-20 transfer levies a fee **in the transferred token**, separate from gas: a self-transfer of 1.000000 PathUSD emitted 0.000032 to `0xfeec…0000`. F40. Consequence for evidence: payment confirmation must come from decoded `Transfer` logs, **not** from a balance delta — a balance delta made a successful 1.000000 payment look like a failure. |
| Production custody | Capital is a Postgres row, not an enforced account |
| Confidential policy evaluation | `confidentialPolicy` is a type field with no enclave |
| Settlement | `UnconfiguredAdapterError` throws by design |
| Marketplace, A2A or x402 integration | Adapters are interfaces with a local stub |
| Vault withdrawal safety | Withdrawal exists at `mitra-vault/src/lib.rs:304` and is now tested — **but a frozen vault could be drained until F41**, because the handler did its arithmetic inline and skipped the `is_frozen()` check `reserve` enforces. Fixed in `Vault::withdraw`. Still not claimed: `invoke_signed` and genuine lamport ownership, which need a chain |
