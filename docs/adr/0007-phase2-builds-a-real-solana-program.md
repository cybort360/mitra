# 0007. Phase 2 builds a real Solana program, not a controller stub

**Status:** Accepted

## Context

PRD §52 Phase 2 requires *"Real testnet/devnet vault creation, funding,
reservation, guarded spend, release/refund, and settlement proof."* PRD §34
assigns Solana the *capital boundary* — the "Mitra Vault Program" — and names it
as the primary settlement chain.

Two shapes were available:

1. **A controller/authority abstraction** in TypeScript: the vault logic lives in
   our kernel, and an on-chain account is the passive holder. Reaches a
   demonstrable devnet vault quickly, and every guarantee is still enforced
   locally.
2. **A real Anchor/Rust program** that holds capital and enforces the boundary
   itself.

Shape 1 is the smaller build and was the recommendation while the toolchain was
absent. That constraint is now gone, and re-deciding on stale grounds would be
the error this control plane exists to prevent.

What is now `VERIFIED`:

| Fact | Evidence |
|---|---|
| Solana CLI 4.3.0 (Agave) | Official Anza installer; `cluster-version` matches devnet |
| Our keyfile is valid | `solana-keygen pubkey` independently re-derives `C4ZoTdN…` |
| Devnet funding | **5 SOL**, `getSignaturesForAddress` → 1 signature, `err=None` |
| Rust → eBPF works | `cargo-build-sbf` produced a 15,464-byte **ELF64 eBPF** `.so` with a real `.text` section |

The last row is the decisive one. Before it, "can we build an on-chain program?"
was `UNTESTED`, and recommending the cheap shape was a reasonable response to a
missing toolchain. It is now answered.

## Decision

1. **Phase 2 builds a real Solana program** that holds capital and enforces the
   capital boundary on-chain. The PRD assigns that role to Solana specifically;
   building a stub elsewhere would satisfy the code without satisfying the
   design.
2. **The kernel stays chain-neutral** (PRD §21.3). The program is reached
   through an adapter, so nothing in `lib/kernel/` learns about Solana.
3. **The program's state model follows ADR-0002, not a state machine.** Capital
   is six independent positions — available, reserved, escrowed, encumbered,
   settling, frozen — and the on-chain guard is the reconciliation invariant
   that they sum to `total`. A `VaultStatus` field is explicitly rejected: a
   vault is routinely frozen *and* mid-settlement, and any single status forces
   the product to drop a combination it genuinely needs.
4. **An `ALLOW` is not permission to move value, on-chain either.** The
   execution guard re-derives whether *this exact instruction* may move capital.
   A program that trusts a caller-supplied "approved" flag has reproduced the
   central failure the whole product exists to prevent, just in Rust.

## Consequences

- The PRD exit condition becomes reachable rather than approximated. Only a
  deployed program satisfies "real devnet vault creation … and settlement
  proof" (ADR-0004).
- `phase2-readiness.mjs` requires `cargo-build-sbf` specifically, not a Solana
  version string. A machine that has the CLI but cannot compile a program must
  report BLOCKED, because that machine cannot satisfy the exit condition.
- Deployment consumes devnet SOL, which the CLI reports as rate-limited. So
  funding must be read back from the node after a claim rather than inferred
  from command output — the airdrop command reported errors and still succeeded.
- The program is the load-bearing artefact for the *capital boundary* only.
  Commerce, clearing, and recovery stay off-chain (PRD §34 assigns them
  elsewhere); this decision does not widen the on-chain surface.

## Alternatives considered

- **Controller/authority abstraction first.** Rejected as the primary path, not
  on cost. It keeps every guarantee local, which is the thing PRD §34 assigns to
  Solana, and `INVARIANTS.md` already records "capital is a database row" as the
  standing gap. Retained as a fallback if program deployment proves blocked.
- **Anchor instead of raw `cargo-build-sbf`.** Not yet decided. Anchor generates
  the IDL and client bindings we would need for the adapter; raw SBF proves the
  toolchain works today. Recorded here as an open implementation choice, not a
  settled one, because an ADR that pretends to have decided it would be the
  kind of claim `forge/` exists to prevent.

