# 0008. Evidence is two fields, and the union of both vocabularies

**Status:** Accepted
**Supersedes:** the single-status rule in `AGENTS.md` line 10, and the five-level
convention in [ADR-0005](0005-evidence-levels-untested-through-verified.md)
**Related:** F20, F21

## Context

The root directive and the standards disagreed about how to describe a claim.

`AGENTS.md` permitted exactly five statuses:

> `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`

`forge/standards/BUILD_FOUNDRY.md` §2 defines fourteen:

> `PROPOSED` `IMPLEMENTED` `TESTED` `INTEGRATED` `E2E_VERIFIED` `LIVE_DEMONSTRATED`
> `LIVE` `MONITORED` `PARTIAL` `BLOCKED_EXTERNAL` `BLOCKED_INTERNAL` `DEFERRED`
> `REJECTED` `FUTURE`

Verified by set comparison rather than read from memory — the first attempt used
a regex that excluded digits and silently dropped `E2E_VERIFYED`, reporting 13:

```
$ comm -12 agents_states foundry_states
PARTIAL                      # the intersection is exactly one word
$ comm -23 agents_states foundry_states
FAILED REGRESSED UNTESTED VERIFIED          # AGENTS.md only
$ comm -13 agents_states foundry_states
BLOCKED_EXTERNAL BLOCKED_INTERNAL …        # BUILD_FOUNDRY only
```

**Neither list is a superset.** Only `PARTIAL` is shared. Adopting BUILD_FOUNDRY's
fourteen would therefore have *deleted* `FAILED` and `REGRESSED` — and those are
the two words this repository most needs. F13 is a regression finding: a guard
that reported green because it could not see an untracked file. A separate F-record
describes "a hole shaped like the thing it excludes". Neither is expressible in a
vocabulary with no word for regression.

The cost of the conflict was already paid. Phase 2's devnet work is
`LIVE_DEMONSTRATED` in BUILD_FOUNDRY's terms — executed against a named live
substrate. Under the five-state rule the nearest permitted value was `VERIFIED`,
which is strictly weaker and erases exactly the distinction ADR-0004 exists to
protect. The status word made the claim *look* stronger and mean less.

## Decision

1. **Every claim carries two fields.** `evidence` records how far the claim has
   been carried; `blocker` records why it has not gone further. They are orthogonal
   and neither is derivable from the other.
2. **`evidence` takes BUILD_FOUNDRY's eight maturity rungs**, including
   `E2E_VERIFIED` and `LIVE_DEMONSTRATED`, which the old vocabulary could not
   express.
3. **`blocker` takes the disposition rungs**, retaining `FAILED` and `REGRESSED`
   from `AGENTS.md` and adding `PARTIAL`, `BLOCKED_EXTERNAL`,
   `BLOCKED_INTERNAL`, `DEFERRED`, `REJECTED` and `FUTURE` from BUILD_FOUNDRY.
   The union is the vocabulary; nothing is deleted.

   `PARTIAL` is the one word both documents shared, and it belongs on the
   `blocker` side: BUILD_FOUNDRY defines it as "some behavior works, with
   explicitly named residual gaps" — a statement about what is *missing*, which is
   precisely a disposition rather than a rung. It was initially omitted from both
   lists here and the guard test in `tests/phase0-docs.test.ts` caught it, which
   is the argument for writing the guard in the same change as the vocabulary.
4. **Coherence is enforced by three rules**, in `AGENTS.md`: `blocker` is required
   below `LIVE_DEMONSTRATED`; blockers must name their cause; `DEFERRED`,
   `REJECTED`, `FAILED` and `REGRESSED` must name the deciding party or the test
   that caught it.

### Why every rung earns its place

The obvious objection is that sixteen words is ceremony on a small repository. The
rungs that look like ceremony are the ones that would have caught real defects
here:

- **`E2E_VERIFIED`** is precisely the boundary between "eighteen unit tests pass"
  and "ran on a validator". F19 recorded **five defects in that gap** — a PDA that
  does not exist until created, signer privilege, CPI argument shape, lamport
  ownership, and a wrong-account check. Collapsing this rung into `VERIFIED`
  removes the vocabulary for the single most expensive lesson in the repository's
  history.
- **`PROPOSED` vs `IMPLEMENTED`** separates designed from built. F9 was a roadmap
  that invented phases with no code behind them.
- **`MONITORED`** marks what this repository has *not* done — there is no runtime
  alerting — rather than a state that could never apply.

## Consequences

- `forge/PROOF_LEDGER.md` gains a second column for new entries. Existing rows are
  **annotated, not rewritten**: the history is evidence, and a mechanical migration
  would destroy the dated, specific wording that makes each row auditable.
- A claim can now say "reached `E2E_VERIFIED`, remainder `BLOCKED_INTERNAL`" —
  which is precisely the situation of Phases 3–10, and which no single flat status
  could express.
- The vocabulary is larger, so it must be *used* rather than merely defined. The
  three coherence rules exist to keep it from becoming notation.
- `AGENTS.md` no longer states a status list of its own; it points at
  BUILD_FOUNDRY §2, so the two documents cannot drift apart again. That was the
  F21 failure — a reference that nobody checked resolved.

## Alternatives considered

- **Keep five states.** Rejected: it cannot express `LIVE_DEMONSTRATED`, which is
  the claim Phase 2 actually earned, and it cannot distinguish an external
  dependency from a repository gap — the distinction the phase audit exists to
  report.
- **Adopt BUILD_FOUNDRY's fourteen wholesale.** Rejected: deletes `FAILED` and
  `REGRESSED`, the only words this repository has for its most common failure class.
- **Add only `BLOCKED_EXTERNAL` / `BLOCKED_INTERNAL` and keep `VERIFIED`.** The
  leanest option, and genuinely defensible for a small repository. Rejected only
  because it preserves the `VERIFIED`-for-`LIVE_DEMONSTRATED` overclaim, which is
  the specific distortion this record exists to prevent. If ceremony ever becomes
  the binding constraint, this is the fallback and should be recorded as a
  deliberate reduction rather than arrived at by attrition.