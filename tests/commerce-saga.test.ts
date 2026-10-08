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
import { routeCommitment } from "@/lib/domain/canonical";
import { describe, expect, it, beforeEach } from "vitest";
import type { Money, Space } from "@/lib/domain/types";
import { openAgreement } from "@/lib/kernel/commerce";
import { REFUND_ROUTE } from "@/lib/kernel/commerce-recovery";
import { commitAgreementOp } from "@/lib/commerce/commit-op";
import type { AgreementOp } from "@/lib/kernel/commerce";
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

/**
 * Opens an agreement AND persists it, as the route does.
 *
 * The persist is not incidental. `commitAgreementOp` now writes the agreement (that is
 * the F77 fix — the agreement is what names the saga), and `PostgresRepository
 * .updateAgreement` is a strict UPDATE that throws `AGREEMENT_NOT_FOUND` when the row
 * is absent. The in-memory backend upserts, so a fixture that skipped this step passed
 * in memory and failed against Postgres. Persisting here means the fixture is honest on
 * both, which is the whole point of running these suites against a real database.
 */
// The NONCE matters as much as the counter, and for the same reason as in
// tests/torn-write-probe.test.ts: this suite is run against a REAL Postgres in CI, where
// `__resetStoreForTests` resets nothing and `mitra.agreements` has a PRIMARY KEY. A
// counter alone restarts at 1 every run and collides with the previous run's rows —
// which surfaces as `duplicate key value violates unique constraint "agreements_pkey"`,
// a failure that looks like a product bug and is not.
const OPENED_NONCE = Math.random().toString(36).slice(2, 8);
let openedCount = 0;

async function opened(repo: Awaited<ReturnType<typeof getStore>>["repo"]) {
  // The Space first: `saveAgreement` writes the `agreement_spaces` membership rows,
  // which carry a foreign key to `mitra.spaces`. Against Postgres the order is
  // enforced; in memory there is nothing to enforce it with.
  await repo.createSpace!(space());
  // A fresh id per call. The in-memory store keeps agreements in a Map, so re-using
  // `ag_1` just overwrote it; `mitra.agreements` has a PRIMARY KEY and refuses. Every
  // one of these fixture fixes is the same divergence (see F78), not a test bug.
  const r = openAgreement(space(), { ...draft, agreementId: `ag_${OPENED_NONCE}_${++openedCount}` }, { capability: "research", amount: USDC(10) });
  if (!r.ok) throw new Error(r.reason);
  await repo.saveAgreement!(r.value.agreement);
  return r.value;
}

// Goes through `commitAgreementOp` rather than the kernel, deliberately: the ordering
// guarantee F77 bought is a property of that function, so the tests exercise the same
// path the route does. Calling the pure kernel here would test a write order the
// product does not use, and would keep passing when the route's did.
const drive = async (repo: Awaited<ReturnType<typeof getStore>>["repo"], s: Space, a: Awaited<ReturnType<typeof opened>>["agreement"], op: AgreementOp, extra = {}) => {
  const r = await commitAgreementOp(repo, s, a, op, { capability: "research", amount: USDC(10), ...extra });
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
    const { agreement } = await opened(repo);
    const { saga, agreement: after } = await drive(repo, space(), agreement, "fund");

    expect(saga?.status, "an ARMED saga, not merely DECLARED").toBe("ARMED");
    expect(saga?.compensationRoutes).toEqual([REFUND_ROUTE.routeId]);
    expect(REFUND_ROUTE.maxAttempts, "§15.5 forbids a route that cannot run").toBeGreaterThan(0);
    expect(after.sagaIds).toEqual([saga!.sagaId]);
    expect(await repo.getSaga(saga!.sagaId)).not.toBeNull();
  });

  it("the commitment is recorded BEFORE execution, not invented at failure time", async () => {
    const { agreement } = await opened(repo);
    const { saga } = await drive(repo, space(), agreement, "fund");
    // Persisted, durable, and available to read back — the route was committed while
    // the agreement was still funded and nothing had failed.
    const persisted = await repo.getSaga(saga!.sagaId);
    expect(persisted?.status).toBe("ARMED");
  });

  it("startExecution advances the saga ARMED -> EXECUTING", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    expect(e.saga?.status).toBe("EXECUTING");
  });

  it("THE HAZARD TEST — rejection walks EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED", async () => {
    const { agreement } = await opened(repo);
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
    const { agreement } = await opened(repo);
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
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.agreement.status).toBe("REJECTED");
    expect(r.saga?.status).toBe("RECOVERED");
  });

  it("committed capital is returned to the Space budget", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    expect(f.space.committed.amount, "funding encumbers").toBe(10);
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.space.committed.amount, "a refund returns the encumbrance").toBe(0);
    expect(r.agreement.escrowReleased).toBe(true);
  });

  it("settledRef stays undefined — escrow release is not payment settlement (F46)", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const s = await drive(repo, e.space, e.agreement, "submitDeliverable");
    const r = await drive(repo, s.space, s.agreement, "rejectDeliverable");
    expect(r.agreement.escrowReleased).toBe(true);
    expect(r.agreement.settledRef, "nothing was paid, so nothing is settled").toBeUndefined();
  });

  it("the compensation route cannot be replayed (F47)", async () => {
    const { agreement } = await opened(repo);
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
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    const bad = await commitAgreementOp(repo, f.space, f.agreement, "startExecution", {
      capability: "research", amount: USDC(10_000), // over budget -> refused
    });
    expect(bad.ok).toBe(false);
    expect((await repo.getSaga(f.saga!.sagaId))?.status, "saga untouched").toBe("ARMED");
  });

  it("an accepted deliverable does NOT compensate — only rejection unwinds", async () => {
    const { agreement } = await opened(repo);
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

  it("funding with onChainEscrow pre-commits the on-chain refund route and sets escrowRef (PRD §15.5, ADR-0012)", async () => {
    const { agreement } = await opened(repo);
    const jobId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const onChainEscrow = {
      chain: "baseSepolia",
      contractAddress: "0x6a731a654423d64afb9839742c3e48c6c54eea9c",
      jobId,
      timeout: Math.floor(Date.now() / 1000) + 3600,
    };

    const f = await drive(repo, space(), agreement, "fund", { onChainEscrow });
    expect(f.agreement.escrowRef).toBe(jobId);
    expect(f.saga?.status).toBe("ARMED");

    const expectedRouteId = `route_refund_${jobId.slice(0, 10)}`;
    expect(f.saga?.compensationRoutes).toEqual([expectedRouteId]);

    // Start execution and advance to submit
    const e = await drive(repo, f.space, f.agreement, "startExecution");
    const sub = await drive(repo, e.space, e.agreement, "submitDeliverable");

    // Reject deliverable: walks through to RECOVERED with the on-chain route
    const r = await drive(repo, sub.space, sub.agreement, "rejectDeliverable", {
      onChainEscrow,
      failureReason: "ON_CHAIN_DELIVERABLE_REJECTED",
    });

    expect(r.agreement.status).toBe("REJECTED");
    expect(r.saga?.status).toBe("RECOVERED");
    expect(r.saga?.routeAttempts?.[expectedRouteId]).toBe(1);
  });
});


