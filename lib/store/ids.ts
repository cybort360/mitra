/**
 * Pure helpers shared by routes and the ledger.
 *
 * These live apart from `ledger.ts` so a route can build a digest or an id
 * without importing the process-local ledger — and therefore without pulling in
 * the seed array transitively. A route that only needs `newId` should not be
 * able to reach the mutable ledger by accident.
 */
import { createHash, randomUUID } from "node:crypto";

/** Stable digest binding an instruction to the exact terms that were evaluated. */
export function actionDigestFor(input: {
  vaultId: string; mandateId: string; mandateVersion: number;
  amount: number; asset: string; chain: string; counterparty: string; capability: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    input.vaultId, input.mandateId, input.mandateVersion,
    input.amount, input.asset, input.chain, input.counterparty, input.capability,
  ])).digest("hex")}`;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
