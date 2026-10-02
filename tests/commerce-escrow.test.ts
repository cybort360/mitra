/**
 * FR-COM-001/002/003 — the commerce payment path (PRD §13.4).
 *
 * ## Why this file exists
 *
 * All three were recorded `UNTESTED`, cited to PRD §12. §12 is *payment transport*
 * (x402, MPP, payment channels, ERC-2612) — it does not define these invariants.
 * PRD **§13.4 "Escrow invariants"** does, and it is much more specific than the
 * three lines recorded:
 *
 *   - Only the authorized client or protocol path can fund.
 *   - Funds must not be double-released.
 *   - Release requires the correct agreement state.
 *   - Refund requires the correct rejection/expiry/cancellation state.
 *   - Duplicate delivery evaluation must not trigger duplicate release.
 *   - Every release/refund produces a receipt.
 *
 * So the citation was wrong AND the coverage was thinner than the spec. This file
 * tests against §13.4's six clauses.
 *
 * ## The defect it finds (F42)
 *
 * `applyAgreementOp` increments `space.committed` on `fund` and **never decrements
 * it** — not on acceptance, not on refund. Headroom is `budget - committed`, so
 * every USDC a Space ever spends stays spent. A Space with a 100 budget can fund
 * exactly ten 10-USDC agreements *across all time*, and the eleventh is refused
 * with `SPACE_BUDGET_EXCEEDED` even though ten agreements have been accepted and
 * paid for.
 *
 * That is not a rounding issue. It is a budget that behaves like a lifetime
 * expenditure cap rather than a concurrency limit, and it is invisible while tests
 * drive a single agreement to completion.
 *
 * **Note on what this file does NOT fix.** The repair changes kernel behaviour, and
 * the tests here are written to FAIL against the current implementation. They are
 * the specification the fix must satisfy — not a description of working code.
 */
import { describe, expect, it } from "vitest";
import type { Deliverable, Money, Space } from "@/lib/domain/types";
import {
  admitsProposal,
  applyAgreementOp,
  evaluateDeliverable,
  openAgreement,
} from "@/lib/kernel/commerce";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });

