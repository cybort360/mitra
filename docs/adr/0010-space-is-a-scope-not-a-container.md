# 0010. Space is implemented as a scope, not the container the spec describes

**Status:** Accepted (supersedes nothing; records a deliberate divergence)
**Related:** F33, PRD §13.1, §50, §52 Phase 4, ADR-0002

## Context

`Space` appears four times in each normative document, and the four mentions are
**not equally binding**:

| Location | Text | Force |
|---|---|---|
| §13.1 (PRD:1527) | "The Space is the bounded commercial context" | **Descriptive.** The section is titled *Microcosm role* and describes what Microcosm provides |
| §50 (PRD:4104) | "Reuse: Space concept" | **Normative** |
| §52 Phase 4 (PRD:4251) | "Implement: - Space" | **Normative** |

So the type is required, but the *justification* rests on §50 and §52, not §13.1.
An earlier draft of this work cited §13.1 as if it mandated the type; it does not,
and §13.1 alone would have been an over-reading. `Space` had not been frozen in
`p0-registry.ts` — the frozen P0 objects are agent, agreement, mandate, obligation,
reservation, saga and transitions — so adding it in Phase 4 fills a Phase 0 gap
rather than contradicting a frozen schema.

## The divergence

§13.1 says a Space *may contain*:

```text
Treasury  Participants  Rules  Work orders  Escrow
Deliverables  Evaluation  Disputes  Receipts  Obligations
```

The implemented `Space` covers four of the ten and adds two fields the spec never
mentions.

| Spec content | Implemented as |
|---|---|
| Treasury | `budget` / `committed` |
| Participants | `participants` |
| Rules | `allowedCapabilities` |
| Work orders | `Agreement.spaceId` (a back-reference, not a stored list) |
| Escrow, Deliverables, Evaluation, Disputes, Receipts, Obligations | **not represented** |
| — | `settlementChains` (invented) |
| — | `SpaceStatus` — ACTIVE / SUSPENDED / CLOSED (invented) |

## Decision

**Implement Space as a scope that entities reference, not an aggregate that
stores them.**

A container would hold `deliverableIds`, `receiptIds`, `obligationIds` and so on.
Each is a second copy of a relationship that already exists on the other entity
(`Deliverable.agreementId`, `Obligation.agreementId`, `Receipt.objectRef`), and
every one of those copies is a thing that can drift.

This is not a neutral preference — it is enforced, not just documented:

- `mitra.agreements.space_id` is a **real foreign key** to `mitra.spaces` with
  `ON DELETE RESTRICT`. An agreement naming a Space that does not exist cannot be
  inserted.
- The reverse question is answered by query:
  `SELECT * FROM mitra.agreements WHERE space_id = $1`.
- `Space.agreementIds` was **removed** (F33). It duplicated `Agreement.spaceId`
  with no constraint on it, so it could name a nonexistent agreement, one in a
  different Space, or a stale entry — and nothing would ever notice.

Two tests pin this: one walks every Space and asserts the scoped query returns
exactly the agreements that name it; the other asserts a `Space` object carries no
agreement list at all. Mutation-checked — writing an agreement with a wrong
`spaceId`, and making the `?spaceId=` filter ignore its argument, are both caught.

## The two invented fields, justified rather than assumed

Neither appears in the spec. Both are kept, with the reason stated here so they
are decisions rather than drift.

- **`SpaceStatus` (ACTIVE / SUSPENDED / CLOSED).** A bounded context needs a way
  to stop admitting work without deleting it. Without a status, "suspend this
  Space" has no representation and the only option is deletion, which destroys the
  agreements and receipts the Space is meant to contain. The suspended case is
  tested, including that a refund is still permitted while suspended — capital
  must be able to leave a closed context.
- **`settlementChains`.** PRD §4.2 requires one economic model across many rails,
  and a Space is the natural place to bound which rails a context may settle on.
  It is the least spec-supported of the two and is the first candidate for removal
  if a later reading disagrees.

## What is deliberately deferred

- **`Disputes`.** The spec lists it as Space content, but `Dispute` appears **zero
  times** in `lib/domain/types.ts`. The nearest existing concept is
  `ObligationStatus.DISPUTED`. Inventing a Dispute type from a one-line mention
  would be a larger design decision than this ADR is, so it is recorded as a gap
  rather than guessed at.
- **`Treasury`.** Likewise absent as a type. The Space's `budget` / `committed`
  pair covers the arithmetic, but a treasury with multiple assets and its own
  lifecycle is not modelled.

Both are recorded as gaps, not resolved by assumption.

## Consequences

- Six of ten spec-listed contents are unimplemented. That is a known, dated,
  named shortfall rather than a silent one.
- A contributor re-adding a reference list to `Space` for convenience will break a
  test. That is intended.
- If a later reading holds that the spec's container model is normative, this ADR
  is the thing to reverse — and the reversal is a schema migration, not a rewrite,
  because every relationship is already queryable.

## Rule this produces

AGENTS.md requires that disagreements be "resolved by superseding, not by picking
silently." The failure this record exists to prevent is narrower and more common:
picking silently, then writing a justification into a code comment. A code comment
argues for the decision; an ADR is where the disagreement with the spec is
*stated*, so that reversing it later is cheap.
