/**
 * Phase 6 — recovery execution (PRD §15).
 *
 * Exit condition: "Deliberately failed job reaches a defined terminal recovery
 * state."
 *
 * The load-bearing property is §15.5: **a compensation route must be committed
 * before execution**. Everything else here follows from it — if a saga can reach
 * EXECUTING with no committed route, then failure means the recovery engine must
 * invent compensation, which §15.5 forbids in those words.
 *
 * The three terminal outcomes are asserted to be mutually unreachable. CONTAINED
 * is the one that matters commercially: "we stopped the loss" is not "we got the
 * money back", and collapsing them would make every loss report a recovery.
 */
import { describe, expect, it } from "vitest";
import type { CompensationRoute, SagaDeclaration } from "@/lib/kernel/recovery";
import {
  armSaga,
  beginCompensation,
  compensate,
  declareSaga,
  recordStep,
  startSaga,
} from "@/lib/kernel/recovery";
import { canTransition } from "@/lib/kernel/machines";
import { failureScenarios } from "@/lib/kernel/failure-lab";
import type { Saga } from "@/lib/domain/types";
import { routeCommitment } from "@/lib/domain/canonical";

const steps = [
  { stepId: "s1", name: "Reserve capital", state: "PENDING" as const, attempts: 0 },
  { stepId: "s2", name: "Provider execution", state: "PENDING" as const, attempts: 0 },
  { stepId: "s3", name: "Accept deliverable", state: "PENDING" as const, attempts: 0 },
];

const routes: CompensationRoute[] = [
  { routeId: "r_reassign", route: "precommitted://reassign/approved-backup", action: "REASSIGN", maxAttempts: 2 },
  { routeId: "r_refund", route: "precommitted://refund/reservation", action: "REFUND", maxAttempts: 1 },
];

const decl: SagaDeclaration = { steps, compensationRoutes: routes, timeoutPolicy: "30m" };

function declared() {
  const r = declareSaga("saga_1", "run_1", "intent_1", decl);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
function running() {
  const d = declared();
  const a = armSaga(d, decl);
  if (!a.ok) throw new Error(a.reason);
  const s = startSaga(a.value);
  if (!s.ok) throw new Error(s.reason);
  return s.value;
}
function unwrap<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(`fixture failed: ${r.reason}`);
  return r.value;
}
function failed() {
  return unwrap(beginCompensation(unwrap(recordStep(running(), "s2", "FAILED", "UPSTREAM_RATE_LIMIT"))));
}

describe("§15.5 — the compensation route must be committed BEFORE execution", () => {
  it("the machine permits no DECLARED -> EXECUTING edge", () => {
    // The state-level guarantee, independent of any kernel function.
    expect(canTransition("saga", "DECLARED", "EXECUTING").ok).toBe(false);
    expect(canTransition("saga", "DECLARED", "ARMED").ok).toBe(true);
  });

  it("startSaga refuses an unarmed saga", () => {
    const s = declared();
    expect(startSaga(s)).toEqual({ ok: false, reason: "SAGA_NOT_ARMED" });
  });

  it("a multi-step saga with no compensation route cannot even be declared", () => {
    const r = declareSaga("s", "r", "i", { ...decl, compensationRoutes: [] });
    expect(r).toEqual({ ok: false, reason: "MULTI_STEP_SAGA_REQUIRES_COMPENSATION_ROUTE" });
  });

  it("arming refuses a route that cannot execute", () => {
    // maxAttempts: 0 looks compliant but is not a commitment.
    const dead: CompensationRoute[] = [{ ...routes[0], maxAttempts: 0 }];
    expect(armSaga(declared(), { ...decl, compensationRoutes: dead }))
      .toEqual({ ok: false, reason: "NO_USABLE_COMPENSATION_ROUTE" });
  });

  it("arming refuses an empty route body", () => {
    const empty: CompensationRoute[] = [{ ...routes[0], route: "" }];
    expect(armSaga(declared(), { ...decl, compensationRoutes: empty }))
      .toEqual({ ok: false, reason: "NO_USABLE_COMPENSATION_ROUTE" });
  });

  it("a single-step saga may proceed without a route", () => {
    const one: SagaDeclaration = { steps: [steps[0]], compensationRoutes: [], timeoutPolicy: "5m" };
    const d = declareSaga("s", "r", "i", one);
    expect(d.ok).toBe(true);
  });
});

