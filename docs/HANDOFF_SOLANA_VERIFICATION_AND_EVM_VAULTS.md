# Engineering Handoff: Solana Verification & EVM Vault Deployments

**Target Audience:** Autonomous Coding Agent / Co-Developer  
**Target Repository:** `mitra`  
**Current Active Branch:** `fix/integrity-f40-f45`  
**Related Specifications:** `docs/product/MITRA_PRD.md` (§34, §35, §50, §52), `forge/INVARIANTS.md`, `forge/PROOF_LEDGER.md`, `docs/adr/0007-phase2-builds-a-real-solana-program.md`, `docs/adr/0009-mandate-semantics-reuse-engraving.md`

---

## 1. Ground Rules & Invariants (Non-Negotiable)

1. **Repository files are the source of truth** (`AGENTS.md`). Prior chat summaries are not authoritative.
2. **The Invariant to Protect**:  
   $$\text{HOW MUCH MAY I SPEND} \longrightarrow \text{WHO AUTHORIZED IT} \longrightarrow \text{MAY THIS EXACT INSTRUCTION MOVE CAPITAL}$$
   *An `ALLOW` decision is never permission to move value.* The on-chain contract independently re-derives whether *this exact instruction* may move capital.
3. **No Mocks in Production Paths**: Transports must interact with real nodes or test suites asserting real byte-level decoding.
4. **Evidence Discipline**: When executed on live networks, record transaction hashes and verification proofs in [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md) and announce in shared-context MCP via `node shared-context-mcp/dist/cli.js say`.

---

## 2. Work Package A: Solana Program Explorer Verification & `security.txt`

### Objective
Embed official `security.txt` metadata directly into the Solana program binary [`programs/mitra-vault`](programs/mitra-vault/), recompile the SBF ELF, upgrade the deployed devnet program, and publish verifiable build proofs for block explorers (SolanaFM, Solana Explorer, OtterSec).

### Current State
- **Deployed Program ID**: `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` (Solana Devnet).
- **ProgramData Account**: `9aUb2ZozqkBsxQwBn59GWWHeJL5kvFXXQAgbK2eLXKon`.
- **Authority / Payer Key**: `.dev-keys/solana-testnet.json` (holds >4 SOL on devnet).
- **Rust Toolchain**: `cargo-build-sbf` (Agave / Anza CLI installed and active).

### Step-by-Step Instructions

#### A.1. Update `programs/mitra-vault/Cargo.toml`
Add the `solana-security-txt` crate dependency:
```toml
[dependencies]
solana-program = { version = "2.3", features = ["borsh"] }
solana-security-txt = "1.1"
```

#### A.2. Embed `security_txt!` Macro in `programs/mitra-vault/src/lib.rs`
Near the top of [`programs/mitra-vault/src/lib.rs`](programs/mitra-vault/src/lib.rs), add the security descriptor:
```rust
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "mitra-vault",
    project_url: "https://mitra.network",
    contacts: "email:security@mitra.network",
    policy: "https://github.com/cybort360/mitra/blob/main/docs/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/cybort360/mitra",
    auditors: "Pending Independent Audit"
}
```

#### A.3. Recompile SBF Binary
In `programs/mitra-vault`:
```bash
cargo test
cargo-build-sbf
```
*Verification Check:* Ensure `cargo test` passes 104/104 tests (including `tests/golden_layout.rs`). Inspect binary with `readelf -p .security.txt target/sbpfv3-solana-solana/release/mitra_vault.so` or `strings target/deploy/mitra_vault.so | grep -i "security@mitra.network"`.

#### A.4. Upgrade Solana Devnet Program
Deploy the updated `.so` buffer using the upgrade authority key:
```bash
solana program upgrade \
  target/deploy/mitra_vault.so \
  GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY \
  --keypair .dev-keys/solana-testnet.json \
  --url https://api.devnet.solana.com
```

#### A.5. Verify on Explorers
1. View `https://solana.fm/address/GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY?cluster=devnet` and check the **Security** tab for parsed `security.txt` fields.
2. Run the live transport test to confirm zero regressions:
   ```bash
   SOLANA_LIVE=1 npx vitest run tests/solana-transport.test.ts
   ```

---

## 3. Work Package B: EVM Origination & Escrow Contracts (`MitraVault.sol`)

### Objective
Allow agents to originate capital and hold on-chain vaults directly on **Base Sepolia** and **Tempo Moderato**, rather than treating EVM solely as an outbound settlement rail.

### Target Environments
| Parameter | Base Sepolia | Tempo Moderato |
|---|---|---|
| **Chain ID** | `84532` | `42431` |
| **RPC URL** | `https://sepolia.base.org` | `https://rpc.moderato.tempo.xyz` |
| **Settlement Asset** | Circle USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) | PathUSD TIP-20 (`0x20c0000000000000000000000000000000000001`) |
| **Decimals** | 6 | 6 |
| **Deployer Key** | `.dev-keys/evm-testnet.json` (funded on both chains) | `.dev-keys/evm-testnet.json` |

### Architectural Requirements for `contracts/MitraVault.sol`

