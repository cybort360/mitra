/**
 * Committing a commercial operation together with its saga.
 *
 * ## Why this exists separately from the kernel
 *
 * `lib/kernel/commerce-recovery.ts` is pure (F77): it loads nothing and writes nothing,
 * because `EconomicRepository`'s own documentation says the kernel is store-free and
 * that this "lets the same lifecycle be exercised in a unit test". It returns
 * `sagasToPersist`.
 *
 * So somebody has to do the writing, and that somebody has to get the ORDER right:
 *
 * ```
 * agreement FIRST — it is what NAMES the saga — then the sagas
 * ```
 *
 * Getting it backwards is F77. The kernel used to `saveSaga` itself and return, and
 * the route wrote the agreement afterwards, in a second transaction. A failure between
 * the two left a persisted ARMED saga that no agreement named, and since every operation
 * finds its saga through `agreement.sagaIds`, nothing could ever advance it: a
 * committed §15.5 route with no execution behind it, invisible to any health check that
 * reads "agreement has sagaIds" or "saga is ARMED".
 *
 * This direction leaves an agreement naming a saga that is not there, which the kernel
 * already treats as a broken link rather than an error — the cheap failure, chosen
 * because it costs a saga and never strands capital.
 *
 * ## Why the route and the tests both come through here
 *
 * Because the ordering IS the guarantee. If each caller assembled its own writes, the
 * order would be duplicated, and the copy in the test suite would be the one that stops
 * being maintained — a test that persists sagas before agreements is testing something
 * the product does not do, and it would keep passing. One function, used by both, means
 * the thing under test is the thing that runs.
 */

import type { Agreement, Space } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import {
  applyAgreementOpWithSaga,
  type CommercialSagaOptions,
  type CoupledResult,
} from "@/lib/kernel/commerce-recovery";
import type { AgreementOp } from "@/lib/kernel/commerce";
import type { Result } from "@/lib/kernel/commerce";

export class AgreementStoreIncomplete extends Error {
  constructor(missing: string[]) {
    super(`store cannot persist this operation: missing ${missing.join(", ")}`);
    this.name = "AgreementStoreIncomplete";
  }
}

/**
 * Applies `op` to `agreement` and persists the whole resulting state.
 *
 * Returns the refusal untouched and writes nothing, so a rejected op leaves the store
 * exactly as it was — the caller turns `!ok` into a 400 without having to unwind.
 */
export async function commitAgreementOp(
  repo: EconomicRepository,
  space: Space,
  agreement: Agreement,
  op: AgreementOp,
  opts: CommercialSagaOptions = {},
): Promise<Result<CoupledResult>> {
  // Only the genuinely OPTIONAL members. `saveSaga`/`getSaga` are required on
  // `EconomicRepository`, so a check for them could never fire — a guard that reads
  // like it protects something and cannot is worse than none, because the next person
  // trusts it. `updateAgreement`/`updateSpace` really are optional (the Postgres
  // repository gained them late, and older backends lack them), and a store missing
  // them must refuse before writing the saga rather than after.
  if (!repo.updateAgreement || !repo.updateSpace) {
    const missing = [!repo.updateAgreement && "updateAgreement", !repo.updateSpace && "updateSpace"]
      .filter((m): m is string => typeof m === "string");
    throw new AgreementStoreIncomplete(missing);
  }
  // Called as `repo.updateAgreement(...)` below rather than through a destructured
  // local: the repository methods are prototype methods that use `this`, and a
  // destructured copy loses the receiver and dies on `this.agreementsMap`. The first
  // version of this function did exactly that and the tests caught it.


  // The kernel does not fetch its own state, so the caller loads the agreement's saga.
  const sagaId = agreement.sagaIds?.[0];
  const current = sagaId && repo.getSaga ? await repo.getSaga(sagaId) : null;

  const applied = applyAgreementOpWithSaga({ space, agreement, op, saga: current, opts });
  if (!applied.ok) return applied;

  // ORDER IS LOAD-BEARING. See the module comment and F77.
  await repo.updateAgreement(applied.value.agreement);
  await repo.updateSpace(applied.value.space);
  for (const saga of applied.value.sagasToPersist) {
    // `saveSaga` upserts and `updateSaga` is a documented alias of it, so one call
    // covers both "declared and armed" and "advanced".
    await repo.saveSaga(saga);
  }

  return applied;
}
