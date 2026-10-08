/**
 * Recovery execution (PRD §15).
 *
 * Phase 6's exit condition is concrete: *"Deliberately failed job reaches a
 * defined terminal recovery state."* Before this, `Saga`, `SagaStatus` and a
 * transition table existed and **nothing called them** — the same "state machine
 * without a write path" that Phase 4 had just fixed for agreements.
 *
 * ## The rule this kernel exists to enforce
 *
 * PRD §15.5:
 *
 * > A compensation route must be committed before execution when possible.
 * > Never let the recovery engine invent arbitrary compensation calldata after
 * > failure.
 *
 * That is why the machine was corrected to include `ARMED` (see `machines.ts`).
 * `ARMED` is the state in which a route is committed, and it is the only state
 * from which execution may begin. Without it the table permitted
 * `DECLARED -> EXECUTING`, which is a path to irreversible action with no
 * defined way back — and to recovery calldata invented after the failure, which
 * §15.5 forbids in exactly the words above.
 *
 * ## TALOS
 *
 * TALOS is the recovery execution layer of the same economic intent (§15.1), not
 * a separate product. It is **absent from this machine entirely** (F24: an
 * exhaustive sweep of `/` found nothing). The semantics below are therefore built
 * from §15 directly, and §15.3's terminology is preserved verbatim rather than
 * paraphrased: `RECOVERED`, `CONTAINED` and `ABORTED` are distinct outcomes and
 * no claim of TALOS reuse is made anywhere in this file.
 */

import type { Saga, SagaStep } from "@/lib/domain/types";
import { canTransition, isTerminal, transition } from "@/lib/kernel/machines";
import { routeCommitment } from "@/lib/domain/canonical";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
const pass = <T>(value: T): Result<T> => ({ ok: true, value });

/** PRD §15.4 — recovery action types, verbatim. */
export type RecoveryAction =
  | "RETRY"
  | "REASSIGN"
  | "REFUND"
  | "UNWIND"
  | "CANCEL"
  | "RETURN_UNUSED_CAPITAL"
  | "FREEZE"
  | "CONTAIN"
  | "ESCALATE";

/**
 * A committed compensation route.
 *
 * Committed **before** execution, per §15.5. The `route` string is opaque to the
 * kernel on purpose: the engine must never construct calldata at failure time, so
 * it carries an identifier it was given and cannot invent. `maxAttempts: 0` is
 * forbidden below, because a route that cannot run is not a route.
 */
export interface CompensationRoute {
  routeId: string;
  /** Opaque reference to a pre-committed action. Never derived at failure time. */
  route: string;
  /** One of §15.4. */
  action: RecoveryAction;
  maxAttempts: number;
}

// ── declaration ─────────────────────────────────────────────────────────────

export interface SagaDeclaration {
  steps: SagaStep[];
  compensationRoutes: CompensationRoute[];
  timeoutPolicy: string;
}

/**
 * Declares a saga.
 *
 * Purely a construction: `DECLARED` is the machine's birth state and has no
 * incoming edge, exactly as `OPEN` is for an agreement.
 */
export function declareSaga(
  sagaId: string,
  runId: string,
  intentId: string,
  declaration: SagaDeclaration,
): Result<Saga> {
  if (!declaration.steps.length) return fail("SAGA_HAS_NO_STEPS");
  const duplicate = new Set<string>();
  for (const s of declaration.steps) {
    if (duplicate.has(s.stepId)) return fail("DUPLICATE_SAGA_STEP_ID");
    duplicate.add(s.stepId);
  }
  if (declaration.steps.length > 1 && !declaration.compensationRoutes.length) {
    // A multi-step workflow with no recovery route is exactly the case §15.5 is
    // written for. A single-step saga may proceed without one.
    return fail("MULTI_STEP_SAGA_REQUIRES_COMPENSATION_ROUTE");
  }
  return pass({
    sagaId, runId, intentId,
    steps: declaration.steps.map((s) => ({ ...s })),
    compensationRoutes: declaration.compensationRoutes.map((r) => r.routeId),
    // §15.5: the commitment is taken HERE, at declaration, which is the last moment
    // before any step runs. Recording it at compensation time would be a formality —
    // the route would be committed by the same act that executes it.
    routeCommitments: Object.fromEntries(
      declaration.compensationRoutes.map((r) => [r.routeId, routeCommitment(r.route)]),
    ),
    // F80: the bodies alongside their hashes, so compensation runs the route that was
    // committed instead of reconstructing one from whatever the agreement still carries.
    committedRoutes: Object.fromEntries(
      declaration.compensationRoutes.map((r) => [r.routeId, r.route]),
    ),
    timeoutPolicy: declaration.timeoutPolicy,
    status: "DECLARED" as const,
    recoveredValue: 0,
    containedValue: 0,
    version: 1,
  });
}

