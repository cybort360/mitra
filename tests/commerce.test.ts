/**
 * Phase 4 — commerce lifecycle (PRD exit condition).
 *
 * > "Real job can be opened, funded, submitted, accepted, rejected, refunded."
 *
 * Two things are under test that the types alone could not express:
 *
 *   1. Every status change actually goes through the state machine. Before this,
 *      `transition()` was called only from tests, so a lifecycle could be written
 *      that set `status` directly and nothing would object. The tests below
 *      therefore assert on *illegal* transitions being refused, which is the only
 *      way to prove the machine is consulted.
 *   2. Every operation is scoped to a Space (PRD 13.1). An agent admitted to one
 *      engagement must not be implicitly admitted to all of them.
 *
 * Written to be mutation-auditable: each guard has a test that goes red when the
 * guard is deleted.
 */
import { describe, expect, it } from "vitest";
import type { Agreement, Money, Space } from "@/lib/domain/types";
import {
  admitsProposal,
  applyAgreementOp,
  availableAgreementOps,
  evaluateDeliverable,
  openAgreement,
} from "@/lib/kernel/commerce";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });

/** A QUORUM Space by default: two of three must agree. Neither can freeze the other. */
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

function opened(over: Partial<Space> = {}) {
  const r = openAgreement(space(over), draft, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(`fixture failed to open: ${r.reason}`);
  return r.value;
}

/** Drives the full happy path, returning the final pair. */
function runToAccepted() {
  let { space: s, agreement: a } = opened();
  for (const op of ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"] as const) {
    const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(`fixture failed at ${op}: ${r.reason}`);
    s = r.value.space;
    a = r.value.agreement;
  }
  return { space: s, agreement: a };
}

describe("the Phase 4 exit condition, end to end", () => {
  it("open -> fund -> submit -> accept", () => {
    const { agreement } = runToAccepted();
    expect(agreement.status).toBe("ACCEPTED");
  });

  it("open -> fund -> submit -> reject -> refund", () => {
    let { space: s, agreement: a } = opened();
    for (const op of ["fund", "startExecution", "submitDeliverable", "rejectDeliverable", "refund"] as const) {
      const r = applyAgreementOp(s, a, op, { capability: "research", amount: USDC(10) });
      expect(r.ok, `${op}: ${r.ok ? "" : r.reason}`).toBe(true);
      if (r.ok) { s = r.value.space; a = r.value.agreement; }
    }
    expect(a.status).toBe("REFUNDED");
  });

  it("a new agreement is born OPEN and bumps the Space version", () => {
    const { space: s, agreement: a } = opened();
    expect(a.status).toBe("OPEN");
    // The Space does NOT carry a list of its agreements. `Agreement.spaceId` plus
    // a query is the relationship; a second copy would be a second thing to drift.
    expect(a.spaceId).toBe("space_1");
    expect(s.version).toBe(2);
  });
});

describe("the state machine is actually consulted", () => {
  it("refuses an illegal edge: OPEN cannot jump to ACCEPTED", () => {
    const { space: s, agreement: a } = opened();
    // If `applyAgreementOp` bypassed `transition()`, this would succeed.
    const r = applyAgreementOp(s, a, "acceptDeliverable");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ACCEPTED|ILLEGAL|transition/i);
  });

  it("a terminal agreement accepts no further operations", () => {
    const { space: s, agreement: a } = runToAccepted();
    const r = applyAgreementOp(s, a, "refund");
    // ACCEPTED -> REFUNDED IS legal per the table, so this must SUCCEED; the
    // terminal check is about fully-terminal states. Assert the table's own
    // answer rather than an assumption about which states are dead.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.agreement.status).toBe("REFUNDED");

    const after = applyAgreementOp(r.ok ? r.value.space : s, r.ok ? r.value.agreement : a, "fund");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("AGREEMENT_TERMINAL");
  });

  it("availableAgreementOps agrees with the machine, not a hand-written list", () => {
    const ops = availableAgreementOps("SUBMITTED");
    expect(ops).toContain("acceptDeliverable");
    expect(ops).toContain("rejectDeliverable");
    expect(ops).not.toContain("fund");
    // A terminal state offers nothing.
    expect(availableAgreementOps("REFUNDED")).toEqual([]);
  });
});