function space(over: Partial<Space> = {}): Space {
  return {
    spaceId: "space_1",
    owner: "buyer_1",
    governance: {
      mode: "QUORUM",
      admins: [],
      governors: ["buyer_1", "provider_1", "eval_1"],
      threshold: 2,
    },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE",
    participants: ["buyer_1", "provider_1", "eval_1"],
    allowedCapabilities: ["research", "payment"],
    settlementChains: ["solana"],
    budget: USDC(100),
    committed: USDC(0),
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const draft = {
  agreementId: "ag_1",
  runId: "run_1",
  intentId: "intent_1",
  client: "buyer_1",
  provider: "provider_1",
  evaluator: "eval_1",
  externalJobRefs: [],
  price: USDC(10),
  deadline: "2027-01-01T00:00:00Z",
  acceptanceCriteria: ["deliverable"],
  failurePolicy: "refund on expiry",
};

/** Opens, funds, and returns the pair. `committed` is 10 here. */
function funded(over: Partial<Space> = {}, id = "ag_1") {
  const r = openAgreement(space(over), { ...draft, agreementId: id }, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(`open failed: ${r.reason}`);
  const f = applyAgreementOp(r.value.space, r.value.agreement, "fund", { capability: "research", amount: USDC(10) });
  if (!f.ok) throw new Error(`fund failed: ${f.reason}`);
  return f.value;
}

function accepted(over: Partial<Space> = {}, id = "ag_1") {
  let { space: s, agreement: a } = funded(over, id);
  for (const op of ["startExecution", "submitDeliverable", "acceptDeliverable"] as const) {
    const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(`fixture failed at ${op}: ${r.reason}`);
    s = r.value.space;
    a = r.value.agreement;
  }
  return { space: s, agreement: a };
}

/** Opens one agreement without funding it, so a test can drive specific ids. */
function openFor(s: Space, id: string) {
  const r = openAgreement(s, { ...draft, agreementId: id }, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(`open ${id} failed: ${r.reason}`);
  return { space: r.value.space, agreement: r.value.agreement };
}

/**
 * Applies one op, failing loudly rather than returning a Result the test must
 * re-check.
 *
 * Returns the PAIR. A version returning only `.agreement` threw away the updated
 * Space, so the next call re-used pre-`fund` capital state and the test asserted
 * `committed === 20` against a Space that had never seen the funding. The failure
 * read "expected 0 to be 20" and looked like a kernel bug; it was a fixture that
 * dropped state.
 */
function apply(s: Space, a: ReturnType<typeof openFor>["agreement"], op: Parameters<typeof applyAgreementOp>[2]) {
  const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(`${op} failed: ${r.reason}`);
  return { space: r.value.space, agreement: r.value.agreement };
}

/**
 * fund -> execute -> submit -> accept, returning the settled PAIR.
 *
 * Returns the pair rather than just the agreement because `applyAgreementOp` is
 * pure: without threading the space, a test cannot tell what happened to
 * `committed`. The first version returned only the agreement and re-passed the
 * pre-op space, which silently ran every op against stale capital state.
 */
function driveToAccepted(s: Space, a: ReturnType<typeof openFor>["agreement"]) {
  let curS = s;
  let curA = a;
  for (const op of ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"] as const) {
    const r = applyAgreementOp(curS, curA, op, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(`${op} failed: ${r.reason}`);
    curS = r.value.space;
    curA = r.value.agreement;
  }
  return { space: curS, agreement: curA };
}

// ---------------------------------------------------------------------------
// FR-COM-002 — escrow release depends on agreement/deliverable state
// ---------------------------------------------------------------------------

describe("FR-COM-002 — committed capital is returned when the agreement settles", () => {
  it("acceptance releases the committed amount", () => {
    const { space: s, agreement: a } = accepted();
    expect(a.status).toBe("ACCEPTED");
    expect(
      s.committed.amount,
      "an ACCEPTED agreement has been paid for; its budget must be released back",
    ).toBe(0);
  });

  it("refund releases the committed amount", () => {
    let { space: s, agreement: a } = funded();
    for (const op of ["startExecution", "submitDeliverable", "rejectDeliverable", "refund"] as const) {
      const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
      if (!r.ok) throw new Error(`fixture failed at ${op}: ${r.reason}`);
      s = r.value.space;
      a = r.value.agreement;
    }
    expect(a.status).toBe("REFUNDED");
    expect(s.committed.amount, "a refunded agreement owes nothing").toBe(0);
  });

  it("a Space can fund its budget repeatedly, not just once", () => {
    // The end-to-end consequence. Ten 10-USDC agreements against a 100 budget,
    // each accepted. If committed leaks, the tenth or eleventh fails.
    let s = space();
    for (let i = 0; i < 12; i++) {
      const id = `ag_${i}`;
      const r = openAgreement(s, { ...draft, agreementId: id }, { capability: "research", amount: USDC(10) });
      expect(r.ok, `opening agreement ${i} must succeed`).toBe(true);
      if (!r.ok) return;
      let a = r.value.agreement;
      const f = applyAgreementOp(r.value.space, a, "fund", { capability: "research", amount: USDC(10) });
      expect(f.ok, `funding agreement ${i} must succeed`).toBe(true);
      if (!f.ok) return;
      s = f.value.space;
      a = f.value.agreement;
      for (const op of ["startExecution", "submitDeliverable", "acceptDeliverable"] as const) {
        const step = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
        expect(step.ok, `${op} on agreement ${i}`).toBe(true);
        if (!step.ok) return;
        s = step.value.space;
        a = step.value.agreement;
      }
    }
    expect(s.committed.amount).toBe(0);
  });

  it("committed only counts agreements that are still live", () => {
    // While one is funded and one has settled, exactly one is counted.
    const first = accepted();
    expect(first.space.committed.amount).toBe(0);

    const live = funded({}, "ag_live");
    expect(live.space.committed.amount, "a FUNDED agreement is still encumbered").toBe(10);
  });
});

// ---------------------------------------------------------------------------
// FR-COM-003 — duplicate events cannot cause duplicate capital release
// ---------------------------------------------------------------------------

describe("FR-COM-003 — duplicate delivery/evaluation cannot release twice", () => {
  it("a second acceptDeliverable on the same agreement is refused", () => {
    const { space: s, agreement: a } = accepted();
    const again = applyAgreementOp(s, a, "acceptDeliverable", { capability: "research", amount: USDC(10) });
    expect(again.ok, "ACCEPTED -> ACCEPTED is not an edge").toBe(false);
  });

  it("replaying the whole sequence cannot release twice", () => {
    // The threat is a retried request, not a hand-written script.
    let { space: s, agreement: a } = accepted();
    const before = s.committed.amount;
    for (const op of ["acceptDeliverable", "refund", "submitDeliverable", "acceptDeliverable"] as const) {
      const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
      if (r.ok) { s = r.value.space; a = r.value.agreement; }
    }
    expect(s.committed.amount, "a replayed lifecycle must not move committed further").toBe(before);
  });

  it("a chargeback after acceptance does not return the budget twice", () => {
    // ACCEPTED -> REFUNDED is a LEGAL edge, so a settled agreement can be charged
    // back. With other agreements still encumbered, a missing double-release guard
    // returns the price a second time and inflates headroom ABOVE the budget.
    //
    // Spaces are threaded through every step because `applyAgreementOp` is pure —
    // it returns the new pair rather than mutating.
    const openedA = openFor(space({ budget: USDC(100) }), "ag_a");
    const A = driveToAccepted(openedA.space, openedA.agreement);
    const openedB = openFor(A.space, "ag_b");
    const B = driveToAccepted(openedB.space, openedB.agreement);

    // Two agreements left funded and unsettled, so committed is 20 with real
    // headroom above it.
    const C = openFor(B.space, "ag_c");
    const fundedC = apply(C.space, C.agreement, "fund");
    const D = openFor(fundedC.space, "ag_d");
    const fundedD = apply(D.space, D.agreement, "fund");

    // `fundedD.space`, NOT `D.space`: D.space is the pre-fund Space, so using it
    // asserted against committed=10 and read like a kernel bug. A pure kernel means
    // every step must thread the *returned* Space or the test is measuring stale
    // state.
    const s = fundedD.space;
    expect(fundedD.agreement.status).toBe("FUNDED");
    expect(s.committed.amount, "two settled, two still encumbered").toBe(20);

    // Charge back the already-ACCEPTED ag_a. The operation is legal; what must not
    // happen is the price being returned a second time.
    const cb = applyAgreementOp(s, A.agreement, "refund", { capability: "research", amount: USDC(10) });
    expect(cb.ok, "ACCEPTED -> REFUNDED is a legal chargeback").toBe(true);
    if (!cb.ok) return;

    expect(cb.value.agreement.status).toBe("REFUNDED");
    expect(cb.value.space.committed.amount,
      "a chargeback must not return the price a second time").toBe(20);
    // `toBeLessThanOrEqual` takes ONE argument — a second "message" argument is
    // silently discarded by the matcher, so the bound is asserted on its own.
    expect(cb.value.space.committed.amount).toBeLessThanOrEqual(cb.value.space.budget.amount);
  });

  it("duplicate deliverable evaluation is idempotent or refused", () => {
    const { agreement: a } = accepted();
    const deliverable: Deliverable = {
      deliverableId: "d_1",
      agreementId: a.agreementId,
      provider: a.provider,
      artifactRefs: ["artifact_1"],
      contentHash: "0xabc",
      evidenceRefs: [],
      submittedAt: "2026-05-01T00:00:00Z",
      accepted: false,
      version: 1,
    };
    const first = evaluateDeliverable(a, deliverable, new Date("2026-06-01T00:00:00Z"));
    const second = evaluateDeliverable(a, deliverable, new Date("2026-06-01T00:00:00Z"));
    // Evaluating twice must not be distinguishable from evaluating once in its
    // effect. evaluateDeliverable is a pure predicate, so it must agree both times.
    expect(first.ok).toBe(second.ok);
  });
});

// ---------------------------------------------------------------------------
// FR-COM-001 — commercial terms distinct from payment transport
// ---------------------------------------------------------------------------

describe("FR-COM-001 — terms are independent of transport", () => {
  it("an agreement records terms without naming any chain or rail", () => {
    const r = openAgreement(space(), draft, { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.value.agreement;
    // Terms: who, what, how much, by when.
    expect(a.price).toEqual(USDC(10));
    expect(a.client).toBe("buyer_1");
    expect(a.provider).toBe("provider_1");
    expect(a.deadline).toBe("2027-01-01T00:00:00Z");
    // Transport would appear here. It does not, and that is the point: the
    // lifecycle is identical whether settlement is x402, MPP, a payment channel,
    // or a Solana vault. `settlementChains` on the Space is a *permission*, not a
    // binding to one rail.
    expect(Object.keys(a)).not.toContain("settlementChain");
    expect(Object.keys(a)).not.toContain("paymentRail");
    expect(Object.keys(a)).not.toContain("transport");
  });

  it("the same terms are admitted identically regardless of the Space's allowed rails", () => {
    const solanaOnly = space({ settlementChains: ["solana"] });
    const allRails = space({ settlementChains: ["solana", "base", "tempo"] });
    const a = admitsProposal(solanaOnly, { participant: "buyer_1", capability: "research", amount: USDC(10) });
    const b = admitsProposal(allRails, { participant: "buyer_1", capability: "research", amount: USDC(10) });
    expect(a.ok).toBe(b.ok);
  });
});