/**
 * Arms the saga — the PRD §15.5 commitment point.
 *
 * Refuses unless at least one usable compensation route exists, where "usable"
 * means `maxAttempts > 0`. A route that cannot execute is not a commitment, and
 * accepting one would put us back on the path §15.5 forbids while *looking*
 * compliant.
 */
function armSagaThrowing(saga: Saga, declaration: SagaDeclaration): Saga {
  const usable = declaration.compensationRoutes.filter((r) => r.maxAttempts > 0 && r.route.length > 0);
  if (!usable.length) throw new Error("NO_USABLE_COMPENSATION_ROUTE");
  return transition("saga", saga, "ARMED");
}

/** Begins execution. Refused unless ARMED — this is the §15.5 gate. */
function startSagaThrowing(saga: Saga): Saga {
  if (saga.status !== "ARMED") throw new Error("SAGA_NOT_ARMED");
  return transition("saga", saga, "EXECUTING");
}

/** Records a step's outcome, advancing or failing the saga accordingly. */
function recordStepThrowing(
  saga: Saga,
  stepId: string,
  outcome: "SUCCEEDED" | "FAILED",
  failureReason?: string,
): Saga {
  const step = saga.steps.find((s) => s.stepId === stepId);
  if (!step) throw new Error("UNKNOWN_SAGA_STEP");
  if (step.state === "SUCCEEDED") throw new Error("STEP_ALREADY_SUCCEEDED");

  const steps = saga.steps.map((s: SagaStep) =>
    s.stepId === stepId
      ? {
          ...s,
          state: outcome === "SUCCEEDED" ? ("SUCCEEDED" as const) : ("FAILED" as const),
          attempts: s.attempts + 1,
          failureReason: outcome === "FAILED" ? failureReason : undefined,
        }
      : s,
  );

  if (outcome === "SUCCEEDED") {
    const next = { ...saga, steps, version: saga.version + 1 };
    // Only the last step completing ends the saga successfully.
    const allDone = steps.every((s) => s.state === "SUCCEEDED" || s.state === "SKIPPED");
    return allDone ? transition("saga", next, "RECOVERED") : next;
  }
  return { ...transition("saga", saga, "STEP_FAILURE"), steps, version: saga.version + 1 };
}

// ── compensation ────────────────────────────────────────────────────────────

export interface CompensationInput {
  routeId: string;
  outcome: "ROLLED_BACK" | "RECOVERED" | "CONTAINED";
  recoveredValue?: number;
  containedValue?: number;
  /** The route is selected by id — never synthesised here (§15.5). */
  availableRoutes: CompensationRoute[];
}

/**
 * Applies a committed route and reaches a terminal state.
 *
 * §15.3's three outcomes are preserved distinctly and are **not**
 * interchangeable:
 *
 *   RECOVERED  — the defined recovery objective was reached
 *   CONTAINED  — further exposure was stopped but state was not fully restored
 *   ABORTED    — no recovery route could complete
 *
 * Collapsing CONTAINED into RECOVERED would erase the difference between "we got
 * the value back" and "we stopped the bleeding", which is the single most
 * important distinction in the whole recovery model: the first is a commercial
 * outcome, the second is a loss that has been bounded.
 */
