# 0004. Phase exit conditions require live networks

**Status:** Accepted

## Context

PRD §52 Phase 2 has an exit condition of *"Real testnet/devnet vault creation,
funding, reservation, guarded spend, release/refund, and settlement proof."*
Phases 3 through 10 are similarly written: "a real job can be opened, funded,
submitted, accepted", "a Mitra obligation can target Tempo settlement".

Every one of those words — *real*, *funded*, *settled* — describes something that
happened on a network. An implementation with a complete vault controller, a
signer abstraction, and full adapter coverage does not satisfy them. It satisfies
the *code* those exit conditions describe and none of the *proof*.

The temptation this record exists to resist: marking a phase `VERIFIED` because
every local test passes, having built the code the phase calls for.

## Decision

1. A phase's implementation may be complete while its **exit condition is
   `PARTIAL`**. Those are separate claims and are recorded separately.
2. `PARTIAL` is never reported as `VERIFIED`, however good the test coverage is.
   The distinction is the entire value of the evidence ledger.
3. Every phase that needs credentials names **what credential** and **what
   command** would close it, so the gap is actionable rather than a caveat.
4. On-chain calls live behind a seam. The code is written and unit-tested against
   the seam; the seam's implementation against a real network is what produces
   `VERIFIED`.

## Consequences

- `forge/PROOF_LEDGER.md` carries an explicit `PARTIAL (needs <credential>)`
  convention rather than leaving gaps to be discovered.
- A reviewer seeing `PARTIAL` on nine phases is looking at correct reporting, not
  incomplete work. The distinction has to be stated, or the alternative reading
  is that someone overstated progress.
- This is the same failure as F10 (a docstring asserting an interface
  compatibility that did not exist): a claim that is cheaper to make than to
  check. The ledger exists to make claims expensive.
