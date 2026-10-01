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

## T7 — Testnet credentials and network reachability

```bash
node scripts/verify-dev-keys.mjs    # re-derives every address from the secret
node scripts/phase2-readiness.mjs   # preconditions as commands
```

| Claim | Status | Evidence |
|---|---|---|
| Solana devnet address derives from the stored ed25519 key | `VERIFIED` | `verify-dev-keys.mjs` re-derives via TweetNaCl and the 64-byte keypair format; exits non-zero on mismatch |
| EVM address derives from the stored secp256k1 key | `VERIFIED` | ECDH + keccak256, checked against the published scalar-1 vector `0x7E5F…5Bdf` |
| Solana devnet RPC reachable | `VERIFIED` | `getHealth` → `ok` |
| Base Sepolia RPC reachable | `VERIFIED` | `eth_blockNumber` → `0x2d5a00f` |
| Tempo Moderato reachable **and identified as testnet** | `VERIFIED` | `eth_chainId` → `0xa5bf` (42431). Negative case: against mainnet the script reports `chainId 4217 = TEMPO MAINNET — refusing to treat production as a testnet` |
| Addresses are funded | `PARTIAL` | No funds claimed. Requires a human at a browser faucet — Solana devnet, Base Sepolia, and Tempo Moderato (no programmatic faucet endpoint; `POST /v1/faucet` → `not_found`) |
| Vault can read a Tempo balance | `UNTESTED` | `eth_call balanceOf` reverted on both faucet tokens while `eth_getCode` returned `0xef`. The Tempo API balances route is the only one observed working. Unresolved — see F12 |

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

## Claims deliberately NOT made

Recorded so a later reader does not assume silence means proof.

| Not claimed | Why |
|---|---|
| Any testnet or mainnet execution | No on-chain program exists |
| **Tempo balance semantics** | `eth_getBalance` returns a constant placeholder, not a balance — F12. TIP-20 `balanceOf` via `eth_call` was observed to *revert* on Moderato; only the Tempo API balances route is confirmed working. No Mitra code reads Tempo balances yet. |
| Production custody | Capital is a Postgres row, not an enforced account |
| Confidential policy evaluation | `confidentialPolicy` is a type field with no enclave |
| Settlement | `UnconfiguredAdapterError` throws by design |
| Marketplace, A2A or x402 integration | Adapters are interfaces with a local stub |
| Vault withdrawal safety | No withdrawal path exists, so nothing is proven either way |