export function compensate(
  saga: Saga,
  input: CompensationInput,
): Result<Saga> {
  if (saga.status !== "COMPENSATING") return fail("SAGA_NOT_COMPENSATING");

  const route = input.availableRoutes.find((r) => r.routeId === input.routeId);
  if (!route) {
    // §15.5: never invent compensation. An unknown route id is not an invitation
    // to construct one.
    return fail("COMPENSATION_ROUTE_NOT_COMMITTED");
  }
  // F47: count against the SAGA, not against the caller's array. The previous check
  // read `route.maxAttempts` from `input.availableRoutes`, which the caller rebuilds
  // on every call, so a caller that passed the original routes could compensate
  // indefinitely and the limit meant nothing.
  // §15.5, and the gap F76 closed: the saga persisted route IDS, so this check was
  // "does the caller know an id I declared". That is not a commitment — a caller
  // could return the committed id carrying different instructions (another contract,
  // another job, another payee) and the engine would execute them. Hash the route it
  // is actually about to run and compare against what was committed at declaration.
  const committed = saga.routeCommitments?.[route.routeId];
  if (!committed) {
    // A saga with no commitment cannot be verified, and "cannot verify" must not mean
    // "allow". Absent for any saga declared before this field existed.
    return fail("COMPENSATION_ROUTE_NOT_COMMITTED");
  }
  if (routeCommitment(route.route) !== committed) {
    return fail("COMPENSATION_ROUTE_REDIRECTED");
  }

  const attemptsSoFar = saga.routeAttempts?.[input.routeId] ?? 0;
  if (attemptsSoFar >= route.maxAttempts) return fail("COMPENSATION_ROUTE_EXHAUSTED");

  const compensatedSteps = saga.steps.map((s) =>
    s.state === "FAILED" ? { ...s, state: "COMPENSATED" as const } : s,
  );
  // The attempt is recorded on the saga as it is spent, so a caller that retries a
  // route cannot get a fresh budget by re-reading its own route list.
  const base = {
    ...saga,
    steps: compensatedSteps,
    routeAttempts: { ...(saga.routeAttempts ?? {}), [input.routeId]: attemptsSoFar + 1 },
    version: saga.version + 1,
  };

  switch (input.outcome) {
    case "RECOVERED":
      return pass(transition("saga", { ...base, recoveredValue: input.recoveredValue ?? 0 }, "RECOVERED"));
    case "CONTAINED":
      // Recovered and contained are DIFFERENT outcomes, so a contained saga must
      // not also claim recovered value. Both are recorded separately so an
      // aggregate over outcomes is meaningful.
      return pass(transition("saga", { ...base, containedValue: input.containedValue ?? 0 }, "CONTAINED"));
    case "ROLLED_BACK":
      // Rolled back means state was explicitly reversed, which §15.3 treats as
      // having achieved the recovery objective.
      return pass(transition("saga", { ...base, recoveredValue: input.recoveredValue ?? 0 }, "RECOVERED"));
    default:
      return fail("UNKNOWN_COMPENSATION_OUTCOME");
  }
}

/** Re-enters recovery from STEP_FAILURE. */
function beginCompensationThrowing(saga: Saga): Saga {
  return transition("saga", saga, "COMPENSATING");
}

/** True when a saga has reached an outcome and can take no further action. */
export function isRecovered(saga: Saga): boolean {
  return saga.status === "RECOVERED";
}

export { isTerminal };

/**
 * Convert a throwing transition into a `Result` (F50).
 *
 * ## The defect
 *
 * `armSaga`, `startSaga`, `recordStep` and `beginCompensation` are all typed
 * `Result<Saga>`, and none of them is wrapped in a `try`. Each calls `transition`,
 * which **throws** on an illegal edge. So every one of them could throw while its
 * type promised a value:
 *
 *     beginCompensation(recoveredSaga)   // typed Result<Saga>
 *     // ...throws TERMINAL_STATE: RECOVERED is terminal for saga
 *
 * That is not a typing nicety. PRD §4.5 says failure is a state transition, not an
 * exception, and these four functions are the recovery path itself: a caller that
 * trusted the signature and called them in sequence would get an unhandled throw
 * precisely when a saga was already in trouble — which is when an exception is
 * least useful.
 *
 * It was found by a test asserting that re-entering compensation is refused: the
 * refusal was thrown rather than returned, so the test errored instead of
 * observing a `Result`. The F44/F48 shape once more — a correct guarantee that the
 * type over-promised and nothing exercised.
 *
 * ## Why wrap the exported functions rather than `transition`
 *
 * `transition` throws deliberately: it is the primitive, used where a caller wants
 * the throw. Wrapping it there would change that contract for every existing caller.
 * The exported recovery API is the surface that promises `Result`, so that is the
 * surface that must keep the promise.
 */
function asResult(fn: () => Saga): Result<Saga> {
  try {
    return pass(fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// The four throwing implementations above are kept as `*Throwing` and the exported
// names below are the guarded ones. `transition` deliberately throws — it is the
// primitive — but the exported recovery API promises `Result`, so that is the surface
// that must keep the promise.
export function armSaga(saga: Saga, declaration: SagaDeclaration): Result<Saga> {
  return asResult(() => armSagaThrowing(saga, declaration));
}
export function startSaga(saga: Saga): Result<Saga> {
  return asResult(() => startSagaThrowing(saga));
}
export function recordStep(
  saga: Saga, stepId: string, outcome: "SUCCEEDED" | "FAILED", failureReason?: string,
): Result<Saga> {
  return asResult(() => recordStepThrowing(saga, stepId, outcome, failureReason));
}
export function beginCompensation(saga: Saga): Result<Saga> {
  return asResult(() => beginCompensationThrowing(saga));
}
