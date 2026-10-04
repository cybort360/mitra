# Contracts

Two MitraVault contracts live here. **They are not duplicates**, and only one is
deployed.

## `contracts/MitraVault.sol` — CANONICAL, LIVE

The contract deployed on two public testnets:

| Network | Address | Chain ID |
|---|---|---|
| Base Sepolia | `0x6a731a654423d64afb9839742c3e48c6c54eea9c` | 84532 |
| Tempo Moderato | `0xaa46c23adefed6687cb2180d8a14cf88c6688ee6` | 42431 |

Evidence for that mapping, verified by reading the chain rather than a log:

- both addresses carry 8,593 bytes of code;
- `PERMIT_TYPEHASH()` on both returns
  `0xcae3f4fbf2f6d96ea9b2c34236eaafd63d622d4a5e7c33f861c116f33cff1a88`, which is
  the keccak256 of this file's typehash string;
- the Phase 6 saga showcase (`lockEscrow` → `refundEscrow`) and the settlement
  caller both ran against these addresses.

Covered by `contracts/test/MitraVault.t.sol`.

## `contracts/src/MitraVault.sol` — VARIANT, NOT DEPLOYED

Purple's sprint candidate for the next permit generation. It differs
**structurally**, not cosmetically:

| | canonical | variant |
|---|---|---|
| permit | `SpendPermit(vault, holder, token, amount, recipient, settlementId, uint32 mandateVersion, uint64 deadline)` | `SpendPermit(principal, holder, token, bytes32 actionHash, uint256 amount, address recipient, uint64 mandateVersion, uint64 deadline)` |
| mandates keyed by | `holder` | `[principal][holder]` |
| typehash | `0xec3317dd…` | `0xbbe5e5c6…` |

Because the typehash differs, **the variant is a different contract** — not a
refactor of the deployed one. Nothing on chain corresponds to it.

Covered by `contracts/test/MitraVaultCallerVariant.t.sol` (19 tests).

## Why both are kept

The deployed evidence chain must stay reproducible: anyone auditing
`0x6a731a65…` must find the source that produced it. Equally, a variant still in
the tree should not be left untested merely because it lost a merge.

Adopting the variant means re-deploying and re-running every live proof, which
invalidates the Phase 6 and settlement-caller hashes currently in
`forge/PROOF_LEDGER.md`. That is a product decision, not a merge decision.

## Build

```bash
~/.local/bin/forge test    # both suites
```
