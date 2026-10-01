# EXECUTION PLAN

The roadmap is the PRD's (§52), not a locally invented one. This file maps work
already done onto that roadmap and names what is next.

## Why this file exists

An earlier `PHASES.md` was written before the PRD was available and used its own
numbering. That created two competing truths about what "Phase 2" means. The PRD
wins; this file is the reconciliation. `PHASES.md` is retained as a historical
record of how the work was actually sequenced.

## Status against the PRD roadmap

| PRD Phase | Exit condition | Status |
|---|---|---|
| **0. Ground truth** | Every P0 object has a schema and state transition definition | ✅ Complete |
| **1. Core** | Local end-to-end lifecycle passes | ✅ Complete |
| **2. Solana kernel and vault** | **Real testnet/devnet vault creation, funding, reservation, guarded spend, release/refund, settlement proof** | 🟡 Kernel done, **exit condition not met** |
| **3. Authority and confidential policy** | Agent cannot execute an out-of-policy transaction | ⬜ Not started |
| **4. Commerce** | Agreement → escrow → deliverable → acceptance moves funds correctly | ⬜ Not started |
| **5. Agent ecosystem** | Discovery, identity resolution, capability manifest | ⬜ Not started |
| **6. Recovery** | Saga recovery executes and final state is visible | ⬜ Not started |
| **7. Clearing** | Deterministic clearing with challenge | 🟡 Local netting works; no epoch/challenge flow |
| **8. Base** | Base adapter | ⬜ |
| **9. Tempo** | Tempo adapter or verified test evidence | ⬜ |
| **10. Production tooling** | A pilot can operate without reading protocol logs | 🟡 Console exists; it is a mockup |

## The honest position on Phase 2

This is the most important line in the file.

**The PRD's Phase 2 exit condition is on-chain proof.** We do not have it. There
is no Solana program, no vault controller, no testnet vault, no receipt
anchoring, no settlement.

What exists is a *local* economic kernel that is correct and well tested:

- policy evaluation and action-digest binding
- capital accounting with `CHECK` constraints and a row lock
- nonce replay protection that survives a restart
- a state machine for reservations, enforced on write
- deterministic netting with conservation proofs

That is genuine progress toward the PRD's Phase 1, and a *prerequisite* for
Phase 2, but **it is not Phase 2**. Counting it as Phase 2 progress would be
exactly the "implemented ≠ verified" failure the Foundry exists to prevent.

## Phase 0 — Ground truth — `PARTIAL`

Done: the P0 object registry is data (`lib/domain/p0-registry.ts`), and
`tests/phase0-registry.test.ts` asserts the exit condition against the real types
and transition table, so it can fail. Five ADRs recorded. Evidence levels
defined, including `FAILED` and `REGRESSED`, which were in use but undefined.

The audit found two real gaps a prose checklist would have passed: `clearingEpoch`
had a machine nobody had claimed, and two evidence statuses were undefined.

Not done: canonical *serialization* — required by PRD §4.7 for receipt content
hashes — does not exist yet. That is Phase 1 work, recorded there.

The Postgres repository (previously "Phase 3") falls in the same category. It was
not in the PRD roadmap. It is retained because it makes concurrency and
durability testable, and those properties are required by `FR-VAULT-004` and
`FR-CORE-005`, but it should not be presented as roadmap progress.

## Next

**Phase 2 exit condition, in dependency order:**

1. Vault controller program on Solana devnet
2. Signer abstraction so no principal key is held by an agent
3. Escrow and release/refund on-chain
4. Receipt anchoring for every capital movement
5. Settlement against the anchored obligation
6. A test run whose evidence is recorded in `PROOF_LEDGER.md`

Steps 4 and 5 are where the product stops being a simulation, and they are the
first point at which any claim above `LOCAL_PASS` becomes available.

## Working agreement

One owner per phase. One conclusion per phase — something demonstrable, not
something describable. No phase starts before the previous is demonstrated.
