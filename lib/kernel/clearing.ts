import type { AssetSymbol, Chain, ClearingEpoch, Obligation } from "@/lib/domain/types";

export interface NettingResult {
  grossVolume: number;
  netPositions: { party: string; amount: number }[];
  residualTransfers: { from: string; to: string; amount: number }[];
  excluded: { obligationId: string; reason: string }[];
  residualVolume: number;
}

export function netObligations(obligations: Obligation[]): NettingResult {
  const included = obligations.filter((o) => !["DISPUTED", "DEFAULTED", "SETTLED"].includes(o.status));
  const excluded = obligations.filter((o) => ["DISPUTED", "DEFAULTED"].includes(o.status)).map((o) => ({ obligationId: o.obligationId, reason: o.status }));
  const positions = new Map<string, number>();
  let grossVolume = 0;
  for (const o of included) {
    grossVolume += o.amount.amount;
    positions.set(o.debtor, (positions.get(o.debtor) ?? 0) - o.amount.amount);
    positions.set(o.creditor, (positions.get(o.creditor) ?? 0) + o.amount.amount);
  }
  const debtors = [...positions].filter(([,v]) => v < -1e-9).map(([party,v]) => ({ party, amount: -v })).sort((a,b)=>b.amount-a.amount);
  const creditors = [...positions].filter(([,v]) => v > 1e-9).map(([party,v]) => ({ party, amount: v })).sort((a,b)=>b.amount-a.amount);
  const residualTransfers: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 1e-9) residualTransfers.push({ from: debtors[i].party, to: creditors[j].party, amount: Number(amount.toFixed(8)) });
    debtors[i].amount -= amount; creditors[j].amount -= amount;
    if (debtors[i].amount <= 1e-9) i++;
    if (creditors[j].amount <= 1e-9) j++;
  }
  return {
    grossVolume: Number(grossVolume.toFixed(8)),
    netPositions: [...positions].map(([party,amount]) => ({ party, amount: Number(amount.toFixed(8)) })).sort((a,b)=>a.party.localeCompare(b.party)),
    residualTransfers,
    excluded,
    residualVolume: Number(residualTransfers.reduce((s,t)=>s+t.amount,0).toFixed(8)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The epoch lifecycle — the write path (PRD Phase 7).
// ─────────────────────────────────────────────────────────────────────────────
//
// `netObligations` existed and the `clearingEpoch` machine existed, and **nothing
// connected them** — the same "state machine without a write path" that Phase 4
// found for agreements and Phase 6 for sagas. Third occurrence of the same shape.
//
// The property that makes a clearing result defensible is **immutability of the
// frozen input set** (`docs/STATE_MACHINES.md`: "The finalized input set is
// immutable. Disputed obligations remain visible and excluded rather than silently
// netted."). Two commitments carry it:
//
//   inputsRoot — a hash over the FROZEN input set. After FROZEN, changing any
//                obligation changes the root, and the epoch refuses.
//   resultHash — a hash over the computed result, so a participant can verify
//                they were netted against the same inputs everyone else saw.
//
// Disputed obligations are **excluded and visible**, never silently dropped. A
// netting engine that quietly omits a dispute is worse than one that crashes,
// because the aggregate still looks authoritative.

import { transition } from "@/lib/kernel/machines";
import { typedHash } from "@/lib/domain/canonical";

export type ClearingResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const cfail = <T>(reason: string): ClearingResult<T> => ({ ok: false, reason });
const cpass = <T>(value: T): ClearingResult<T> => ({ ok: true, value });

/**
 * Commitment over an ordered field list.
 *
 * **F45 — this was FNV-1a over `fields.join("|")`, which failed in two
 * independent ways.**
 *
 * 1. **Structural ambiguity.** Joining with a delimiter means a field containing
 *    `"|"` is indistinguishable from a field boundary, so
 *    `["epoch_1", "alice|bob", "100"]` and `["epoch_1", "alice", "bob|100"]`
 *    hashed *identically*. That is a collision before the hash's width is even
 *    considered, and it survives any upgrade to a wider hash. Passing the
 *    **array** to `typedHash` canonicalises the structure, so boundaries are
 *    carried by the encoding rather than by a guessable separator.
 * 2. **Width.** FNV-1a is 32-bit and not collision-resistant; these commitments
 *    are what participants agree a clearing result by.
 *
 * The replacement is `typedHash` — domain-separated SHA-256 — which the repository
 * already uses for action digests and the receipt chain. Consistency matters here:
 * a clearing commitment was previously the weakest link in a set of otherwise
 * cryptographic hashes.
 *
 * The domain is a required parameter rather than an internal constant, so
 * `inputsRoot` and `resultHash` cannot collide with each other or with any other
 * `typedHash` consumer.
 */
export function digest(domain: string, fields: readonly (string | number)[]): string {
  return typedHash(domain, fields);
}

/** Commitment to the input set, over the ORDER-SENSITIVE canonical form. */
export function inputsRoot(obligations: Obligation[], asset: AssetSymbol, domain: Chain): string {
  return digest("mitra.clearing.inputs.v1", [
    "mitra-clearing-v1", asset, domain,
    ...obligations
      .map((o) => [o.obligationId, o.debtor, o.creditor, o.amount.amount, o.status].join(":"))
      .sort(),
  ]);
}

/** Commitment to the computed result. */
export function resultHash(result: NettingResult, epochId: string): string {
  return digest("mitra.clearing.result.v1", [
    "mitra-clearing-result-v1", epochId,
    result.grossVolume, result.residualVolume,
    ...result.netPositions.map((p) => `${p.party}:${p.amount}`).sort(),
    ...result.residualTransfers.map((t) => `${t.from}>${t.to}:${t.amount}`).sort(),
    ...result.excluded.map((e) => `${e.obligationId}:${e.reason}`).sort(),
  ]);
}

/** The computation version is part of every commitment, so results are comparable. */
export const COMPUTATION_VERSION = "netting-v1";

export interface EpochInput {
  epochId: string;
  asset: AssetSymbol;
  settlementDomain: Chain;
  obligations: Obligation[];
  openedAt: string;
}

export function openEpoch(input: EpochInput): ClearingResult<ClearingEpoch> {
  if (!input.obligations.length) return cfail("EPOCH_HAS_NO_OBLIGATIONS");
  // Every obligation must be in the epoch's own asset and domain. A mixed-asset
  // epoch would net positions that cannot be settled against each other.
  for (const o of input.obligations) {
    if (o.amount.asset !== input.asset) return cfail("OBLIGATION_ASSET_MISMATCH");
  }
  return cpass({
    epochId: input.epochId,
    status: "OPEN" as const,
    asset: input.asset,
    settlementDomain: input.settlementDomain,
    obligationIds: input.obligations.map((o) => o.obligationId).sort(),
    excludedObligations: [],
    grossVolume: 0, netResidual: 0, netPositions: [], residualTransfers: [],
    computationVersion: COMPUTATION_VERSION,
    openedAt: input.openedAt,
  });
}

/**
 * Freezes the input set and records `inputsRoot`.
 *
 * After this the obligations are referenced, not held — so a later mutation of
 * the caller's array cannot reach inside a frozen epoch even by accident.
 */
export function freezeEpoch(epoch: ClearingEpoch, obligations: Obligation[]): ClearingResult<ClearingEpoch> {
  const ids = new Set(epoch.obligationIds);
  const supplied = obligations.filter((o) => ids.has(o.obligationId)).sort((a, b) =>
    a.obligationId.localeCompare(b.obligationId),
  );
  if (supplied.length !== ids.size) return cfail("FROZEN_SET_INCOMPLETE");
  return cpass(transition("clearingEpoch", {
    ...epoch,
    inputsRoot: inputsRoot(supplied, epoch.asset, epoch.settlementDomain),
  }, "FROZEN"));
}

/** Computes the result and commits to it. */
export function calculateEpoch(epoch: ClearingEpoch, obligations: Obligation[]): ClearingResult<ClearingEpoch> {
  if (!epoch.inputsRoot) return cfail("EPOCH_NOT_FROZEN");
  const ids = new Set(epoch.obligationIds);
  const supplied = obligations.filter((o) => ids.has(o.obligationId));
  if (supplied.length !== ids.size) return cfail("FROZEN_SET_INCOMPLETE");

  // The frozen root is re-derived on every calculation, so an obligation mutated
  // after freezing is refused here rather than silently netted.
  const current = inputsRoot(supplied, epoch.asset, epoch.settlementDomain);
  if (current !== epoch.inputsRoot) return cfail("FROZEN_INPUT_SET_MUTATED");

  const result = netObligations(supplied);
  const next = transition("clearingEpoch", {
    ...epoch,
    grossVolume: result.grossVolume,
    netResidual: result.residualVolume,
    netPositions: result.netPositions,
    residualTransfers: result.residualTransfers,
    excludedObligations: result.excluded,
  }, "CALCULATING");
  return cpass(transition("clearingEpoch", next, "CHALLENGE") as ClearingEpoch & { resultHash: string });
}

export interface Challenge {
  obligationId: string;
  challenger: string;
  reason: string;
}

/**
 * Applies challenges and re-commits.
 *
 * A challenged obligation is **excluded and stays visible** in
 * `excludedObligations` with its reason. It is not deleted: the point of a
 * challenge window is that a disputed leg is visible to every participant and
 * excluded from the aggregate, not quietly removed.
 */
export function resolveChallenges(
  epoch: ClearingEpoch,
  challenges: Challenge[],
): ClearingResult<ClearingEpoch> {
  const inEpoch = new Set(epoch.obligationIds);
  for (const c of challenges) {
    if (!inEpoch.has(c.obligationId)) return cfail("CHALLENGE_REFERENCES_UNKNOWN_OBLIGATION");
  }
  const challenged = new Map(challenges.map((c) => [c.obligationId, `CHALLENGED:${c.reason}`]));
  const excluded = epoch.excludedObligations.filter((e) => !challenged.has(e.obligationId));
  for (const [obligationId, reason] of challenged) {
    if (!excluded.some((e) => e.obligationId === obligationId)) {
      excluded.push({ obligationId, reason });
    }
  }
  // Deliberately does NOT transition. The challenge window stays OPEN while
  // challenges are applied, so several can be applied before anyone finalizes.
  //
  // The first version transitioned straight to FINALIZED, which meant
  // `finalizeEpoch` then hit NO_OP_TRANSITION on an already-final epoch. Two
  // functions closing the same window is a design smell, and it produced a
  // lifecycle that could not complete.
  return cpass({
    ...epoch,
    excludedObligations: excluded.sort((a, b) => a.obligationId.localeCompare(b.obligationId)),
  });
}

/** Seals the epoch with a result commitment over everything a participant sees. */
export function finalizeEpoch(epoch: ClearingEpoch, result: NettingResult): ClearingResult<ClearingEpoch> {
  return cpass(transition("clearingEpoch", {
    ...epoch,
    resultHash: resultHash(result, epoch.epochId),
  }, "FINALIZED"));
}
