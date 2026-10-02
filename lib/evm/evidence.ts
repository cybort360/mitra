/**
 * Settlement evidence — the part that lets a STRANGER check a Mitra claim.
 *
 * ## Why this is the most important thing still missing
 *
 * Everything else Mitra produces is a local truth: the kernel decided, the guard
 * checked, the epoch netted. A counterparty outside the system cannot check any of
 * it. They receive a settlement record and have no way to learn whether it
 * reflects a real transfer, a failed one, or a fabrication.
 *
 * That is the gap between "Mitra settled this" and "here is the proof, verify it
 * yourself." Until it is closed, business use means trusting Mitra's word, which
 * is precisely the thing the vault boundary was built to avoid.
 *
 * ## PRD §21.4
 *
 * The spec's `SettlementAdapter` includes `getEvidence(ref)`. This module is that
 * contract, plus the property that makes the evidence worth having:
 *
 *   An evidence bundle carries the receipt, the settlement it refers to, the
 *   commitment that was authorised, and the observed on-chain confirmation — and
 *   `verifyEvidenceBundle` re-derives the commitment rather than trusting the
 *   field. An evidence bundle whose commitment does not reconstruct is refused,
 *   which is the difference between evidence and a claim with a JSON shape.
 *
 * ## What it does NOT claim
 *
 * Nothing here has been produced by a live chain. `EvidenceLevel` carries that,
 * and a bundle assembled without a confirmation is `DESIGN_ONLY` — because an
 * unverified bundle that LOOKS like evidence is worse than none. F22 and F24 both
 * came from code that looked live because it returned plausible values.
 */

import type { EvidenceLevel } from "@/lib/domain/types";
import { settlementDigest, settlingDomain, type SettlementDomain, type TypedSettlement } from "@/lib/evm/eip712";

export interface EvidenceBundle {
  evidenceId: string;
  receiptId: string;
  settlementId: string;
  chain: string;
  /** The typed settlement that was authorised. */
  typed: TypedSettlement;
  /** The EIP-712 digest signed for it. Re-derivable, so it can be CHECKED. */
  commitment: `0x${string}`;
  domain: SettlementDomain;
  /** Observed confirmation. Absent means nothing was observed. */
  confirmation?: {
    txHash: string;
    blockNumber: number;
    observedAt: string;
  };
  level: EvidenceLevel;
}

/**
 * The evidence level for an OBSERVED confirmation.
 *
 * **Uses the closed vocabulary from ADR-0008 rather than inventing a member.** A
 * first draft returned `"ONCHAIN_CONFIRMED"`, which does not exist in
 * `EvidenceLevel` — the compiler caught it, and it is the same vocabulary drift
 * recorded as F20. A settlement confirmed on a testnet is `TESTNET_PASS`; on a
 * public network it is `LIVE_PUBLIC_PASS`. Nothing here claims more, because
 * nothing has been observed on either.
 */
export function observedLevel(chainOrBundle: string | EvidenceBundle): EvidenceLevel {
  const chain = typeof chainOrBundle === "string" ? chainOrBundle : chainOrBundle.chain;
  const isPublic = chain === "mainnet" || chain === "base" || chain === "ethereum";
  return isPublic ? "LIVE_PUBLIC_PASS" : "TESTNET_PASS";
}

export type EvidenceVerdict =
  | { ok: true; evidenceLevel: EvidenceLevel }
  | { ok: false; reason: string };

/**
 * Verifies an evidence bundle.
 *
 * The load-bearing check is that the commitment RECONSTRUCTS from the typed
 * fields under the stated domain. A bundle can therefore assert anything about
 * the settlement except the thing that matters — the values were not altered
 * after authorisation — and it will be refused.
 */
export function verifyEvidenceBundle(bundle: EvidenceBundle): EvidenceVerdict {
  if (!bundle.receiptId) return { ok: false, reason: "EVIDENCE_WITHOUT_RECEIPT" };
  if (!bundle.settlementId) return { ok: false, reason: "EVIDENCE_WITHOUT_SETTLEMENT" };
  // The bundle's own identity claim must agree with the settlement it describes.
  //
  // Without this, a bundle could name settlement A while carrying a perfectly
  // valid commitment for settlement B: the digest reconstructs, so it passes, and
  // a counterparty verifying settlement A is handed proof about B. That is the
  // confused-deputy shape, and it survived the first version of this verifier -
  // found because the test asserted the property and the code did not have it.
  if (bundle.typed.settlementId !== bundle.settlementId) {
    return { ok: false, reason: "SETTLEMENT_ID_MISMATCH" };
  }

  let expected: `0x${string}`;
  try {
    expected = settlementDigest(bundle.domain, bundle.typed);
  } catch (e) {
    return { ok: false, reason: `EVIDENCE_TYPED_FIELDS_MALFORMED:${e instanceof Error ? e.message : "unknown"}` };
  }
  if (expected !== bundle.commitment) {
    // The settlement's values were changed after they were authorised. This is the
    // single failure that makes evidence worthless, so it is named explicitly.
    return { ok: false, reason: "COMMITMENT_MISMATCH" };
  }

  if (!bundle.confirmation) {
    // Not a refusal: it is an honest downgrade. A bundle with no observation
    // cannot claim to be on-chain evidence.
    return { ok: true, evidenceLevel: "DESIGN_ONLY" };
  }
  if (!bundle.confirmation.txHash || bundle.confirmation.blockNumber <= 0) {
    return { ok: false, reason: "MALFORMED_CONFIRMATION" };
  }
  return { ok: true, evidenceLevel: observedLevel(bundle) };
}

/**
 * Builds a bundle from a settlement and its digest.
 *
 * Refuses to accept a digest it cannot re-derive, so a caller cannot attach a
 * commitment for a different settlement and have it pass review.
 */
export function buildEvidenceBundle(input: {
  evidenceId: string;
  receiptId: string;
  settlementId: string;
  chain: string;
  typed: TypedSettlement;
  domain: SettlementDomain;
  confirmation?: EvidenceBundle["confirmation"];
}): EvidenceBundle {
  const commitment = settlementDigest(input.domain, input.typed);
  return {
    evidenceId: input.evidenceId,
    receiptId: input.receiptId,
    settlementId: input.settlementId,
    chain: input.chain,
    typed: input.typed,
    commitment,
    domain: input.domain,
    confirmation: input.confirmation,
    level: input.confirmation ? observedLevel(input.chain) : "DESIGN_ONLY",
  };
}

export { settlingDomain };
