# Solana Substrate: Anchor PDAs, Vaults & Program State

> *"Sub-cent fees and microsecond settlement make Solana an ideal substrate for high-frequency agentic coordination."*  
> — [`programs/mitra-vault/Cargo.toml`](../../programs/mitra-vault/Cargo.toml) · [ADR-0007: Phase 2 Builds a Real Solana Program](../adr/0007-phase2-builds-a-real-solana-program.md)

On the Solana blockchain, Mitra deploys a native on-chain program written in Rust using the Anchor framework ([`programs/mitra-vault`](../../programs/mitra-vault)). It serves as an on-chain capital boundary enforcing vault reserves, mandate ceilings, and DvP escrows through Program Derived Addresses (PDAs).

---

## 1. Solana Architecture & Program Derived Addresses (PDAs)

Mitra leverages Solana's PDA derivation model to guarantee deterministic, un-forgeable account addressing without storing private keys:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SOLANA PDA DERIVATION MAP                                 │
│                                                                                        │
│  [TREASURY VAULT PDA]                                                                  │
│  Seeds: [b"vault", authority.key().as_ref(), vault_id.as_ref()]                        │
│  Holds principal deposits, tracks total headroom and pause state.                      │
│                                │                                                       │
│                                ▼                                                       │
│  [MANDATE PDA (ENGRAVING)]                                                             │
│  Seeds: [b"mandate", vault_pda.key().as_ref(), agent_id.as_ref()]                      │
│  Holds agent spending ceiling, remaining headroom, and allowed capability hash.        │
│                                │                                                       │
│                                ▼                                                       │
│  [AGREEMENT ESCROW PDA]                                                                │
│  Seeds: [b"agreement", agreement_id.as_ref()]                                          │
│  Holds locked funds during DvP execution until released or refunded by the program.    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. On-Chain Program Invariants

The `mitra-vault` program enforces four core invariants in Rust:

1. **Non-Custodial Boundary:** Funds deposited into a Vault PDA can only be disbursed by instructions presenting a valid execution guard proof or explicit principal withdrawal.
2. **Atomic Headroom Decrement:** When an agreement PDA is funded from a mandate, the mandate's on-chain headroom decrements in the exact same transaction.
3. **Embedded Security Disclosure (`security.txt`):** Built with `solana-security-txt` v1.1.0 embedded directly in the ELF binary, enabling block explorers (SolanaFM, OtterSec, Solana Explorer) to display verified security contacts.
4. **147 Verified Program Tests:** Validated with 147 comprehensive Rust unit tests (`cargo test --manifest-path programs/mitra-vault/Cargo.toml`).

---

## 3. Rust Program State Example

The following account structures define the on-chain state:

```rust
use anchor_lang::prelude::*;

#[account]
pub struct VaultAccount {
    pub authority: Pubkey,        // Principal owner
    pub vault_id: [u8; 32],       // Vault identifier
    pub total_deposited: u64,     // Total token balance
    pub reserved_headroom: u64,   // Committed headroom
    pub bump: u8,
}

#[account]
pub struct MandateAccount {
    pub vault: Pubkey,            // Backing vault PDA
    pub agent_id: [u8; 32],       // Authorized agent
    pub total_budget: u64,        // Maximum spend limit
    pub available_headroom: u64,  // Remaining spendable
    pub max_transaction: u64,     // Single-tx cap
    pub expires_at: i64,          // Expiration timestamp
    pub bump: u8,
}

#[account]
pub struct AgreementEscrowAccount {
    pub agreement_id: [u8; 32],
    pub client: Pubkey,
    pub provider: Pubkey,
    pub evaluator: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub status: u8, // 0: Open, 1: Funded, 2: Executing, 3: Submitted, 4: Accepted, 5: Refunded
    pub bump: u8,
}
```

---

## 4. Live Solana Devnet Proof

Mitra's Solana deployment is live on Solana Devnet:
- **Recorded Proof:** Verified settlement transaction recorded in [`forge/PROOF_LEDGER.md`](../../forge/PROOF_LEDGER.md) (`jW14aBAb…HWZ`).
- **RPC Validation:** Checked live in under 200ms using `npm run doctor`.

---

## Next Steps

- Explore EVM compatibility in [Base Substrate: ERC-8183 Escrows](./13-base-substrate.md).
- Examine high-frequency streaming in [Tempo Substrate: TIP-20](./14-tempo-substrate.md).