describe("Space containment (PRD 13.1)", () => {
  it("refuses a participant who is not in the Space", () => {
    const r = openAgreement(space(), { ...draft, client: "stranger_9" }, { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PARTICIPANT_NOT_IN_SPACE");
  });

  it("refuses a capability the Space does not allow", () => {
    const r = openAgreement(space(), draft, { capability: "bridge", amount: USDC(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("CAPABILITY_NOT_ALLOWED_IN_SPACE");
  });

  it("refuses when the Space budget would be exceeded", () => {
    const r = openAgreement(space({ committed: USDC(95) }), { ...draft, price: USDC(10) }, { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("SPACE_BUDGET_EXCEEDED");
  });

  it("refuses a suspended Space", () => {
    const r = openAgreement(space({ status: "SUSPENDED" }), draft, { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("SPACE_NOT_ACTIVE");
  });

  it("the four containment refusals are distinguishable", () => {
    // Merging these into one 'not allowed' would make a misconfigured Space
    // indistinguishable from an over-budget one.
    const reasons = [
      admitsProposal(space({ status: "CLOSED" }), { participant: "buyer_1", capability: "research", amount: USDC(1) }),
      admitsProposal(space(), { participant: "stranger", capability: "research", amount: USDC(1) }),
      admitsProposal(space(), { participant: "buyer_1", capability: "bridge", amount: USDC(1) }),
      admitsProposal(space({ committed: USDC(100) }), { participant: "buyer_1", capability: "research", amount: USDC(1) }),
    ].map((r) => (r.ok ? "OK" : r.reason));
    expect(new Set(reasons).size).toBe(4);
  });

  it("refund is exempt from the admission checks so capital is never stranded", () => {
    // **The first version of this test passed for the wrong reason.** It used a
    // Space at its budget ceiling and asserted the refund succeeded — but it
    // passed no amount, so `admitsProposal` compared `0 + 100 > 100` and was
    // satisfied anyway. The budget check never fired, so deleting the exemption
    // broke nothing and the mutation audit caught the hole.
    //
    // A refund must be tested against a Space that would *definitely* refuse the
    // proposal without the exemption. A suspended Space is the realistic case:
    // the context is closed, and the capital still has to come out.
    const { space: s, agreement: a } = opened();
    const funded = applyAgreementOp(s, a, "fund", { capability: "research", amount: USDC(10) });
    if (!funded.ok) throw new Error(`fixture: ${funded.reason}`);

    const suspended = { ...funded.value.space, status: "SUSPENDED" as const };

    // Prove the guard WOULD refuse this proposal — otherwise the assertion below
    // is vacuous, which is exactly how the first version fooled itself.
    const wouldRefuse = admitsProposal(suspended, {
      participant: "buyer_1", capability: "research", amount: USDC(10),
    });
    expect(wouldRefuse.ok, "the fixture must actually fail admission").toBe(false);

    const r = applyAgreementOp(suspended, funded.value.agreement, "refund", {
      capability: "research", amount: USDC(10),
    });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (r.ok) expect(r.value.agreement.status).toBe("REFUNDED");
  });

  it("the admitted amount and the recorded price must agree", () => {
    // Otherwise containment was checked against one number and the agreement
    // enforces another.
    const r = openAgreement(space(), { ...draft, price: USDC(999) }, { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PRICE_AMOUNT_MISMATCH");
  });
});

describe("deliverable evaluation", () => {
  const agreement = { ...draft, status: "SUBMITTED", version: 1 } as unknown as Agreement;
  const good = {
    deliverableId: "d_1", agreementId: "ag_1", provider: "provider_1",
    artifactRefs: ["ipfs://x"], contentHash: "abc", evidenceRefs: [],
    submittedAt: "2026-02-01T00:00:00Z", accepted: false, version: 1,
  };
  const NOW = new Date("2026-02-01T00:00:00Z");

  it("accepts a complete, on-time, linked deliverable", () => {
    expect(evaluateDeliverable(agreement, good, NOW)).toEqual({ ok: true, value: true });
  });

  it("refuses a deliverable with no content hash", () => {
    expect(evaluateDeliverable(agreement, { ...good, contentHash: "" }, NOW)).toEqual({ ok: false, reason: "DELIVERABLE_EMPTY" });
  });

  it("refuses a late deliverable", () => {
    const late = new Date("2028-01-01T00:00:00Z");
    expect(evaluateDeliverable(agreement, good, late)).toEqual({ ok: false, reason: "DELIVERABLE_LATE" });
  });

  it("refuses a deliverable belonging to another agreement", () => {
    expect(evaluateDeliverable(agreement, { ...good, agreementId: "other" }, NOW)).toEqual({ ok: false, reason: "WRONG_AGREEMENT" });
  });

  it("refuses a deliverable with no artifacts", () => {
    expect(evaluateDeliverable(agreement, { ...good, artifactRefs: [] }, NOW)).toEqual({ ok: false, reason: "DELIVERABLE_HAS_NO_ARTIFACTS" });
  });
});
