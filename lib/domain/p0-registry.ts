/**
 * Phase 0: the frozen object registry.
 *
 * ## Why this file exists
 *
 * PRD §52 Phase 0 exit condition is "Every P0 object has a schema and state
 * transition definition." That was an unfalsifiable sentence — nothing checked
 * it, so "every object has a machine" could be true in a document and false in
 * the code, which is precisely the failure this repository exists to prevent.
 *
 * So the exit condition is expressed as data, and `tests/phase0-registry.test.ts`
 * asserts it against the real types and machines rather than against a
 * declaration. The difference matters: adding a type without a machine fails
 * the build.
 *
 * ## Two kinds of entry, and why
 *
 * `hasMachine: true`  — the object is a *lifecycle*. It accrues state over time
 *                      and an illegal transition is a correctness bug.
 * `hasMachine: false` — the object is a *record* or a *value*. An Intent is a
 *                      request; a Deliverable is an artifact; a Receipt is proof
 *                      something happened. None of them "transitions", and
 *                      inventing a two-state machine for them would be a machine
 *                      that constrains nothing while appearing to be evidence.
 *
 * The `rationale` field is required, not optional, because "no machine" is
 * exactly the kind of decision that gets silently reversed later without anyone
 * noticing it was ever a decision.
 */
export type P0Entry = {
  /** Object name, matching the exported type. */
  object: string;
  /**
   * Key in `TRANSITIONS`, when `hasMachine` is true.
   *
   * Explicit rather than derived by lowercasing, because the derivation is wrong
   * for every multi-word object: `ClearingEpoch` lowercases to
   * `clearingepoch`, and the machine is `clearingEpoch`. Deriving it produced a
   * test that reported a real, correct machine as missing — which is how a
   * registry audit gets dismissed as broken and then ignored.
   */
  machine?: string;
  /** PRD section defining it. */
  prd: string;
  hasMachine: boolean;
  /** Why, when `hasMachine` is false. Required either way. */
  rationale: string;
};

/**
 * Every object in PRD §6 "Common Economic Objects".
 *
 * Exhaustive by construction: `tests/phase0-registry.test.ts` fails if the PRD
 * gains a §6 subsection this list does not cover, so the registry cannot rot into
 * a subset that looks complete.
 */
export const P0_OBJECTS: readonly P0Entry[] = [
  { object: "Agent", machine: "agent", prd: "6.1", hasMachine: true,
    rationale: "Onboarding is a lifecycle; PRD §7.2 defines the states." },
  { object: "Mandate", machine: "mandate", prd: "6.2", hasMachine: true,
    rationale: "Authority is granted, used, suspended and revoked." },
  { object: "Intent", prd: "6.3", hasMachine: false,
    rationale: "A request, not a lifecycle. It is evaluated once and produces an Authorization; it never transitions. Forcing a machine here would be theatre." },
  { object: "Vault", prd: "6.4", hasMachine: false,
    rationale: "Deliberate and load-bearing. PRD §4.12 defines capital as *positions* (available/reserved/escrowed/encumbered/settling/frozen), not a status. A single status field would have to encode six independent dimensions, and no total order over them is correct — a vault can be simultaneously frozen and settling. Modeling that as a state machine would be wrong, not merely incomplete. See ADR-0002." },
  { object: "Reservation", machine: "reservation", prd: "6.5", hasMachine: true,
    rationale: "Reservation precedes commitment (PRD §4.10); the ordering is the invariant." },
  { object: "Authorization", prd: "6.6", hasMachine: false,
    rationale: "An immutable decision record. ALLOW/DENY is a verdict, not a position in a lifecycle. An authorization never changes once written." },
  { object: "Obligation", machine: "obligation", prd: "6.6", hasMachine: true,
    rationale: "Accrual and settlement are ordered." },
  { object: "Agreement", machine: "agreement", prd: "6.4", hasMachine: true,
    rationale: "Open → funded → executed → accepted/refunded is a lifecycle." },
  { object: "Deliverable", prd: "6.5", hasMachine: false,
    rationale: "An artifact, not a lifecycle. Acceptance is recorded on the Agreement, which is the object that transitions." },
  { object: "Saga", machine: "saga", prd: "6.7", hasMachine: true,
    rationale: "Declared → executing → recovery is a lifecycle (PRD §4.5: failures are normal states)." },
  { object: "ClearingEpoch", prd: "6.6", hasMachine: true, machine: "clearingEpoch",
    rationale: "An epoch is a lifecycle: open → frozen → calculated → finalized → settled. PRD §4.6 separates clearing from settlement, so the epoch must reach a terminal state on its own. Registered here because the machine already existed; the registry is what makes that visible instead of accidental." },
  { object: "Receipt", prd: "6.8", hasMachine: false,
    rationale: "Proof that something happened, minted once. PRD §4.7 makes receipts first-class precisely because they are terminal records — a receipt that could change would not be evidence." },
] as const;

/**
 * Objects that must have a state machine, paired with the machine key.
 *
 * A lifecycle entry with no `machine` is a registry bug, and
 * `tests/phase0-registry.test.ts` fails on it rather than skipping.
 */
export const P0_LIFECYCLES = P0_OBJECTS.filter((o) => o.hasMachine);

/** §6 subsections this registry covers, for the completeness assertion. */
export const P0_SECTIONS = [...new Set(P0_OBJECTS.map((o) => o.prd))].sort();