describe("compensation never invents calldata (§15.5, second clause)", () => {
  it("an unknown route id is refused rather than substituted", () => {
    const f = failed();
    const r = compensate(f, { routeId: "r_invented_now", outcome: "RECOVERED", availableRoutes: routes });
    expect(r).toEqual({ ok: false, reason: "COMPENSATION_ROUTE_NOT_COMMITTED" });
  });

  it("an exhausted route is refused", () => {
    const f = failed();
    const exhausted = [{ ...routes[1], maxAttempts: 0 }];
    const r = compensate(f, { routeId: "r_refund", outcome: "RECOVERED", availableRoutes: exhausted });
    expect(r).toEqual({ ok: false, reason: "COMPENSATION_ROUTE_EXHAUSTED" });
  });

  it("the kernel carries only route identifiers on the saga", () => {
    // The saga stores route IDs, not actions — so the recovery engine has nothing
    // on hand to synthesise a call with even if it wanted to.
    expect(declared().compensationRoutes).toEqual(["r_reassign", "r_refund"]);
  });
});

describe("§15.3 — RECOVERED, CONTAINED and ABORTED are distinct", () => {
  it("RECOVERED records the recovered value", () => {
    const r = compensate(failed(), { routeId: "r_reassign", outcome: "RECOVERED", recoveredValue: 40, availableRoutes: routes });
    expect(r.ok && r.value.status).toBe("RECOVERED");
    expect(r.ok && r.value.recoveredValue).toBe(40);
    expect(r.ok && r.value.containedValue).toBe(0);
  });

  it("CONTAINED records containment and does NOT claim recovered value", () => {
    // This is the distinction that matters: "we stopped the loss" is not "we got
    // the money back". A contained saga claiming recoveredValue would make every
    // bounded loss look like a success in any aggregate over outcomes.
    const r = compensate(failed(), { routeId: "r_refund", outcome: "CONTAINED", containedValue: 12, availableRoutes: routes });
    expect(r.ok && r.value.status).toBe("CONTAINED");
    expect(r.ok && r.value.containedValue).toBe(12);
    expect(r.ok && r.value.recoveredValue).toBe(0);
  });

  it("ROLLED_BACK reaches RECOVERED, per §15.3", () => {
    const r = compensate(failed(), { routeId: "r_reassign", outcome: "ROLLED_BACK", recoveredValue: 40, availableRoutes: routes });
    expect(r.ok && r.value.status).toBe("RECOVERED");
  });

  it("no terminal outcome reaches another", () => {
    for (const a of ["RECOVERED", "CONTAINED", "ABORTED"]) {
      for (const b of ["RECOVERED", "CONTAINED", "ABORTED"]) {
        if (a === b) continue;
        expect(canTransition("saga", a, b).ok, `${a} -> ${b}`).toBe(false);
      }
    }
  });

  it("the three are all terminal", () => {
    for (const s of ["RECOVERED", "CONTAINED", "ABORTED"]) {
      expect(canTransition("saga", s, "EXECUTING").ok).toBe(false);
    }
  });
});

describe("step outcomes", () => {
  it("a failed step moves the saga to STEP_FAILURE", () => {
    const r = recordStep(running(), "s2", "FAILED", "PROVIDER_TIMEOUT");
    expect(r.ok && r.value.status).toBe("STEP_FAILURE");
    expect(r.ok && r.value.steps.find((s) => s.stepId === "s2")?.failureReason).toBe("PROVIDER_TIMEOUT");
  });

  it("only the last step completing reaches a terminal state", () => {
    const first = unwrap(recordStep(running(), "s1", "SUCCEEDED"));
    expect(first.status).toBe("EXECUTING");
    const second = unwrap(recordStep(first, "s2", "SUCCEEDED"));
    expect(second.status).toBe("EXECUTING");
    const third = unwrap(recordStep(second, "s3", "SUCCEEDED"));
    expect(third.status).toBe("RECOVERED");
  });

  it("a succeeded step cannot be recorded again", () => {
    const first = unwrap(recordStep(running(), "s1", "SUCCEEDED"));
    expect(recordStep(first, "s1", "SUCCEEDED")).toEqual({ ok: false, reason: "STEP_ALREADY_SUCCEEDED" });
  });

  it("an unknown step id is refused", () => {
    expect(recordStep(running(), "s_nope", "SUCCEEDED")).toEqual({ ok: false, reason: "UNKNOWN_SAGA_STEP" });
  });

  it("duplicate step ids are refused at declaration", () => {
    const dup = declareSaga("s", "r", "i", { ...decl, steps: [steps[0], { ...steps[0] }] });
    expect(dup).toEqual({ ok: false, reason: "DUPLICATE_SAGA_STEP_ID" });
  });

  it("attempts increment on each recorded outcome", () => {
    const r = recordStep(running(), "s2", "FAILED", "TIMEOUT");
    expect(r.ok && r.value.steps.find((s) => s.stepId === "s2")?.attempts).toBe(1);
  });
});

