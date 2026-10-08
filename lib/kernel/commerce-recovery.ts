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
import {
  armSaga, beginCompensation, compensate, declareSaga, recordStep, startSaga,
  type CompensationRoute, type SagaDeclaration,
} from "@/lib/kernel/recovery";
import { applyAgreementOp, type AgreementOp } from "@/lib/kernel/commerce";
import { routeCommitment } from "@/lib/domain/canonical";
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
  /**
   * The saga as it stands after this op. For the API response.
   *
   * Separate from `sagasToPersist` because they answer different questions: "what
   * should I show" and "what did I change". Ops that do not move the saga
   * (`submitDeliverable`, `acceptDeliverable`, `refund`) report the current saga and
   * persist nothing, and collapsing the two would either write unchanged state or drop
   * it from the response.
   */
  saga?: Saga;
  /**
   * The sagas the caller must write, in order. Empty means the saga did not move.
   *
   * **Write the agreement FIRST.** This ordering is the whole point of the field.
   *
   * F77: this kernel used to `saveSaga` itself and the route wrote the agreement
   * afterwards, in a second transaction. If the second never landed, the store kept an
   * ARMED saga that no agreement named — and since every op finds its saga through
   * `agreement.sagaIds`, nothing could ever advance it. A committed §15.5 route with
   * no execution behind it, and no health check that could see it.
   *
   * Returning the write-set instead of performing it inverts that: the caller persists
   * the agreement (which names the saga) and only then the saga. A tear now leaves an
   * agreement pointing at a saga that is not there, which line 173 already handles as
   * a broken link rather than a reason to throw. The benign direction, chosen
   * deliberately — it costs a saga, never a stranded commitment nobody can run.
   *
   * This is also why the function is synchronous: with no `repo`, there is no IO left
   * to await, and a kernel that awaits is a kernel whose next contributor will assume
   * it may persist.
   */
  sagasToPersist: Saga[];
}

export interface OnChainEscrowRef {
  chain: string;
  contractAddress: string;
  jobId: string;
  timeout?: number;
}

export interface CommercialSagaOptions {
  capability?: string;
  amount?: { asset: Agreement["price"]["asset"]; amount: number };
  artifactRefs?: string[];
  contentHash?: string;
  failureReason?: string;
  compensationRoutes?: CompensationRoute[];
  compensationRouteId?: string;
  onChainEscrow?: OnChainEscrowRef;
}

/**
 * Applies a commercial operation AND advances the attached saga.
 *
 * ## Store-free, as of F77
 *
 * This function used to take an `EconomicRepository` and write to it — `saveSaga` on
 * fund, `updateSaga` on the two saga-moving ops — while its sibling `commerce.ts` is
 * pure. `EconomicRepository`'s own documentation says the kernel is store-free and
 * that this "lets the same lifecycle be exercised in a unit test", so the saga kernel
 * was the exception, and the exception was a bug (F77): it split the fund write
 * across two transactions, because the route could not write the agreement until this
 * function had already returned and written the saga.
 *
 * It now takes no repository and returns `sagasToPersist`. The caller loads the
 * agreement's current saga and passes it in; the caller writes the result. Nothing is
 * read from or written to a store in here, which is why it is no longer `async`.
 *
 * @param input.saga the agreement's current saga, loaded by the caller. Passing it in
 *   rather than looking it up is the other half of the change — a kernel that fetches
 *   its own state cannot be tested against a state the test did not choose.
 */
