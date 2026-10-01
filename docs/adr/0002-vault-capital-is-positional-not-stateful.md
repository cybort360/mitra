# 0002. Vault capital is positional, not a state machine

**Status:** Accepted

## Context

PRD §4.12 defines capital as six explicit positions — available, reserved,
escrowed, encumbered, settling, frozen. `lib/domain/types.ts` models exactly
that, as six numbers on `Vault`.

The obvious-looking move, given that this repository is built around state
machines, is to give `Vault` a `VaultStatus` union and treat capital as a
lifecycle. That was tried on paper and it is wrong.

A vault is routinely in several of those positions at once. It can be frozen
*and* mid-settlement: a freeze halts new reservations but must not strand capital
already in flight. It can be encumbered *and* escrowed for different
obligations at once. Any single `status` field has to pick one, and every
possible total order over the six positions encodes at least one combination that
the product genuinely needs.

## Decision

`Vault` has **no status field**. Capital is six independent positions, and the
only valid operations are arithmetic plus a set of explicit guards:
`emergencyFreeze`, and the reconciliation invariant in
`lib/kernel/vault.ts#reconcileVault` that the six sum to `total`.

A "state machine" over the six would constrain a set of combinations that is
strictly smaller than the set the product must support, while appearing to be
evidence that capital handling is disciplined. That is worse than no machine.

## Consequences

- `P0_OBJECTS` in `lib/domain/p0-registry.ts` records `Vault.hasMachine = false`
  with this reasoning, so the decision is a checked artifact rather than a
  comment that can be reversed by someone who assumed it was an oversight.
- Adding a `VaultStatus` is a deliberate act requiring a new ADR, because it
  would reintroduce exactly the conflation this record rejects.
- `reconcileVault` is the guard that replaces the machine, and it is tested.
