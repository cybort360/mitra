# Mitra Co-Developer Handoff Specification
## Multi-Rail Settlement Transports & Live Infrastructure

---

### Scope & Division of Labor

> [!NOTE]
> **Showcase Division:** **Project Prometheus** (Commercial Agreement lifecycle, guarded spend, TALOS saga recovery) and **Project Pando** (Bilateral obligation collection, deterministic conservation netting, epoch clearing) are being handled directly by the lead developer and are **NOT** part of this handoff.

This handoff covers the **Settlement & Live Transport Infrastructure** (PRD Phases 8 & 9 and on-chain adapter integration):
1. **Base Sepolia Live Transport** (`lib/adapters/base.ts` — EIP-712, ERC-1271, ERC-4337 UserOps)
2. **Tempo Moderato Live Transport** (`lib/adapters/tempo.ts` — TIP-20 transfers & MPP)
3. **Solana Devnet Settlement Binding** (`lib/adapters/solana.ts` — `programs/mitra-vault` on-chain interaction)

---

### Status Baseline (Current Head: `fix/integrity-f40-f45`)

* **Tests:** 497 TS tests passing (37 files passed, 3 persistence files self-skip cleanly offline), 88 Rust tests passing in `programs/mitra-vault`. Zero RPC flakes.
* **TypeScript:** `npm run typecheck` (`tsc --noEmit`) passes with 0 errors.
* **PRD §4.5 Discharged:** Failure is a state transition, not an exception (`lib/kernel/commerce-recovery.ts` and `app/api/v1/sagas/route.ts`).

---

## Assigned Work: Multi-Rail Settlement Transports

### 1. Base Sepolia Transport Driver (`lib/adapters/base.ts`)

#### Objective
Currently, `BaseSettlementAdapter` throws `UnconfiguredAdapterError` when no transport is provided. This task connects live Base Sepolia execution.

#### Canonical RPC & Environment
* **RPC Endpoint:** `https://sepolia.base.org` (or Coinbase Developer Platform / Alchemy Base Sepolia)
* **Chain ID:** `84532`

#### Implementation Steps
1. In [`lib/adapters/base.ts`](../lib/adapters/base.ts), implement a concrete `BaseTransport` using `viem`:
   - `sendUserOp(userOp)`: Packages and submits the UserOperation envelope with the EIP-712 structured mandate authorization hash.
   - `verify1271(walletAddress, digest, signature)`: Validates smart contract wallet signatures via ERC-1271 `isValidSignature(bytes32,bytes)`.
2. Guard against false execution: Never return a fabricated transaction hash. If transport fails or is unconfigured, throw `UnconfiguredAdapterError`.
3. Gate live network probes under `process.env.BASE_LIVE === "1"`.

---

### 2. Tempo Moderato Transport Driver (`lib/adapters/tempo.ts`)

#### Objective
Currently, `TempoSettlementAdapter` provides domain definitions, TIP-20 currency discovery, and MPP metadata formatting, but throws `UnconfiguredAdapterError` on `settle()` without a transport.

#### Canonical RPC & Environment
* **RPC Endpoint:** `https://rpc.moderato.tempo.xyz`
* **Chain ID:** `42431`

#### Critical Guards (from `FAILURES.md`)
* **F12 & F40 Guard:** `eth_getBalance` returns a constant dummy placeholder (`0xa5bf`) on Moderato, not an actual balance. Native value transfers are explicitly refused by the node (`value transfer not allowed`). **Settlement must occur strictly in TIP-20 tokens via contract calls.**
* **Rate-Limit Guard:** Moderato testnet returns `-32002` ("Resource temporarily unavailable") during bursts. All JSON-RPC requests must use exponential backoff retry (up to 3 attempts with $500\text{ms} \times 2^n$ delay), matching [`scripts/fund-tempo.mjs`](../scripts/fund-tempo.mjs).
* **Payment Confirmation:** Payment verification must be derived from decoded `Transfer` event logs matching the target address and token mint, **never** from balance deltas (which miss transfers due to TIP-20 transfer fee deductions).
* Gate live network probes under `process.env.TEMPO_LIVE === "1"`.

---

### 3. Solana Devnet Settlement Binding (`lib/adapters/solana.ts`)

#### Objective
Wire `SolanaSettlementAdapter` to interact directly with the deployed `programs/mitra-vault` on Solana devnet (`GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY`).

#### Implementation Steps
1. Use `@solana/web3.js` with Helius Devnet RPC (or configured `SOLANA_RPC_URL`).
2. Implement instruction dispatch for `withdraw` and `settle` binding against the vault PDA.
3. Assert exact amounts and single-use permit consumption.

