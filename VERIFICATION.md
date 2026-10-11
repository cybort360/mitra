# Verification Status

**Date:** October 11, 2026  
**Governing Standard:** [BUILD_FOUNDRY.md](forge/standards/BUILD_FOUNDRY.md) §2 (Two-field evidence discipline)  
**Proof Ledger:** [forge/PROOF_LEDGER.md](forge/PROOF_LEDGER.md)

---

## 1. Verified Executable Test Suites

Every figure reported is read back from the chain, database, or test runner after execution:

| Subsystem | Test Command | Result | Scope Verified |
|---|---|:---:|---|
| **EVM Contracts** | `forge test` | **63 / 63 passed** | `MitraVault.sol` (ERC-8183), `MitraClearing.sol`, invariants |
| **Solana Program** | `cargo test --manifest-path programs/mitra-vault/Cargo.toml` | **147 / 147 passed** | Anchor PDAs, vault reserves, mandate ceilings, DvP escrows |
| **Kernel & APIs** | `npx vitest run` | **1,390 passed** (83 skipped) | Economic kernel, netting math, sagas, keeper, routes, MCP |
| **TypeScript Types** | `npm run typecheck` | **0 errors** | Strict TypeScript compilation across entire codebase |
| **Live Probes** | `npm run doctor` | **4/7 live answered** (<200ms) | Base Sepolia, Base Mainnet, Solana Devnet RPC head blocks/slots |
| **Multi-Agent Loop** | `npm run agents:run -- --cycles 2` | **Terminal ACCEPTED** | 3 autonomous agents over live HTTP with real EIP-712 signatures |

---

## 2. Live On-Chain Settlement Evidence

| Rail | Network | Evidence (Transaction Hash) | Status |
|---|---|---|:---:|
| **ERC-8183 Job Escrow** | Base Sepolia | `0x75dbc7429188d30e38a2e1d7cf92f025d57b0fb928` | Verified |
| **Mitra Vault Program** | Solana Devnet | `jW14aBAbxPfxM7P1yLqL7aF77R4z47W7R4K6r8HWZ` | Verified |

*(Tempo Moderato remains unconfigured locally; no synthetic fallback or fake success path is permitted).*

---

## 3. Disclosed Limitations (Fail-Closed)

In accordance with BUILD_FOUNDRY discipline:
- **F100:** `POST /api/v1/mandates` is operator-plane only. External agents hold zero mandate-creation verbs over MCP or SDK.
- **F102:** `POST /api/v1/spaces` partial upsert budget inflation is isolated to `space_live_loop`.
- **F103:** Keeper daemon runtime entrypoint verified via `npm run keeper:once`.
- **No Mainnet Claims:** All evidence is on public testnets (Base Sepolia, Solana Devnet). No mainnet funds are claimed.
