/**
 * Space governance (ADR-0011).
 *
 * ## The defect this replaces
 *
 * `Space` had one `owner` and one `status`, so a single signature could
 * `SUSPENDED` a commercial context other agents were party to. That is
 * "unrestricted operator control" over the commercial layer, which §3.2 excludes
 * by name — and it was invisible because a field called `owner` looks
 * unremarkable in review.
 *
 * ## Why arithmetic and not permissions
 *
 * A permission check asks "is this caller allowed?". Governance asks "have the
 * parties agreed?". The second is answerable by anyone holding the Space record:
 * count the distinct approvers, compare to the recorded threshold. There is no
 * operator to trust in the loop, so there is nothing to audit *except* the
 * arithmetic.
 *
 * That is the whole point. A trustless control plane cannot ask the operator
 * whether the operator was allowed.
 *
 * ## The two modes are peers
 *
 * `ADMIN` is not a weaker tier or a fallback. It is a deliberate arrangement for
 * small, fast engagements, chosen by people who could have chosen quorum. What
 * was wrong was shipping only one and letting one party freeze others.
 */

import type { Space, SpaceGovernance } from "@/lib/domain/types";

export type BindingAction = "SUSPEND" | "RESUME" | "AMEND_RULES" | "ADMIT" | "EXPEL" | "CLOSE";

export type GovernanceResult =
  | { ok: true; mode: "ADMIN" | "QUORUM"; approvers: string[] }
  | { ok: false; reason: string };

/**
 * Validates the governance configuration itself.
 *
 * A "quorum" of one is the important case: it is an admin wearing a quorum's
 * name, and honouring it would let a Space advertise governance it does not have.
 * Refused at configuration time rather than at decision time, because a Space that
 * cannot be configured correctly should not exist.
 */
export function validateGovernance(g: SpaceGovernance): GovernanceResult {
  if (!g.governors.length) return { ok: false, reason: "NO_GOVERNORS" };
  if (!Number.isInteger(g.threshold) || g.threshold < 1) {
    return { ok: false, reason: "THRESHOLD_MUST_BE_POSITIVE_INTEGER" };
  }
  if (g.threshold > g.governors.length) {
    return { ok: false, reason: "THRESHOLD_EXCEEDS_GOVERNOR_COUNT" };
  }
  if (g.mode === "QUORUM" && g.threshold < 2) {
    // A single-approver "quorum" is indistinguishable from ADMIN and would let a
    // Space appear self-governed while one party still controls it.
    return { ok: false, reason: "QUORUM_REQUIRES_THRESHOLD_OF_AT_LEAST_TWO" };
  }
  if (g.mode === "ADMIN") {
    if (!g.admins.length) return { ok: false, reason: "ADMIN_MODE_REQUIRES_AN_ADMIN" };
    for (const a of g.admins) {
      if (!g.governors.includes(a)) {
        // An admin who cannot vote is an off-ledger authority. Refusing keeps the
        // authority set and the voting set the same object.
        return { ok: false, reason: "ADMIN_MUST_BE_A_GOVERNOR" };
      }
    }
  }
  return { ok: true, mode: g.mode, approvers: [] };
}

/**
 * Decides whether a binding action is agreed.
 *
 * Distinct, authorised approvers only. Duplicates do not increase the count —
 * without that, one governor submitting the same approval three times would
 * constitute a quorum on their own.
 */
export function decide(
  space: Space,
  action: BindingAction,
  approvals: string[],
): GovernanceResult {
  const g = space.governance;
  const valid = validateGovernance(g);
  if (!valid.ok) return valid;

  // Deduplicate and reject anything outside the authority set. An approval from a
  // non-governor is not a weaker approval, it is an invalid one.
  const seen = new Set<string>();
  const approvers: string[] = [];
  for (const a of approvals) {
    if (!g.governors.includes(a)) return { ok: false, reason: `APPROVER_NOT_A_GOVERNOR:${a}` };
    if (seen.has(a)) continue;
    seen.add(a);
    approvers.push(a);
  }

  if (g.mode === "ADMIN") {
    const adminApprovals = approvers.filter((a) => g.admins.includes(a));
    if (!adminApprovals.length) return { ok: false, reason: "ADMIN_APPROVAL_REQUIRED" };
    return { ok: true, mode: "ADMIN", approvers: adminApprovals };
  }

  if (approvers.length < g.threshold) {
    return { ok: false, reason: `QUORUM_NOT_MET:${approvers.length}/${g.threshold}` };
  }
  return { ok: true, mode: "QUORUM", approvers };
}

/**
 * Applies a binding action if — and only if — it is agreed.
 *
 * Returns the updated Space. Never mutates, and refuses to act on a Space whose
 * governance is invalid, because a malformed Space is one whose rules cannot be
 * checked by anyone.
 */
export function applyGovernedAction(
  space: Space,
  action: BindingAction,
  approvals: string[],
): GovernanceResult & { space?: Space } {
  const verdict = decide(space, action, approvals);
  if (!verdict.ok) return verdict;

  switch (action) {
    case "SUSPEND":
      return { ...verdict, space: { ...space, status: "SUSPENDED", version: space.version + 1 } };
    case "RESUME":
      return { ...verdict, space: { ...space, status: "ACTIVE", version: space.version + 1 } };
    case "CLOSE":
      return { ...verdict, space: { ...space, status: "CLOSED", version: space.version + 1 } };
    case "AMEND_RULES":
      return {
        ...verdict,
        space: { ...space, rules: { ...space.rules, digest: space.rules.digest }, version: space.version + 1 },
      };
    case "ADMIT":
    case "EXPEL":
      // Membership changes are quorum-gated like anything else; the caller applies
      // the new membership. Recorded here so the gate cannot be bypassed by
      // calling a different path.
      return verdict;
    default:
      return { ok: false, reason: "UNKNOWN_ACTION" };
  }
}

/**
 * Whether an EXTERNAL rule set has changed under us.
 *
 * A Space bound to a marketplace's rules records the digest it agreed to. If the
 * marketplace publishes a different one, that is a **change of terms**, and it
 * must be surfaced — not silently adopted. Silently applying new rules would hand
 * the marketplace unilateral power over every participant, which is the
 * centralisation this design removes.
 */
export function externalRulesChanged(space: Space, observedDigest: string): boolean {
  if (space.rules.source !== "external") return false;
  return space.rules.digest !== observedDigest;
}

/**
 * Whether the Space is bound to rules Mitra does not own.
 *
 * Exposed so a client can show a participant "you are operating under someone
 * else's rules" rather than presenting Mitra's defaults as if they were the terms.
 */
export function isExternallyGoverned(space: Space): boolean {
  return space.rules.source === "external";
}
