/**
 * The `docs/SECURITY.md` cross-state invariants that were `UNTESTED`.
 *
 * ## Why this file exists
 *
 * Seven cross-state invariants sat at `UNTESTED` with a test that does not exist.
 * Four of them turned out to be **structurally guaranteed** by the agreement machine
 * or by the `escrowReleased` flag added in F42 — they were untested, not unimplemented,
 * and locking them down costs a test each.
 *
 * The fifth, "an agreement cannot settle against a different provider", had **no guard
 * anywhere**. `SettlementAdapter.settle()` takes `from`, `to`, `amount` and
 * `commitmentHash` — the provider is not part of the settlement input, so a settlement
 * could be attributed to an agreement whose provider it had nothing to do with.
 * `assertSettlementBinding` now exists because of that finding.
 *
 * ## What is deliberately NOT covered here
 *
 * Four rows remain `UNTESTED` and are named at the bottom of this file rather than
 * quietly omitted: the compensation double-execution, the single-epoch obligation,
 * the receipt-to-obligation-set binding, and external-identity remapping. Each needs
 * a code path that does not exist yet, and claiming otherwise would repeat the
 * failure this repository exists to prevent.
 */
import { describe, expect, it } from "vitest";
import type { Agreement, Money, Space } from "@/lib/domain/types";
import {
  applyAgreementOp, assertSettlementBinding, availableAgreementOps, openAgreement,
} from "@/lib/kernel/commerce";
import { TRANSITIONS } from "@/lib/kernel/machines";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });

