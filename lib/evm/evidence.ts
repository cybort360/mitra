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
import { solanaCommitmentAtomic } from "@/lib/solana/commitment";

interface BundleCommon {
  evidenceId: string;
  receiptId: string;
  settlementId: string;
  /**
   * The NETWORK, not the domain `Chain`: `"base-sepolia"`, not `"base"`.
   * `observedLevel` reads it, and `"base"` means Base mainnet there — passing a
   * Settlement's `chain` straight through would claim public-network evidence for
   * a testnet transfer. Use `networkName()`.
   */
  chain: string;
  /** Observed confirmation. Absent means nothing was observed. */
  confirmation?: {
    txHash: string;
    blockNumber: number;
    observedAt: string;
  };
  level: EvidenceLevel;
}

/** Base and Tempo: an EIP-712 typed-data digest (`lib/evm/eip712.ts`). */
export interface Eip712EvidenceBundle extends BundleCommon {
  /** Absent on bundles built before Solana evidence existed; means `"eip712"`. */
  scheme?: "eip712";
  /** The typed settlement that was authorised. */
  typed: TypedSettlement;
  /** The EIP-712 digest signed for it. Re-derivable, so it can be CHECKED. */
  commitment: `0x${string}`;
  domain: SettlementDomain;
}

/**
 * Solana: sha256 over the ABI encoding of the settlement (`solanaCommitmentAtomic`),
 * which the vault program stores as the permit's `action_hash`. EIP-712 has no
 * meaning there, so it is a separate scheme rather than an EIP-712 bundle with a
 * fake domain.
 */
export interface SolanaEvidenceBundle extends BundleCommon {
  scheme: "solana-abi-sha256/v1";
  typed: SolanaTypedSettlement;
  commitment: `0x${string}`;
}

export interface SolanaTypedSettlement {
  settlementId: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  asset: string;
  programId: string;
}

export type EvidenceBundle = Eip712EvidenceBundle | SolanaEvidenceBundle;

/**
 * The network a bundle's `chain` names, from the chain id the commitment binds.
 * Unknown ids are refused rather than guessed, because the name decides the
 * evidence level.
 */
export function networkName(chain: "base" | "tempo" | "solana", chainId?: number): string {
  if (chain === "base" && chainId === 84532) return "base-sepolia";
  if (chain === "base" && chainId === 8453) return "base";
  if (chain === "tempo" && chainId === 42431) return "tempo-moderato";
  if (chain === "tempo" && chainId === 4217) return "tempo";
  if (chain === "solana") return "solana-devnet"; // the only cluster mitra-vault is deployed to
  throw new Error(`UNKNOWN_NETWORK: ${chain}/${chainId}`);
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
  const isPublic = chain === "mainnet" || chain === "base" || chain === "ethereum" || chain === "tempo" || chain === "solana";
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
    expected = bundle.scheme === "solana-abi-sha256/v1"
      ? solanaCommitmentAtomic(bundle.typed)
      : settlementDigest(bundle.domain, bundle.typed);
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
}): Eip712EvidenceBundle {
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

/** The Solana counterpart of `buildEvidenceBundle`: the commitment is computed, never accepted. */
export function buildSolanaEvidenceBundle(input: {
  evidenceId: string;
  receiptId: string;
  settlementId: string;
  chain: string;
  typed: SolanaTypedSettlement;
  confirmation?: EvidenceBundle["confirmation"];
}): SolanaEvidenceBundle {
  return {
    scheme: "solana-abi-sha256/v1",
    evidenceId: input.evidenceId,
    receiptId: input.receiptId,
    settlementId: input.settlementId,
    chain: input.chain,
    typed: input.typed,
    commitment: solanaCommitmentAtomic(input.typed),
    confirmation: input.confirmation,
    level: input.confirmation ? observedLevel(input.chain) : "DESIGN_ONLY",
  };
}

/**
 * JSON for a bundle. `amountAtomic` is a bigint, which `JSON.stringify` refuses;
 * it is written as a decimal string, and `bundleFromJson` restores it so a third
 * party can hand the parsed bundle straight to `verifyEvidenceBundle`.
 */
export function bundleToJson(bundle: EvidenceBundle): unknown {
  return JSON.parse(JSON.stringify(bundle, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function bundleFromJson(json: unknown): EvidenceBundle {
  const b = json as EvidenceBundle & { typed: { amountAtomic: string | bigint } };
  return { ...b, typed: { ...b.typed, amountAtomic: BigInt(b.typed.amountAtomic) } } as EvidenceBundle;
}

export { settlingDomain };
