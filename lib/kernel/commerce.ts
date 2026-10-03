/**
 * The commerce lifecycle (PRD Phase 4).
 *
 * Phase 4's exit condition is concrete: *"Real job can be opened, funded,
 * submitted, accepted, rejected, refunded."* Mitra had `Agreement`,
 * `AgreementStatus` and a complete transition table — and **no code that called
 * any of them**. `canTransition` and `transition` existed and were exercised by
 * tests only, which is exactly Phase 0's recorded blocker: *"six of seven state
 * machines lack write paths."* A transition table nothing consults is
 * documentation with a type signature.
 *
 * Two properties are enforced here that the types alone could not express:
 *
 * 1. **Every status change goes through `transition()`.** It throws on an
 *    illegal edge rather than returning a verdict, so a caller that forgets to
 *    check cannot write the new state anyway.
 * 2. **Every operation is scoped to a Space.** Without that containment check a
 *    rule, mandate or evaluator defined for one engagement is implicitly
 *    available to all of them (see the `Space` type).
 *
 * Pure by kernel convention: no clock, no store, no IO. Callers pass `now`, and
 * rejection reasons are machine-readable because the API and the audit log are
 * what consume them.
 */

import type { Agreement, AgreementStatus, Deliverable, Money, Space } from "@/lib/domain/types";
import { transition, nextStates, isTerminal } from "@/lib/kernel/machines";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
const pass = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * Containment check (PRD §13.1).
 *
 * Three independent refusals, deliberately not merged: a participant that is not
 * admitted, a capability the Space does not permit, and a capital ceiling the
 * Space has exceeded. Collapsing them into one "not allowed" would make a
 * misconfigured Space indistinguishable from an over-budget one, and the operator
 * would have no way to tell which to fix.
 */
export function admitsProposal(
  space: Space,
  proposal: { participant: string; capability: string; amount: Money },
): Result<true> {
  if (space.status !== "ACTIVE") return fail("SPACE_NOT_ACTIVE");
  if (!space.participants.includes(proposal.participant)) {
    return fail("PARTICIPANT_NOT_IN_SPACE");
  }
  if (!space.allowedCapabilities.includes(proposal.capability)) {
    return fail("CAPABILITY_NOT_ALLOWED_IN_SPACE");
  }
  if (proposal.amount.amount + space.committed.amount > space.budget.amount) {
    return fail("SPACE_BUDGET_EXCEEDED");
  }
  return pass(true);
}

/**
 * Opens an agreement inside a Space.
 *
 * `OPEN` is the machine's birth state — it has no incoming edge, which is
 * correct: an agreement is *born* open, not transitioned into being. So this
 * function constructs rather than transitions, and every subsequent change goes
 * through `applyAgreementOp`. The alternative, a fake self-transition to prove
 * the machinery runs, would have added an edge to the table that no product
 * concept corresponds to.
 *
 * Opening is where containment binds: the proposal is admitted against the Space
 * *before* any capital is encumbered, so an out-of-scope job never gets a
 * record to be funded from.
 */
export function openAgreement(
  space: Space,
  draft: Omit<Agreement, "status" | "version" | "spaceIds">,
  proposal: { capability: string; amount: Money },
): Result<{ space: Space; agreement: Agreement }> {
  const admitted = admitsProposal(space, {
    ...proposal,
    participant: draft.client,
  });
  if (!admitted.ok) return fail(admitted.reason);

  if (draft.price.amount !== proposal.amount.amount) {
    // The admitted amount and the recorded price must be the same number. If they
    // diverge, containment was checked against one figure and the agreement
    // enforces another — the classic split between "what was approved" and "what
    // is charged".
    return fail("PRICE_AMOUNT_MISMATCH");
  }

  // The agreement joins the Space it was opened in. Membership is RECORDED, never
  // inferred, so a later amend cannot silently re-scope it.
  const agreement: Agreement = {
    ...draft,
    spaceIds: [...new Set([space.spaceId])],
    status: "OPEN",
    version: 1,
  };

  // The Space version bumps on every change, so a change to a Space is observable
  // in the same place its rules are read. It does NOT record which agreements it
  // contains: `Agreement.spaceId` plus a query is the whole relationship, and a
  // second copy here is a second thing that can drift.
  const nextSpace: Space = { ...space, version: space.version + 1 };
  return pass({ space: nextSpace, agreement });
}

