/**
 * Compares what the chain shows with what the settlement record claims.
 *
 * Used by every rail's `getEvidence`. A bundle is only built when the transaction
 * the chain reports carried THIS settlement's commitment and moved THIS amount from
 * THIS payer to THIS payee. Each disagreement is named, because "the chain shows a
 * different payee" and "the chain shows a different amount" are different
 * incidents.
 *
 * Throws rather than returning null: a contradiction is not an absence (PRD §17.5,
 * "never upgrade an inference into a verified fact" — and never downgrade a
 * contradiction into silence either).
 */

import type { ChainObservation } from "./types";

export interface ExpectedSettlement {
  commitment: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  asset: string | null;
}

export function assertObservationMatches(
  obs: ChainObservation,
  expected: ExpectedSettlement,
  opts: { caseInsensitiveAddresses: boolean },
): void {
  const norm = (v: string | null) => (v === null ? null : opts.caseInsensitiveAddresses ? v.toLowerCase() : v);
  if (obs.carriedCommitment.toLowerCase() !== expected.commitment.toLowerCase()) {
    throw new Error("EVIDENCE_CONTRADICTED:commitment");
  }
  if (norm(obs.from) !== norm(expected.from)) throw new Error("EVIDENCE_CONTRADICTED:from");
  if (norm(obs.to) !== norm(expected.to)) throw new Error("EVIDENCE_CONTRADICTED:to");
  if (obs.amountAtomic !== expected.amountAtomic) throw new Error("EVIDENCE_CONTRADICTED:amount");
  if (norm(obs.asset) !== norm(expected.asset)) throw new Error("EVIDENCE_CONTRADICTED:asset");
}
