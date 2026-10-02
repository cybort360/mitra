# 0005. Five evidence levels; PARTIAL is not VERIFIED

**Status:** Superseded by [ADR-0008](0008-evidence-two-fields-union-vocabulary.md)

> **Superseded 2026-01-10.** This record's five-level vocabulary is retained
> unchanged, per the immutability rule that an ADR is not edited in place. ADR-0008
> replaces it with two fields and the union of this vocabulary with
> BUILD_FOUNDRY §2, because the five levels cannot express `LIVE_DEMONSTRATED` —
> the claim Phase 2 actually earned — and have no word for `REGRESSED`, this
> repository's most common failure class.
>
> The reasoning below still stands and is carried forward; only the vocabulary is
> replaced.

## Context

The failure this repository was built to prevent is a claim that is cheaper to
make than to check. It has already happened three ways: a docstring asserting an
interface compatibility that did not exist (F10), a roadmap inventing its own
phases before the PRD was imported (F9), and an onboarding document instructing
a `git checkout` of a branch that no longer existed.

All three were in documentation. None would have been caught by a test suite.

## Decision

Every claim carries one of five statuses, defined in `forge/PROOF_LEDGER.md`:

| Status | Meaning |
|---|---|
| `UNTESTED` | Asserted, no executed evidence |
| `PARTIAL` | Some of it demonstrated, with the gap named |
| `FAILED` | Executed and did not hold |
| `VERIFIED` | Executed, with the command recorded |
| `REGRESSED` | Was verified, no longer holds |

Two rules that carry the weight:

1. **`PARTIAL` is never rounded up.** Coverage does not imply proof; see ADR-0004.
2. **A claim is only true on a branch where its command runs.** The ledger states
   this rather than assuming it, because a ledger claiming `VERIFIED` for work
   absent from the checked-out tree is the same failure in a new place.

## Consequences

- A reviewer seeing `PARTIAL` in nine phases is looking at correct reporting.
- Adding a claim means adding the command that proves it. A claim with no command
  is `UNTESTED` by definition, which is the correct default.
- Where a claim was previously overstated, the ledger records what it was and
  what it is now, rather than being quietly corrected.