---

## Status — 2026-10-03 (human:purple / agent:claude-purple)

Each line is backed by `forge/PROOF_LEDGER.md`; shared context seq 48–58 has the reasoning.

| Item | State | Where |
|---|---|---|
| 1. Base — concrete transport (viem) | ✅ **Live** on Base Sepolia, 0.01 USDC; EOA path | `lib/adapters/base-transport.ts`, `BASE_LIVE=1` |
| 1. Base — no fabricated hash / unconfigured throws | ✅ mutation-tested | `tests/base-transport.test.ts` |
| 1. Base — `sendUserOp` (ERC-4337) | ✅ **Done 2026-10-03, sprint item 3** (see the sprint plan below). ~~❌ **Not done.** Envelope exists (`lib/evm/erc4337.ts`), `scripts/base-4337.mjs` acts as its own bundler, but neither is wired through the transport and the script has no live ledger row. Production Phase 8 is ERC-4337 (seq 55)~~ | `lib/adapters/base-4337-transport.ts` |
| 1. Base — `verify1271` (ERC-1271) | ✅ **Done 2026-10-03, sprint item 3.** ~~❌ **Not done.** `SignatureVerifier` interface exists in `lib/evm/eip712.ts`; no implementation calls `isValidSignature` on chain~~ | `lib/evm/erc1271.ts` |
| 2. Tempo — transport, TIP-20 only, `-32002` backoff, log-derived confirmation | ✅ **Live** on Moderato, commitment on chain as the `transferWithMemo` memo | `lib/adapters/tempo-transport.ts`, `TEMPO_LIVE=1` |
| 3. Solana — bind adapter to `mitra-vault` | ✅ **Live** on devnet against the F51 redeploy; `authorize`+`spend_authorized` in one tx | `lib/adapters/solana-transport.ts`, `lib/solana/vault-program.ts`, `SOLANA_LIVE=1` |
| 3. Solana — "dispatch for `withdraw`" | ⚠️ **Deliberately not bound.** `withdraw` returns capital to the principal; it is not a settlement. Settlement is `spend_authorized` | — |

**Found and fixed along the way:** F51 (any signer could drain any vault — fixed, redeployed, refusal `6015` observed live); Base USDC registry held the mainnet address on Sepolia; Base commitments signed whole units and threw on fractions; the Solana adapter listed a mainnet SPL mint and used a 32-bit FNV commitment; `fund-tempo.mjs` crashed on a fresh address; `npm ci` failed on an out-of-sync lockfile.

**Still open, outside the three items:**
- **No caller.** No route or kernel code constructs a settlement adapter, so phases 8/9 stay `PARTIAL`. Unblocked by the lead's answers (seq 55): settle only from `ACCEPTED`; testnet signs with the relayer key.
- **`getEvidence()` returns `null` on all three rails** (PRD §21.4). Live transactions now exist to build bundles from.
- **Mandate PDA reseed** to `[b"mandate", principal, holder]` — approved (seq 55), not implemented; needs a program change and redeploy.
- ~~`scripts/authority-devnet.mjs` encodes the pre-F51 layouts~~ — **done by the lead** in `02f6774` on `fix/integrity-f40-f45`. `lib/solana/vault-program.ts` (pinned to the Rust golden bytes) remains available if the harness ever drifts.
- **`context audit` fails at seq 29** — a lead entry damaged at write time (shell backticks); identical in every bundle, not tampering.
- **Live-network tests can time out**: `tests/dev-scripts.test.ts` hit 30s+ RPC timeouts in one run. The "zero flakes" baseline above holds only on a good network day.

---

## Sprint plan — 2026-10-03 (human:purple / agent:claude-purple)

Scope is assembled from four sources, each checked against the code on
`feat/solana-settlement-binding` @ `17b5b4c`: items 1–3 above; the lead's seq 60
("Console dashboards (Phase 10) and live MCP server (Phase 5)");
[`HANDOFF_SOLANA_VERIFICATION_AND_EVM_VAULTS.md`](HANDOFF_SOLANA_VERIFICATION_AND_EVM_VAULTS.md)
(`9aa644c`, packages A and B); and a four-package list received out of band.

### Order of work