/**
 * Every transition the lifecycle exposes, each returning the *next* entity.
 *
 * Exported as a single map so a caller (and a test) can assert that every
 * operation it can invoke corresponds to a real edge, and so adding one operation
 * without a machine edge becomes a compile-time concern rather than a runtime
 * surprise.
 */
export type AgreementOp =
  | "fund"
  | "startExecution"
  | "submitDeliverable"
  | "acceptDeliverable"
  | "rejectDeliverable"
  | "refund";

export const AGREEMENT_OPS: Record<AgreementOp, string> = {
  fund: "FUNDED",
  startExecution: "EXECUTING",
  submitDeliverable: "SUBMITTED",
  acceptDeliverable: "ACCEPTED",
  rejectDeliverable: "REJECTED",
  refund: "REFUNDED",
};

/** Applies an operation, scoped to its Space, and returns the updated pair. */
export function applyAgreementOp(
  space: Space,
  agreement: Agreement,
  op: AgreementOp,
  opts: { capability?: string; amount?: Money; artifactRefs?: string[]; contentHash?: string } = {},
): Result<{ space: Space; agreement: Agreement }> {
  const to = AGREEMENT_OPS[op];

  if (isTerminal("agreement", agreement.status)) {
    return fail("AGREEMENT_TERMINAL");
  }

  // Containment re-checked on *every* operation, not just at open: a Space may be
  // suspended or its budget raised after the agreement was created, and a rule
  // checked only once would not notice.
  const proposed = opts.amount ?? { amount: 0, asset: agreement.price.asset };
  const admitted = admitsProposal(space, {
    participant: agreement.client,
    capability: opts.capability ?? "payment",
    amount: proposed,
  });
  if (!admitted.ok && op !== "refund") {
    // Refund releases capital and is therefore exempt from an admission check —
    // requiring budget headroom to give money back would strand it.
    return fail(admitted.reason);
  }

  // `transition` throws on an illegal edge; converting to a Result keeps the
  // kernel's error surface uniform and prevents an exception escaping to a route.
  try {
    const nextAgreement = transition("agreement", agreement, to);
    const { space: nextSpace, released } = applyCapital(space, agreement, op);
    // `released` is returned explicitly rather than inferred by comparing object
    // identity. The first version used `nextSpace !== space`, which is true on
    // `fund` as well — so it marked escrow released at the exact moment the
    // capital was encumbered, and the guard in applyCapital then blocked the real
    // release later. Identity comparison cannot distinguish "changed" from
    // "changed in the way that matters".
    return pass({
      space: nextSpace,
      agreement: released ? { ...nextAgreement, escrowReleased: true } : nextAgreement,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The states in which the price stops being encumbered and returns to the Space's
 * available budget.
 *
 * Both are *settlement*: the client has paid (acceptance) or will not (refund).
 * Everything before them — OPEN, FUNDED, EXECUTING, SUBMITTED — is still live
 * capital the Space is on the hook for.
 */
const SETTLED: readonly AgreementStatus[] = ["ACCEPTED", "REFUNDED"];

/**
 * Moves `space.committed` to match the agreement's settlement state.
 *
 * **This function is F42's fix.** Before it, `committed` was incremented on `fund`
 * and never decremented on anything, so `headroom = budget - committed` behaved as
 * a *lifetime* expenditure cap rather than a concurrency limit: a Space with a 100
 * budget could fund exactly ten 10-USDC agreements across all time, and the
 * eleventh failed with `SPACE_BUDGET_EXCEEDED` even though all ten had been
 * accepted and paid for. Nothing surfaced it, because every test drove a single
 * agreement and never asked what the Space could do *next*.
 *
 * Two properties are load-bearing:
 *
 * 1. **Release happens exactly once.** `escrowReleased` guards it, because
 *    `ACCEPTED -> REFUNDED` is a legal edge: without the flag, a chargeback would
 *    return the budget twice and inflate headroom past the budget itself.
 * 2. **A settlement does not decrement below zero.** The guard is not defensive
 *    arithmetic — it is there because a double-decrement would be silent, and
 *    silent is what this whole defect was.
 */
function applyCapital(
  space: Space,
  agreement: Agreement,
  op: AgreementOp,
): { space: Space; released: boolean } {
  if (op === "fund") {
    return {
      space: {
        ...space,
        committed: { ...space.committed, amount: space.committed.amount + agreement.price.amount },
        version: space.version + 1,
      },
      released: false,
    };
  }

  const settles = SETTLED.includes(AGREEMENT_OPS[op] as AgreementStatus);
  if (!settles) return { space, released: false };
  if (agreement.escrowReleased) return { space, released: false }; // already returned; never twice
  if (space.committed.amount < agreement.price.amount) return { space, released: false };

  return {
    space: {
      ...space,
      committed: { ...space.committed, amount: space.committed.amount - agreement.price.amount },
      version: space.version + 1,
    },
    released: true,
  };
}

/** States still reachable from here — for UI affordances and audit display. */
export function availableAgreementOps(from: string): AgreementOp[] {
  const allowed = nextStates("agreement", from);
  return (Object.keys(AGREEMENT_OPS) as AgreementOp[]).filter((op) =>
    allowed.includes(AGREEMENT_OPS[op]),
  );
}

/** A deliverable carries the evidence that made acceptance possible. */
export function evaluateDeliverable(
  agreement: Agreement,
  deliverable: Deliverable,
  now: Date,
): Result<true> {
  if (deliverable.agreementId !== agreement.agreementId) return fail("WRONG_AGREEMENT");
  if (!deliverable.contentHash) return fail("DELIVERABLE_EMPTY");
  if (now > new Date(agreement.deadline)) return fail("DELIVERABLE_LATE");
  if (!deliverable.artifactRefs.length) return fail("DELIVERABLE_HAS_NO_ARTIFACTS");
  return pass(true);
}

/**
 * Binds a settlement to the exact terms of the agreement it claims to pay.
 *
 * ## Why this exists (`docs/SECURITY.md` line 10)
 *
 * > An agreement cannot settle against a different provider without explicit
 * > reassignment/amendment.
 *
 * There was **no guard for this anywhere**. `SettlementAdapter.settle()` carries
 * only `from`, `to`, `amount` and `commitmentHash` — the provider is not part of the
 * settlement input at all, so a settlement could be attributed to an agreement whose
 * provider it had nothing to do with. Nothing rejected it.
 *
 * Two properties are deliberate:
 *
 * 1. **Provider is matched, not merely present.** A settlement that names a
 *    different provider fails with `PROVIDER_SUBSTITUTION`. There is no
 *    `allowReassignment` flag here on purpose: PRD §11 makes reassignment an
 *    explicit amendment, so accepting one here would create a second, silent path
 *    to the same state change. A caller that legitimately reassigns must amend the
 *    agreement first, and then this check passes because the terms moved
 *    deliberately and are visible.
 * 2. **Amount and asset must match exactly.** Not "at most" — a settlement for less
 *    than the agreed price is a different economic event and needs its own
 *    agreement, not a partial payment inferred from a smaller transfer.
 *
 * Settlement state is also required. A settlement attempted before the agreement is
 * `ACCEPTED` is `SETTLEMENT_NOT_DUE`: acceptance is what makes the price owed, and
 * permitting settlement against, say, a merely `SUBMITTED` agreement would let a
 * deliverable pay out before anyone evaluated it.
 */
export function assertSettlementBinding(
  agreement: Agreement,
  settlement: { provider: string; amount: Money; settlementRef?: string },
): Result<true> {
  if (agreement.status !== "ACCEPTED") return fail("SETTLEMENT_NOT_DUE");
  if (settlement.provider !== agreement.provider) return fail("PROVIDER_SUBSTITUTION");
  if (settlement.amount.asset !== agreement.price.asset) return fail("ASSET_SUBSTITUTION");
  if (settlement.amount.amount !== agreement.price.amount) return fail("AMOUNT_MISMATCH");
  // NOT `escrowReleased`: escrow is released on acceptance, and settlement happens
  // after it. Using the wrong flag here refused every legitimate settlement.
  if (agreement.settledRef) return fail("ALREADY_SETTLED");
  return pass(true);
}