export function applyAgreementOpWithSaga(input: {
  space: Space;
  agreement: Agreement;
  op: AgreementOp;
  /** The agreement's current saga. `null`/absent when it has none, or the link is broken. */
  saga?: Saga | null;
  opts?: CommercialSagaOptions;
}): Result<CoupledResult> {
  const { space, agreement, op, saga: current, opts = {} } = input;
  // The commercial transition first: if the agreement cannot legally make this move,
  // the saga must not move either. Doing it the other way round would let a rejected
  // `startExecution` still drive a saga to EXECUTING.
  const commercial = applyAgreementOp(space, agreement, op, opts);
  if (!commercial.ok) return fail(commercial.reason);

  const { space: nextSpace, agreement: nextAgreement } = commercial.value;

  // ── fund: declare and ARM the saga ────────────────────────────────────────
  if (op === "fund") {
    // The refund route an on-chain escrow will use. Built HERE, at funding, from the
    // same fields the escrow account will be opened with — which is what makes the
    // commitment below mean something. The route names the chain, the contract and
    // the job, so a commitment over it cannot be satisfied by a refund anywhere else.
    const onChainRefundRoute = opts.onChainEscrow
      ? `evm:refundEscrow:${opts.onChainEscrow.chain}:${opts.onChainEscrow.contractAddress}:${opts.onChainEscrow.jobId}`
      : null;

    const compensationRoutes = opts.compensationRoutes ?? (
      onChainRefundRoute
        ? [{
            routeId: `route_refund_${opts.onChainEscrow!.jobId.slice(0, 10)}`,
            action: "REFUND" as const,
            route: onChainRefundRoute,
            maxAttempts: 1,
          }]
        : [REFUND_ROUTE]
    );

    const declaration: SagaDeclaration = {
      // Two steps, so §15.5's "a saga with >1 step MUST declare a compensation route"
      // is satisfied by construction rather than by luck.
      steps: [
        { stepId: "execute", name: "perform the agreed work", state: "PENDING", attempts: 0 },
        { stepId: "deliver", name: "submit the deliverable", state: "PENDING", attempts: 0 },
      ],
      compensationRoutes,
      timeoutPolicy: nextAgreement.failurePolicy || "refund on expiry",
    };
    const declared = unwrap(declareSaga(`saga_${nextAgreement.agreementId}`, nextAgreement.runId, nextAgreement.intentId, declaration), "declareSaga");
    const armed = unwrap(armSaga(declared, declaration), "armSaga");
    return pass({
      sagasToPersist: [armed],
      space: nextSpace,
      agreement: {
        ...nextAgreement,
        sagaIds: [armed.sagaId],
        ...(opts.onChainEscrow
          ? {
              escrowRef: opts.onChainEscrow.jobId,
              // §15.5, committed at funding and carried on the agreement so the value
              // handed to `depositToEscrow`/`lock_escrow` and the value the kernel
              // verifies against are one number.
              refundRouteHash: onChainRefundRoute ? routeCommitment(onChainRefundRoute) : undefined,
            }
          : {}),
      },
      saga: armed,
    });
  }

  if (!current) {
    // No saga, or a broken link: an agreement naming a saga that is not there. That is
    // not a reason to throw — the commercial move already succeeded, and the write-set
    // is empty precisely so the caller writes only the agreement. This is the branch
    // F77's fix makes reachable in the tear direction, and it is why that direction is
    // the safe one.
    return pass({ space: nextSpace, agreement: nextAgreement, sagasToPersist: [] });
  }

  const loaded = current;

  // ── startExecution: ARMED -> EXECUTING ────────────────────────────────────
  if (op === "startExecution") {
    const started = unwrap(startSaga(loaded), "startSaga");
    return pass({ space: nextSpace, agreement: nextAgreement, saga: started, sagasToPersist: [started] });
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

    const targetRouteId = opts.compensationRouteId
      ?? (loaded.compensationRoutes.length > 0 ? loaded.compensationRoutes[0] : REFUND_ROUTE.routeId);

    // **F80: the route comes from what was COMMITTED, never rebuilt here.**
    //
    // This used to reconstruct the refund route from `agreement.escrowRef`, which is
    // only the job id — so a route funded as
    // `evm:refundEscrow:<chain>:<contract>:<jobId>` came back as
    // `evm:refundEscrow:<jobId>`. F76's commitment check then refused every on-chain
    // refund with COMPENSATION_ROUTE_REDIRECTED, permanently and correctly: the string
    // being run was not the string that was agreed. Rebuilding a compensation route
    // after a failure is the thing §15.5 exists to forbid.
    //
    // `committedRoutes` is set at declaration from the same declaration the commitment
    // was taken over, so the two cannot disagree.
    const availableRoutes = opts.compensationRoutes ?? (
      loaded.committedRoutes
        ? Object.entries(loaded.committedRoutes).map(([routeId, route]) => ({
            routeId,
            action: "REFUND" as const,
            route,
            maxAttempts: 1,
          }))
        // No committed body — a saga declared before F80. The pre-F80 reconstruction,
        // kept only so such a saga can still finish; its commitment will refuse anything
        // that does not match, which is the correct outcome.
        : [{
            routeId: targetRouteId,
            action: "REFUND" as const,
            route: opts.onChainEscrow
              ? `evm:refundEscrow:${opts.onChainEscrow.chain}:${opts.onChainEscrow.contractAddress}:${opts.onChainEscrow.jobId}`
              : (nextAgreement.escrowRef ? `evm:refundEscrow:${nextAgreement.escrowRef}` : REFUND_ROUTE.route),
            maxAttempts: 1,
          }]
    );

    const terminal = compensate(compensating, {
      routeId: targetRouteId,
      outcome: "RECOVERED",
      recoveredValue: nextAgreement.price.amount,
      availableRoutes,
    });
    if (!terminal.ok) {
      // The saga refused — most plausibly because the route was already spent
      // (F47). Report it rather than pretending the agreement recovered.
      return fail(terminal.reason);
    }
    return pass({
      space: spaceAfter,
      agreement: agreementAfter,
      saga: terminal.value,
      sagasToPersist: [terminal.value],
    });
  }

  // Every other op moves the commercial state only; the saga is reported unchanged and
  // nothing is written for it.
  return pass({ space: nextSpace, agreement: nextAgreement, saga: loaded, sagasToPersist: [] });
}
