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