/**
 * PRD §15.5 — the funding commitment reaches the agreement, and it is the kernel's.
 */
describe("§15.5 — the on-chain refund route is committed at funding", () => {
  let repo: Awaited<ReturnType<typeof getStore>>["repo"];

  beforeEach(async () => {
    __resetLedgerForTests();
    __resetStoreForTests();
    ({ repo } = await getStore());
  });

  const jobId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const onChainEscrow = {
    chain: "baseSepolia",
    contractAddress: "0x6a731a654423d64afb9839742c3e48c6c54eea9c",
    jobId,
    timeout: Math.floor(Date.now() / 1000) + 3600,
  };

  it("records a non-zero 32-byte commitment derived from the refund route", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund", { onChainEscrow });
    expect(f.agreement.refundRouteHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(f.agreement.refundRouteHash).not.toBe(`0x${"0".repeat(64)}`);
    // The exact value the escrow account must be opened with.
    expect(f.agreement.refundRouteHash).toBe(
      routeCommitment(`evm:refundEscrow:${onChainEscrow.chain}:${onChainEscrow.contractAddress}:${jobId}`),
    );
  });

  it("the commitment is the saga's route commitment, not a second opinion", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund", { onChainEscrow });
    const routeId = `route_refund_${jobId.slice(0, 10)}`;
    expect(f.saga?.routeCommitments?.[routeId]).toBe(f.agreement.refundRouteHash);
  });

  it("a caller cannot supply its own commitment", async () => {
    // `refundRouteHash` is derived, never taken from the request: a caller-supplied
    // one would commit to a route other than the one compensated.
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund", {
      onChainEscrow,
      ...({ refundRouteHash: `0x${"ab".repeat(32)}` } as Record<string, unknown>),
    });
    expect(f.agreement.refundRouteHash).not.toBe(`0x${"ab".repeat(32)}`);
  });

  it("a different job id produces a different commitment", async () => {
    const a = await opened(repo);
    const fa = await drive(repo, space(), a.agreement, "fund", { onChainEscrow });
    const b = await opened(repo);
    const fb = await drive(repo, space(), b.agreement, "fund", {
      onChainEscrow: { ...onChainEscrow, jobId: `0x${"cd".repeat(32)}` },
    });
    expect(fa.agreement.refundRouteHash).not.toBe(fb.agreement.refundRouteHash);
  });

  it("an agreement funded without an on-chain escrow has no commitment", async () => {
    const { agreement } = await opened(repo);
    const f = await drive(repo, space(), agreement, "fund");
    expect(f.agreement.refundRouteHash).toBeUndefined();
    expect(f.agreement.escrowRef).toBeUndefined();
  });
});
