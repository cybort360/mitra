# Contracts

Two MitraVault sources live here. **They are not duplicates.** The addresses below
are copied from `lib/evm/deployments.json` and were read back from the chain on
2026-10-12 (bytecode size and `PERMIT_TYPEHASH()`). Quote addresses only from that
file and from chain receipts, never from a summary (F58).

## `contracts/MitraVault.sol` — CANONICAL, LIVE

What the engine's vault rail settles through (`lib/settlement/rails.ts` picks the
chain's non-`__` entry in `deployments.json`).

| Network | Address | Chain ID | Revision |
|---|---|---|---|
| Base Sepolia | `0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489` | 84532 | F61 |
| Tempo Moderato | `0x85409dfc30fa0671b06f98cc56c5b04eb921b568` | 42431 | F61 |

On both: 8,816 bytes of code, and `PERMIT_TYPEHASH()` returns
`0xcae3f4fbf2f6d96ea9b2c34236eaafd63d622d4a5e7c33f861c116f33cff1a88`, the keccak256 of
this file's typehash string. Mandates are keyed `[principal][holder][token]`.

Covered by `contracts/test/MitraVault.t.sol` and `contracts/test/MitraVaultTokenScope.t.sol`.

**The header comment in `MitraVault.sol` names the wrong addresses** (`0x6a731a65…`,
`0x19b3c58d…`, typehash `0xec3317dd…`). This table is right; the header is stale. It
cannot be corrected in place: comments are part of the source the compiler hashes into
the bytecode's metadata, and the deployed code at both addresses matches this file
exactly as it stands (checked 2026-10-12, immutables masked, metadata included). A
corrected header would compile to different bytecode, so the source would no longer
reproduce what is deployed. Fix the header together with the next redeploy (F106).

## `contracts/src/MitraVault.sol` — VARIANT

Purple's sprint candidate. Deployed only as `__callerVariant` entries, which the
engine never selects:

| Network | Address | Typehash |
|---|---|---|
| Base Sepolia | `0x78b82802ad2da2dc136a5c03eabd8c4fefa265cf` | `0xbbe5e5c6…` |
| Tempo Moderato | `0xfadc63a689a7ce2e0af4e772f3216994643c8d24` | `0xbbe5e5c6…` |

| | canonical | variant |
|---|---|---|
| permit | `SpendPermit(principal, holder, token, bytes32 actionHash, uint256 amount, recipient, uint32 mandateVersion, uint64 deadline)` | the same fields with `uint64 mandateVersion` |
| mandates keyed by | `[principal][holder][token]` | `[principal][holder]` |
| typehash | `0xcae3f4fb…` | `0xbbe5e5c6…` |

Because the typehash differs, a permit signed for one is refused by the other.

Covered by `contracts/test/MitraVaultCallerVariant.t.sol` (19 tests).

## Earlier deployments (not this source)

Kept so old evidence stays traceable. None is used by the engine.

| Address | Network | What the chain says | Where it appears |
|---|---|---|---|
| `0x6a731a654423d64afb9839742c3e48c6c54eea9c` | Base Sepolia | 8,593 bytes, typehash `0xec3317dd…` (an earlier permit scheme) | Phase 6 saga showcase; test fixtures |
| `0x19b3c58d85114bcc9451cff83e9c09c10986fcb0` | Tempo Moderato | 8,593 bytes, typehash `0xec3317dd…` | earlier header of `MitraVault.sol` |
| `0xaa46c23adefed6687cb2180d8a14cf88c6688ee6` | Tempo Moderato | 8,701 bytes, typehash `0xcae3f4fb…` (pre-F61 mandate keying) | `forge/PROOF_LEDGER.md` |
| `0xbd78e40b…`, `0x81798c6f…` | Base, Tempo | pre-F61 (F63) | `deployments.json` `vaultSuperseded` |

## Why both sources are kept

Anyone auditing a deployed address must find the source that produced it, and a
variant still in the tree should not go untested merely because it lost a merge.
Adopting the variant means re-deploying and re-running every live proof; that is a
product decision, not a merge decision.

## Build

```bash
~/.local/bin/forge test    # all suites
```