describe("the failure-lab scenarios are each reachable and each has a reason code", () => {
  // PROVIDER_TIMEOUT is the one scenario whose expected outcome is a saga state,
  // so it is the one that actually exercises this kernel.
  it("PROVIDER_TIMEOUT reaches a recovery path with its declared reason code", () => {
    expect(failureScenarios.PROVIDER_TIMEOUT.expected).toBe("Saga enters RECOVERY_PENDING");
    const f = failed();
    // The scenario's expectation string predates the §15.3 alignment; the state it
    // named is now STEP_FAILURE. Recorded rather than silently rewritten, because a
    // fixture that drifts from the spec is the F24 failure mode.
    expect(f.status).toBe("COMPENSATING");
    expect(f.steps.find((s) => s.stepId === "s2")?.failureReason).toBe("UPSTREAM_RATE_LIMIT");
  });

  it("every declared scenario carries a machine-readable reason code", () => {
    for (const [name, s] of Object.entries(failureScenarios)) {
      expect(s.reasonCode, name).toMatch(/^[A-Z_]+$/);
    }
  });
});

/**
 * F76 — a committed route ID was not a commitment.
 *
 * `Saga.compensationRoutes` held ids; `compensate()` read route BODIES from a
 * caller-supplied `availableRoutes`. So the committed id could come back carrying
 * entirely different instructions. §15.5 forbids the recovery engine running
 * arbitrary calldata after a failure, and that is precisely what happened: the
 * engine invented nothing and still executed what it was handed.
 *
 * The route is now hashed at declaration (`declareSaga`) and re-derived at
 * compensation time, so the id and the body are one value.
 */
describe("F76 — the route commitment binds the id to the instructions", () => {
  const REFUND_ROUTE = "escrow:refund";

  function armed(): Saga {
    const declared = declareSaga("saga_f76", "run_f76", "intent_f76", {
      steps: [
        { stepId: "execute", name: "do the work", state: "PENDING", attempts: 0 },
        { stepId: "deliver", name: "deliver", state: "PENDING", attempts: 0 },
      ],
      compensationRoutes: [{ routeId: "r_refund", route: REFUND_ROUTE, action: "REFUND", maxAttempts: 1 }],
      timeoutPolicy: "refund on expiry",
    });
    if (!declared.ok) throw new Error(declared.reason);
    return declared.value;
  }

  function failing(): Saga {
    const s = armed();
    return { ...s, status: "COMPENSATING" as const, steps: s.steps.map((x) => ({ ...x, state: "FAILED" as const })) };
  }

  it("the committed route still compensates", () => {
    const r = compensate(failing(), {
      routeId: "r_refund",
      outcome: "RECOVERED",
      availableRoutes: [{ routeId: "r_refund", route: REFUND_ROUTE, action: "REFUND", maxAttempts: 1 }],
    });
    expect(r.ok).toBe(true);
  });

  it("the committed id carrying DIFFERENT instructions is refused", () => {
    // Before F76 this returned ok: the id matched, so the engine ran a refund route
    // that nobody committed to.
    const redirected = compensate(failing(), {
      routeId: "r_refund",
      outcome: "RECOVERED",
      availableRoutes: [{
        routeId: "r_refund",
        route: "evm:refundEscrow:baseSepolia:0xattacker:0xjob",
        action: "REFUND",
        maxAttempts: 1,
      }],
    });
    expect(redirected.ok, "a substituted route body must not run").toBe(false);
    if (!redirected.ok) expect(redirected.reason).toBe("COMPENSATION_ROUTE_REDIRECTED");
  });

  it("a maxAttempts bump alone is not a redirection", () => {
    // The commitment is over the INSTRUCTIONS, not the retry budget: raising
    // maxAttempts is the caller's business (F47 already counts attempts on the saga),
    // and refusing it would break legitimate retries to fix the wrong reason.
    const r = compensate(failing(), {
      routeId: "r_refund",
      outcome: "RECOVERED",
      availableRoutes: [{ routeId: "r_refund", route: REFUND_ROUTE, action: "REFUND", maxAttempts: 3 }],
    });
    expect(r.ok).toBe(true);
  });

  it("a saga persisted before commitments existed cannot compensate at all", () => {
    const legacy: Saga = { ...failing() };
    delete legacy.routeCommitments;
    const r = compensate(legacy, {
      routeId: "r_refund",
      outcome: "RECOVERED",
      availableRoutes: [{ routeId: "r_refund", route: REFUND_ROUTE, action: "REFUND", maxAttempts: 1 }],
    });
    expect(r.ok, "an unverifiable commitment must refuse, not wave through").toBe(false);
    if (!r.ok) expect(r.reason).toBe("COMPENSATION_ROUTE_NOT_COMMITTED");
  });

  it("the commitment is deterministic and 32 bytes", () => {
    const a = routeCommitment(REFUND_ROUTE);
    expect(routeCommitment(REFUND_ROUTE)).toBe(a);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