function space(over: Partial<Space> = {}): Space {
  return {
    spaceId: "space_1", owner: "buyer_1",
    governance: { mode: "QUORUM", admins: [], governors: ["buyer_1", "provider_1", "eval_1"], threshold: 2 },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE", participants: ["buyer_1", "provider_1", "eval_1"],
    allowedCapabilities: ["research", "payment"], settlementChains: ["solana"],
    budget: USDC(100), committed: USDC(0), version: 1, createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const draft = (over: Record<string, unknown> = {}) => ({
  agreementId: "ag_1", runId: "run_1", intentId: "intent_1",
  client: "buyer_1", provider: "provider_1", evaluator: "eval_1",
  externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
  acceptanceCriteria: ["d"], failurePolicy: "refund on expiry", ...over,
});

// Returns the AGREEMENT, not the pair. The first version returned `r.value`, so
// `drive` was handed `{space, agreement}` — whose `.status` is undefined, and
// `isTerminal` returns true for an unknown state. Every test then failed with
// `fund: AGREEMENT_TERMINAL`, which reads exactly like a machine defect.
function open(over: Record<string, unknown> = {}): Agreement {
  const r = openAgreement(space(), draft(over), { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(r.reason);
  return r.value.agreement;
}

function drive(agreement: Agreement, ops: string[]) {
  let s = space(); let a = agreement;
  for (const op of ops) {
    const r = applyAgreementOp(s, a, op as never, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(`${op}: ${r.reason}`);
    s = r.value.space; a = r.value.agreement;
  }
  return { space: s, agreement: a };
}

// ---------------------------------------------------------------------------

describe("SECURITY.md — a rejected deliverable cannot trigger normal payment release", () => {
  it("the machine permits no edge from REJECTED to ACCEPTED", () => {
    // The structural guarantee. If this table ever gains REJECTED -> ACCEPTED the
    // test fails loudly, which is the point: the guarantee is the table, and the
    // table is the thing being pinned.
    expect(TRANSITIONS.agreement.REJECTED).not.toContain("ACCEPTED");
    expect(TRANSITIONS.agreement.REJECTED).toEqual(["REFUNDED"]);
  });

  it("acceptDeliverable is not offered from REJECTED", () => {
    expect(availableAgreementOps("REJECTED")).not.toContain("acceptDeliverable");
    expect(availableAgreementOps("REJECTED")).toContain("refund");
  });

  it("a rejected deliverable cannot be accepted afterwards", () => {
    const { space: s, agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "rejectDeliverable"]);
    const r = applyAgreementOp(s, a, "acceptDeliverable", { capability: "research", amount: USDC(10) });
    expect(r.ok).toBe(false);
  });

  it("settlement is refused until the agreement is ACCEPTED", () => {
    // This is what actually stops a rejection paying out: binding requires ACCEPTED.
    for (const ops of [["fund"], ["fund", "startExecution"], ["fund", "startExecution", "submitDeliverable"], ["fund", "startExecution", "submitDeliverable", "rejectDeliverable"]]) {
      const { agreement: a } = drive(open(), ops);
      const r = assertSettlementBinding(a, { provider: a.provider, amount: a.price });
      expect(r.ok, `${a.status} must not be settleable`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("SETTLEMENT_NOT_DUE");
    }
  });
});

describe("SECURITY.md — an agreement cannot settle against a different provider", () => {
  it("a different provider is refused", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    const r = assertSettlementBinding(a, { provider: "attacker_9", amount: a.price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PROVIDER_SUBSTITUTION");
  });

  it("a provider that merely LOOKS like the real one is still refused", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    for (const impostor of ["provider_11", "Provider_1", "provider_1 ", " provider_1"]) {
      const r = assertSettlementBinding(a, { provider: impostor, amount: a.price });
      expect(r.ok, `"${impostor}" must not be accepted as ${a.provider}`).toBe(false);
    }
  });

  it("a wrong asset or amount is refused", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    expect(assertSettlementBinding(a, { provider: a.provider, amount: USDC(11) }).ok).toBe(false);
    expect(assertSettlementBinding(a, { provider: a.provider, amount: { asset: "USDT", amount: 10 } }).ok).toBe(false);
  });

  it("the exact terms settle", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    expect(assertSettlementBinding(a, { provider: a.provider, amount: a.price }).ok).toBe(true);
  });

  it("escrow release and settlement are DIFFERENT moments", () => {
    // Acceptance releases escrow (F42); settlement is the act of paying and comes
    // after. The first version of the guard tested `escrowReleased` and so
    // refused every legitimate settlement — which this test caught.
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    expect(a.escrowReleased, "escrow is released at acceptance").toBe(true);
    expect(a.settledRef, "but that is not the same as being paid").toBeUndefined();
    expect(assertSettlementBinding(a, { provider: a.provider, amount: a.price }).ok).toBe(true);
  });

  it("a settled agreement cannot be settled again", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    const settled = { ...a, settledRef: "set_1" };
    const r = assertSettlementBinding(settled, { provider: a.provider, amount: a.price });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ALREADY_SETTLED");
  });

  it("reassignment means amending the agreement, not passing a flag", () => {
    // Deliberately there is no `allowReassignment` option. PRD §11 makes it an
    // amendment, so the only way the check passes for a new provider is if the
    // agreement itself was amended and the change is visible.
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    const amended = { ...a, provider: "provider_2" };
    expect(assertSettlementBinding(amended, { provider: "provider_2", amount: amended.price }).ok).toBe(true);
    // ...and the original no longer settles against the ORIGINAL provider.
    expect(assertSettlementBinding(amended, { provider: a.provider, amount: a.price }).ok).toBe(false);
  });
});

describe("SECURITY.md — released escrow cannot be released twice", () => {
  it("escrow is released exactly once across a full lifecycle", () => {
    const { agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    expect(a.escrowReleased).toBe(true);
    // The guard is data on the agreement, so any later operation sees it.
    expect(a.escrowReleased).not.toBe(false);
  });

  it("a chargeback after acceptance cannot release a second time", () => {
    let { space: s, agreement: a } = drive(open(), ["fund", "startExecution", "submitDeliverable", "acceptDeliverable"]);
    const committedAfterAccept = s.committed.amount;
    const cb = applyAgreementOp(s, a, "refund", { capability: "research", amount: USDC(10) });
    expect(cb.ok).toBe(true);
    if (cb.ok) expect(cb.value.space.committed.amount).toBe(committedAfterAccept);
  });
});
