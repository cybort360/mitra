/**
 * Layer A: commerce drives recovery (F49 Step 2).
 *
 * ## Why this module exists
 *
 * `lib/kernel/recovery.ts` had a complete, tested state machine and **no caller**.
 * `declareSaga`, `armSaga`, `startSaga`, `recordStep`, `beginCompensation` and
 * `compensate` were reachable only by a test invoking them directly, so PRD §4.5 —
 * "failure is a state transition, not an exception" — was unenforced in anything that
 * ran. That is the F44/F48 shape: correct, tested code with nothing calling it.
 *
 * ## Why it lives in the kernel and not in the route
 *
 * `/api/v1/agreements` currently only **lists** agreements. No HTTP route drives the
 * commercial lifecycle, so a coupling written in the route would itself have no
 * caller — the same defect one layer up. The coupling belongs where the lifecycle
 * actually happens.
 *
 * ## The property this must not fake
 *
 * A saga that is declared and armed but never stepped proves nothing. §4.5 is only
 * discharged when a **real rejection** carries the saga through
 * `EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED`. Every function below
 * exists to make that path reachable, and `tests/commerce-saga.test.ts` asserts the
 * whole chain rather than the existence of a row.
 *
 * ## Capital ordering, and why it is this way
 *
 * The refund releases `space.committed` **before** the saga reaches its terminal
 * state. If the saga transition failed first, capital would be released with no
 * recorded reason; if the release failed first, the saga would claim recovery that
 * never happened. Releasing first and persisting the saga second means the worst case
 * is a saga that under-reports recovery, which is visible, rather than capital that
 * has moved with no record, which is not.
 */

import type { Agreement, Saga, Space } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import {
  armSaga, beginCompensation, compensate, declareSaga, recordStep, startSaga,
  type CompensationRoute, type SagaDeclaration,
} from "@/lib/kernel/recovery";
import { applyAgreementOp, type AgreementOp } from "@/lib/kernel/commerce";
import { fail, pass, type Result } from "@/lib/kernel/commerce";

/**
 * The pre-committed refund route.
 *
 * PRD §15.5: a compensation route must be committed BEFORE execution, and the engine
 * must never invent calldata after a failure. So the route is a fixed, named
 * reference here, at declaration time, not something constructed at compensation time.
 */
export const REFUND_ROUTE: CompensationRoute = {
  routeId: "route_refund",
  action: "REFUND",
  // Opaque by design — the kernel carries the identifier it was given and cannot
  // synthesise one. See recovery.ts's `CompensationRoute`.
  route: "escrow:refund",
  maxAttempts: 1,
};

const unwrap = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what} failed: ${r.reason}`);
  return r.value;
};

export interface CoupledResult {
  space: Space;
  agreement: Agreement;
  /** Absent until the agreement is funded and its saga armed. */
  saga?: Saga;
}

/**
 * Applies a commercial operation AND advances the attached saga.
 *
 * @param repo injected rather than imported so the kernel stays pure and the caller
 *   chooses the backend. This is the same shape `EconomicRepository` exists for.
 */
export async function applyAgreementOpWithSaga(
  repo: EconomicRepository,
  space: Space,
  agreement: Agreement,
  op: AgreementOp,
  opts: { capability?: string; amount?: { asset: Agreement["price"]["asset"]; amount: number }; artifactRefs?: string[]; contentHash?: string; failureReason?: string } = {},
): Promise<Result<CoupledResult>> {
  // The commercial transition first: if the agreement cannot legally make this move,
  // the saga must not move either. Doing it the other way round would let a rejected
  // `startExecution` still drive a saga to EXECUTING.
  const commercial = applyAgreementOp(space, agreement, op, opts);
  if (!commercial.ok) return fail(commercial.reason);

  const { space: nextSpace, agreement: nextAgreement } = commercial.value;

  // ── fund: declare and ARM the saga ────────────────────────────────────────
  if (op === "fund") {
    const declaration: SagaDeclaration = {
      // Two steps, so §15.5's "a saga with >1 step MUST declare a compensation route"
      // is satisfied by construction rather than by luck.
      steps: [
        { stepId: "execute", name: "perform the agreed work", state: "PENDING", attempts: 0 },
        { stepId: "deliver", name: "submit the deliverable", state: "PENDING", attempts: 0 },
      ],
      compensationRoutes: [REFUND_ROUTE],
      timeoutPolicy: nextAgreement.failurePolicy || "refund on expiry",
    };
    const declared = unwrap(declareSaga(`saga_${nextAgreement.agreementId}`, nextAgreement.runId, nextAgreement.intentId, declaration), "declareSaga");
    const armed = unwrap(armSaga(declared, declaration), "armSaga");
    await repo.saveSaga(armed);
    return pass({
      space: nextSpace,
      agreement: { ...nextAgreement, sagaIds: [armed.sagaId] },
      saga: armed,
    });
  }

  const sagaId = nextAgreement.sagaIds?.[0];
  if (!sagaId) return pass({ space: nextSpace, agreement: nextAgreement });

  const loaded = await repo.getSaga(sagaId);
  if (!loaded) {
    // An agreement pointing at a saga that is not there is a broken link, not a
    // reason to throw: the commercial move already succeeded.
    return pass({ space: nextSpace, agreement: nextAgreement });
  }

  // ── startExecution: ARMED -> EXECUTING ────────────────────────────────────
  if (op === "startExecution") {
    const started = unwrap(startSaga(loaded), "startSaga");
    await repo.updateSaga(started);
    return pass({ space: nextSpace, agreement: nextAgreement, saga: started });
  }

  // ── rejectDeliverable: the whole point of this module ─────────────────────
  if (op === "rejectDeliverable") {
    const reason = opts.failureReason ?? "DELIVERABLE_REJECTED";

    // Capital first, and only if it is genuinely still encumbered. `escrowReleased`
    // is the guard: a REJECTED agreement reached via ACCEPTED (a chargeback) has
    // already released, and releasing again would inflate headroom — F42's bug.
    let spaceAfter = nextSpace;
    let agreementAfter = nextAgreement;
    if (!nextAgreement.escrowReleased && nextSpace.committed.amount >= nextAgreement.price.amount) {
      spaceAfter = {
        ...nextSpace,
        committed: { ...nextSpace.committed, amount: nextSpace.committed.amount - nextAgreement.price.amount },
        version: nextSpace.version + 1,
      };
      agreementAfter = { ...nextAgreement, escrowReleased: true };
    }

    // Then the saga, through every state, with no exception escaping.
    const stepped = unwrap(recordStep(loaded, "deliver", "FAILED", reason), "recordStep");
    const compensating = unwrap(beginCompensation(stepped), "beginCompensation");
    const terminal = compensate(compensating, {
      routeId: REFUND_ROUTE.routeId,
      outcome: "RECOVERED",
      recoveredValue: nextAgreement.price.amount,
      availableRoutes: [REFUND_ROUTE],
    });
    if (!terminal.ok) {
      // The saga refused — most plausibly because the route was already spent
      // (F47). Report it rather than pretending the agreement recovered.
      return fail(terminal.reason);
    }
    await repo.updateSaga(terminal.value);

    return pass({ space: spaceAfter, agreement: agreementAfter, saga: terminal.value });
  }

  return pass({ space: nextSpace, agreement: nextAgreement, saga: loaded });
}
