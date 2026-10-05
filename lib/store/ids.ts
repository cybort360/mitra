/**
 * Pure helpers shared by routes and the ledger.
 *
 * These live apart from `ledger.ts` so a route can build a digest or an id
 * without importing the process-local ledger — and therefore without pulling in
 * the seed array transitively. A route that only needs `newId` should not be
 * able to reach the mutable ledger by accident.
 */
import { randomUUID } from "node:crypto";
import { typedHash } from "@/lib/domain/canonical";

/**
 * Stable digest binding an instruction to the exact terms that were evaluated.
 *
 * Previously a bare `JSON.stringify` of a positional array, hashed. That was
 * stable only by accident: it depended on the caller passing the fields in
 * exactly this order, and it hashed raw floats, so `0.1 + 0.2` and `0.3` — the
 * same amount — produced different digests.
 *
 * Now a domain-separated canonical hash over a keyed object. Key order cannot
 * change the result, and money canonicalizes as a fixed-scale decimal.
 *
 * **This changes the digest value, and that is a known consequence.**
 *
 * Checked rather than assumed: the old and new digests for identical input
 * differ (`sha256:ff378e4f…` vs `sha256:c22d6a25…`). Every reservation created
 * under the old scheme therefore carries a binding that the new code will
 * reject as `ACTION_DIGEST_MISMATCH`.
 *
 * That is acceptable **only because nothing durable depends on it yet**: the
 * seed reservations were re-issued in the same commit that introduced the
 * repository, and there is no production data. Before this ships, either
 * re-issue outstanding reservations or keep the previous digest reachable
 * alongside the new one for verification of historical records. Recorded in
 * `forge/FAILURES.md` as F11 rather than left to be discovered.
 */
export function actionDigestFor(input: {
  vaultId: string; mandateId: string; mandateVersion: number;
  amount: number; asset: string; chain: string; counterparty: string; capability: string;
  /**
   * The agreement this action pays, when it pays one.
   *
   * Bound into the digest so a reservation made for one agreement cannot execute
   * against another with the same provider and price. Omitted from the hashed
   * object entirely when absent, so every digest that names no agreement is
   * unchanged (the F11 consequence above does not recur).
   */
  agreementId?: string;
  /**
   * The clearing residual this action pays, `<epochId>#<index>`, bound the same way
   * as `agreementId`: absent from the hashed object when absent.
   */
  residualRef?: string;
}): string {
  return typedHash("mitra.action.v1", {
    vaultId: input.vaultId,
    mandateId: input.mandateId,
    mandateVersion: input.mandateVersion,
    amount: input.amount,
    asset: input.asset,
    chain: input.chain,
    counterparty: input.counterparty,
    capability: input.capability,
    ...(input.agreementId !== undefined ? { agreementId: input.agreementId } : {}),
    ...(input.residualRef !== undefined ? { residualRef: input.residualRef } : {}),
  });
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
