/**
 * F49 Step 2 — Layer A coupling: a real rejection drives the recovery kernel.
 *
 * ## The assertion this file exists to make
 *
 * NOT "a saga row exists". A saga declared and armed but never stepped proves nothing
 * about PRD §4.5 — that is the F44/F48 trap, and it would pass while §4.5 stayed
 * completely unenforced.
 *
 * The condition under test:
 *
 *   "A rejected deliverable drove the saga from EXECUTING through STEP_FAILURE and
 *    COMPENSATING to terminal compensation, with zero unhandled exceptions."
 *
 * So every lifecycle test below asserts the saga's **status after each real
 * commercial operation**, driven through `applyAgreementOpWithSaga` — the same entry
 * point production would use.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { Money, Space } from "@/lib/domain/types";
import { openAgreement } from "@/lib/kernel/commerce";
import { applyAgreementOpWithSaga, REFUND_ROUTE } from "@/lib/kernel/commerce-recovery";
import { __resetLedgerForTests, getLedger } from "@/lib/store/ledger";
import { __resetStoreForTests, getStore } from "@/lib/store/provider";

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

const draft = {
  agreementId: "ag_1", runId: "run_1", intentId: "intent_1",
  client: "buyer_1", provider: "provider_1", evaluator: "eval_1",
  externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
  acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
};

async function opened() {
  const r = openAgreement(space(), draft, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

const drive = async (repo: Awaited<ReturnType<typeof getStore>>["repo"], s: Space, a: Awaited<ReturnType<typeof opened>>["agreement"], op: Parameters<typeof applyAgreementOpWithSaga>[3], extra = {}) => {
  const r = await applyAgreementOpWithSaga(repo, s, a, op, { capability: "research", amount: USDC(10), ...extra });
  if (!r.ok) throw new Error(`${op}: ${r.reason}`);
  return r.value;
};

describe("F49 Step 2 — a rejected deliverable drives the saga to terminal compensation", () => {
  let repo: Awaited<ReturnType<typeof getStore>>["repo"];

  beforeEach(async () => {
    __resetLedgerForTests();
    __resetStoreForTests();
    ({ repo } = await getStore());
  });

  it("funding declares AND ARMS a saga with a pre-committed route (§15.5)", async () => {
    const { agreement } = await opened();
    const { saga, agreement: after } = await drive(repo, space(), agreement, "fund");

    expect(saga?.status, "an ARMED saga, not merely DECLARED").toBe("ARMED");
    expect(saga?.compensationRoutes).toEqual([REFUND_ROUTE.routeId]);
    expect(REFUND_ROUTE.maxAttempts, "§15.5 forbids a route that cannot run").toBeGreaterThan(0);
    expect(after.sagaIds).toEqual([saga!.sagaId]);
    expect(await repo.getSaga(saga!.sagaId)).not.toBeNull();
  });

  it("the commitment is recorded BEFORE execution, not invented at failure time", async () => {
    const { agreement } = await opened();
    const { saga } = await drive(repo, space(), agreement, "fund");
    // Persisted, durable, and available to read back — the route was committed while
    // the agreement was still funded and nothing had failed.
    const persisted = await repo.getSaga(saga!.sagaId);
    expect(persisted?.status).toBe("ARMED");
  });

  it("startExecution advances the saga ARMED -> EXECUTING", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    expect(e.saga?.status).toBe("EXECUTING");
  });

  it("THE HAZARD TEST — rejection walks EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    expect(e.saga?.status).toBe("EXECUTING");
    // The agreement must be SUBMITTED before it can be rejected. The first version
    // tried to reject from EXECUTING and the machine refused it — correctly, since a
    // deliverable cannot be rejected before one exists.
    const sub = await drive(repo, e.space, e.agreement, "submitDeliverable");

    const r = await drive(repo, sub.space, sub.agreement, "rejectDeliverable", { failureReason: "DELIVERABLE_FAILED_EVALUATION" });

    // Terminal, and reached through the machine rather than by assignment.
    expect(r.saga?.status).toBe("RECOVERED");
    // The deliverable step went FAILED -> COMPENSATED. `compensate` flips it, so
    // asserting FAILED here would be asserting a mid-flight state as if it were
    // terminal; the first version did exactly that and failed.
    const step = r.saga!.steps.find((s) => s.stepId === "deliver");
    expect(step?.state).toBe("COMPENSATED");
    // The reason survives the compensation, so the record says WHY it unwound.
    expect(step?.failureReason).toBe("DELIVERABLE_FAILED_EVALUATION");
    // The step it did NOT touch is untouched — compensation is not a blanket reset.
    expect(r.saga!.steps.find((s) => s.stepId === "execute")?.state).not.toBe("COMPENSATED");
  });

  it("the saga reached RECOVERED by walking the machine, not by being set", async () => {
    // Evidence the intermediate states really existed. `recordStep` produces
    // STEP_FAILURE and `beginCompensation` produces COMPENSATING; if either were
    // skipped, `compensate` would have refused (`SAGA_NOT_COMPENSATING`).
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const sub = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, sub.space, sub.agreement, "rejectDeliverable");
    expect(r.saga?.status).toBe("RECOVERED");
    expect(r.saga?.version, "four transitions, so version advanced past ARMED").toBeGreaterThanOrEqual(3);
  });

  it("zero unhandled exceptions across the whole failure lifecycle", async () => {
    // Every step above returns a Result. This asserts none of them threw, by running
    // the full chain without a single try/catch of our own.
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.agreement.status).toBe("REJECTED");
    expect(r.saga?.status).toBe("RECOVERED");
  });

  it("committed capital is returned to the Space budget", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    expect(f.space.committed.amount, "funding encumbers").toBe(10);
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.space.committed.amount, "a refund returns the encumbrance").toBe(0);
    expect(r.agreement.escrowReleased).toBe(true);
  });

  it("settledRef stays undefined — escrow release is not payment settlement (F46)", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.agreement.escrowReleased).toBe(true);
    expect(r.agreement.settledRef, "nothing was paid, so nothing is settled").toBeUndefined();
  });

  it("the compensation route cannot be replayed (F47)", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.saga?.routeAttempts?.[REFUND_ROUTE.routeId]).toBe(1);

    const { compensate, beginCompensation } = await import("@/lib/kernel/recovery");

    // Two independent refusals, because the saga is terminal now:
    //   (a) re-entering recovery is refused at beginCompensation;
    //   (b) and were it not terminal, the spent attempt alone would refuse it.
    const reenter = beginCompensation(r.saga!);
    expect(reenter.ok).toBe(false);

    // Put a saga in COMPENSATING that has ALREADY spent its attempt, and confirm the
    // F47 guard refuses. This is the case that matters: the F44/F48 shape is a
    // correct guard that nothing exercises.
    const spent = { ...r.saga!, status: "COMPENSATING" as const };
    const again = compensate(spent, {
      routeId: REFUND_ROUTE.routeId, outcome: "RECOVERED", availableRoutes: [REFUND_ROUTE],
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("COMPENSATION_ROUTE_EXHAUSTED");
  });

  it("a commercial move the machine refuses does not advance the saga", async () => {
    // Commercial transition FIRST. If the saga moved independently, a rejected
    // `startExecution` would still drive a saga to EXECUTING.
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const bad = await applyAgreementOpWithSaga(repo, f.space, f.agreement, "startExecution", {
      capability: "research", amount: USDC(10_000), // over budget -> refused
    });
    expect(bad.ok).toBe(false);
    expect((await repo.getSaga(f.saga!.sagaId))?.status, "saga untouched").toBe("ARMED");
  });

  it("an accepted deliverable does NOT compensate — only rejection unwinds", async () => {
    const { agreement } = await opened();
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const a = await drive(repo, s.space, s.agreement, "acceptDeliverable");
    expect(a.agreement.status).toBe("ACCEPTED");
    expect(a.saga?.status, "acceptance is not a failure").not.toBe("RECOVERED");
  });

  it("an agreement with an EMPTY failurePolicy still gets a saga, deliberately", async () => {
    // The handoff suggested "if failurePolicy is present". We arm one either way, and
    // that is a deliberate disagreement:
    //
    //   §15.5 requires a saga with more than one step to declare a compensation route.
    //   Funding a two-step agreement therefore REQUIRES one. Skipping it when
    //   `failurePolicy` happens to be an empty string would make the presence of a
    //   recovery path depend on an optional prose field — so a blank field would leave
    //   escrow with no unwind, which is the orphaned-escrow failure this whole layer
    //   exists to prevent.
    //
    //   The empty policy becomes the DEFAULT policy rather than an absent saga.
    const r = openAgreement(space(), { ...draft, failurePolicy: "" }, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(r.reason);
    const f = await drive(repo, space(), r.value.agreement, "fund");
    expect(f.saga?.status, "a funded multi-step agreement is never left without a route").toBe("ARMED");
    expect(f.saga?.timeoutPolicy, "an empty policy falls back to a default").toBeTruthy();
    expect(f.agreement.status).toBe("FUNDED");
  });
});