| # | Item | Why it is open (what the code shows) |
|---|---|---|
| 1 | ✅ **Settlement caller** — a Mitra obligation reaches a `SettlementAdapter` | **Done on `feat/settlement-caller`; live on Base Sepolia** (PROOF_LEDGER, tx `0x65c481e9…`). `POST /api/v1/settlements` pays an `ACCEPTED` agreement to its `payTo` term; the execution guard re-runs against a digest re-derived from the agreement; one settlement per agreement by primary key; a transport error leaves it `PENDING` (never retried blind). Also fixed F52 (Postgres dropped every agreement write). Still open: vault capital not drawn down; Tempo/Solana via this path not shown live |
| 2 | ✅ **`getEvidence()`** on Base, Tempo, Solana (PRD §21.4) | **Done; live-verified on all three rails** (PROOF_LEDGER). Bundles are built from what `observe()` reads back from the chain, never from the record's status; `GET /api/v1/settlements/evidence`; SettlementReceipts hash-chained per run. Open: receipts unsigned (F53) |
| 3 | ✅ **Base: `sendUserOp` (ERC-4337) through the transport, and an on-chain ERC-1271 `SignatureVerifier`** | **Done; live on Base Sepolia** (PROOF_LEDGER, handleOps tx `0xd3c11453…`). `lib/adapters/base-4337-transport.ts` (Coinbase Smart Wallet v1, EntryPoint v0.6, relayer submits `handleOps`; confirmation requires `UserOperationEvent.success`), `lib/evm/erc1271.ts` (ERC-1271 + ERC-6492). Found F54: the old 4337 envelope hash and `base-4337.mjs` could not reach an EntryPoint |
| 4 | ✅ **Live MCP server** (Phase 5) over the 18 tools in `lib/mcp/surface.ts`, plus an HTTP x402 gateway | **Done.** MCP: 9 served (stdio, thin client of the API), 3 withheld until the API identifies callers (F55, decided by human:purple), 6 unbacked. x402: live via the public facilitator (PROOF_LEDGER). — Original note: | No transport serves the tools. `lib/evm/payment.ts` models the challenge; a 402 still requires a reservation and never authorises a spend |
| 5 | **Console** (Phase 10) on real data, live stream from `mitra.event_log` | All 15 data pages import `lib/store/seed`; no SSE/WebSocket route exists |
| 6 | **`MitraVault.sol`** (lead's package B) | Not started. Foundry is installed. See correction below |
| 7 | **`security.txt` + mandate PDA reseed in one redeploy** (lead's package A + seq 55) | Code is ours; the SBF build and `program upgrade` are the lead's (see correction below) |

**For the lead:** Arcium / `FR-VAULT-008/009` (Phase 3) — not assigned in seq 60, and no
Arcium source exists on any branch (F44 names `arcium-probe/`, which is not in the
repository); the `context audit` break at seq 29.

### Corrections to the incoming scope

- **Base/Tempo "throw `UnconfiguredAdapterError`"** — only without a transport. Both
  transports exist and settled live (PROOF_LEDGER). TIP-20 execution and MPP are built.
- **ERC-8004 "verify agent identity"** — contradicts the lead's recorded decision: the
  registry is projected *outward*; an inbound registry verdict is never proof of identity
  and may influence only discovery ranking.
- **"The Arcium Anchor program compiles"** — F44 says the program is "genuinely
  unwritten", and no Arcium source is in the repository. `EXECUTION_PLAN.md` row 3
  ("rewritten and compiles") is unsupported by anything in the tree.
- **Package A upgrade key** — the doc names `.dev-keys/solana-testnet.json`
  (`ETjm3HV8…`). The on-chain upgrade authority of `GkQQtmVX…` (ProgramData
  `9aUb2Zoz…`, read 2026-10-03) is `C4ZoTdNS…`, the lead's key.
- **Package B `mapping(address => Mandate) mandates`** — keyed by holder alone, so a
  mandate names no principal or vault. That is F51's root cause and the squatter DoS the
  lead approved fixing (seq 55). The EVM vault will key mandates by `(principal, holder)`
  and bind the vault and recipient into the permit.

---

### Working Agreement & Commands for the Co-Developer

```bash
# 1. Pull latest and review context digest
git pull origin fix/integrity-f40-f45
node shared-context-mcp/dist/cli.js digest

# 2. Check baseline health before starting
npm run typecheck
npm test
cargo test -p mitra-vault

# 3. Announce start of work in shared context
node shared-context-mcp/dist/cli.js say \
  --kind progress \
  --title "Starting Base Sepolia / Tempo transport drivers" \
  --scope "settlement"

# 4. Verify live adapter tests (when configured)
BASE_LIVE=1 npx vitest run tests/settlement-adapters.test.ts
TEMPO_LIVE=1 npx vitest run tests/tempo-adapter.test.ts

# 5. Commit and audit
node shared-context-mcp/dist/cli.js audit
```