The contract must implement the EVM equivalent of `programs/mitra-vault`, upholding ADR-0002 (positional balances), ADR-0009 (mandate semantics), and PRD §15 (escrow / saga recovery):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract MitraVault is EIP712 {
    using SafeERC20 for IERC20;

    struct Mandate {
        address holder;
        uint64 limit;       // max spend per transaction (atomic units)
        uint64 ceiling;     // cumulative ceiling
        uint64 expiresAt;   // unix timestamp
        address policyEngine;
        bool revoked;
    }

    struct VaultPositions {
        uint256 total;
        uint256 available;
        uint256 reserved;
        uint256 escrowed;
        bool frozen;
    }

    // EIP-712 TypeHash
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "SpendPermit(address vault,address holder,bytes32 actionHash,uint64 amount,address recipient,uint64 deadline)"
    );

    // Mappings:
    // principal => token => VaultPositions
    mapping(address => mapping(address => VaultPositions)) public vaults;
    // holder => Mandate
    mapping(address => Mandate) public mandates;
    // actionHash => consumed
    mapping(bytes32 => bool) public consumedPermits;

    event MandateOpened(address indexed principal, address indexed holder, uint64 limit, uint64 expiresAt, address policyEngine);
    event MandateRevoked(address indexed caller, address indexed holder);
    event VaultFrozen(address indexed principal, address indexed token);
    event VaultUnfrozen(address indexed principal, address indexed token);
    event SpendExecuted(address indexed principal, address indexed recipient, address token, uint64 amount, bytes32 indexed actionHash);
    event EscrowLocked(bytes32 indexed jobId, address indexed client, address indexed provider, address token, uint256 amount);
    event EscrowReleased(bytes32 indexed jobId, address indexed to, uint256 amount);

    constructor() EIP712("MitraVault", "1") {}

    // 1. Vault Management: deposit, withdraw, freeze
    // 2. Mandate Management: openMandate, amendMandate, revokeMandate
    // 3. Guarded Spend: spendAuthorized(SpendPermit, signature)
    // 4. Commercial Escrow / Sagas: lockEscrow, releaseEscrow, refundEscrow
}
```

### Core Security & Execution Rules
1. **Guarded Spend via EIP-712**:
   - The caller presents `SpendPermit { vault, holder, actionHash, amount, recipient, deadline }` signed by `mandate.policyEngine`.
   - Contract recovers signer via `ECDSA.recover`. Signer MUST equal `mandate.policyEngine`.
   - Contract asserts `block.timestamp <= deadline`.
   - Contract asserts `amount <= mandate.limit`.
   - Contract asserts `!mandate.revoked && block.timestamp < mandate.expiresAt`.
   - Contract asserts `!consumedPermits[actionHash]`. Marks `consumedPermits[actionHash] = true`.
   - Transfers ERC-20 from `vault` to `recipient`.
2. **Commercial Escrow (ERC-8183 Compatibility)**:
   - `lockEscrow(jobId, provider, token, amount, timeout)`: moves funds from `available` $\to$ `escrowed`.
   - `releaseEscrow(jobId)`: client releases funds to provider upon deliverable acceptance.
   - `refundEscrow(jobId)`: client refunds funds if provider fails, timeout expires, or deliverable is rejected (TALOS recovery leg).
3. **Freeze & Revocation**:
   - The principal can freeze their vault at any time (`vault.frozen = true`), halting all spends and new reservations.

### Step-by-Step Deployment Instructions

#### B.1. Setup Contracts Directory & Tests
Create `contracts/MitraVault.sol` and test suite `tests/evm-vault.test.ts` (using viem or hardhat/foundry).
- Unit tests must prove:
  1. Mandate creation, versioning, and revocation.
  2. Single-use permit spend with EIP-712 signature verification.
  3. Refusal of replayed permits (`ALREADY_CONSUMED`).
  4. Refusal of unauthorized engine signatures.
  5. Refusal of spends from frozen vaults or amounts exceeding mandate limits.
  6. Escrow lock, deliverable release, and timelocked saga refund.

#### B.2. Deploy to Base Sepolia
Write deployment script `scripts/deploy-base-vault.mjs`:
```bash
node scripts/deploy-base-vault.mjs
```
- Deploy `MitraVault.sol` to Base Sepolia (84532).
- Output contract address and save to `lib/evm/deployments.json`.
- Verify on Basescan:
  ```bash
  npx hardhat verify --network baseSepolia <DEPLOYED_ADDRESS>
  # OR using foundry:
  forge verify-contract --chain 84532 <DEPLOYED_ADDRESS> contracts/MitraVault.sol:MitraVault
  ```

#### B.3. Deploy to Tempo Moderato
Write deployment script `scripts/deploy-tempo-vault.mjs`:
```bash
node scripts/deploy-tempo-vault.mjs
```
- Deploy `MitraVault.sol` to Tempo Moderato (42431).
- Save deployment address to `lib/evm/deployments.json`.

#### B.4. Wire Adapters
- In [`lib/adapters/base-transport.ts`](lib/adapters/base-transport.ts) and [`lib/adapters/tempo-transport.ts`](lib/adapters/tempo-transport.ts), add methods for `deposit`, `openMandate`, and `spendAuthorized` targeting the deployed EVM vault contracts.
- Run live test suites with `BASE_VAULT_LIVE=1` and `TEMPO_VAULT_LIVE=1`.

---

## 4. Completion Checklist & Handoff Signoff

Before marking done:
- [ ] `cargo test` in `programs/mitra-vault` passes 104/104.
- [ ] Program upgraded on Solana devnet; `security.txt` visible on SolanaFM devnet.
- [ ] `MitraVault.sol` deployed and verified on Base Sepolia.
- [ ] `MitraVault.sol` deployed on Tempo Moderato.
- [ ] `npm test` passes all test suites (zero regressions).
- [ ] `npx tsc --noEmit` clean (zero errors).
- [ ] Deployment addresses and transaction hashes recorded in [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md).
- [ ] Run `node shared-context-mcp/dist/cli.js say` and `node shared-context-mcp/dist/cli.js sync` to notify peer agents.
