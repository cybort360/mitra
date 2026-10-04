/**
 * Receipts (PRD §17) — the first receipts Mitra actually writes.
 *
 * `Receipt` has been a domain type with fixture instances only; nothing produced
 * one, so `verifyEvidenceBundle`'s `EVIDENCE_WITHOUT_RECEIPT` refusal could never be
 * satisfied by a real settlement. Sprint item 2 needs them, so this module covers
 * exactly the SettlementReceipt and the chain rule, nothing more.
 *
 * ## The chain (§17.3)
 *
 * Receipts chain per run: each carries `previousReceiptHash = receiptHash(previous)`.
 * `receiptHash` is `chainHash(previousReceiptHash, receipt-without-that-field)`, so
 * altering any earlier receipt changes every later link. `verifyReceiptChain` walks
 * one run's receipts and names the first broken link.
 *
 * ## Signed when a key is configured (backlog #4)
 *
 * §17.4 lists `signer`. With a receipt signer (`MITRA_RECEIPT_SIGNER_KEY_FILE`) each
 * receipt carries an EIP-191 signature over its `receiptHash` and
 * `signer: "eip191:<address>"`; `verifyReceipts` recovers it. Without one, `signer` stays
 * `"unsigned:<service>"` — never a name that reads like a key nobody holds.
 *
 * Pure by kernel convention.
 */

import type { Receipt, Settlement } from "@/lib/domain/types";
import { chainHash, typedHash } from "@/lib/domain/canonical";

export type ReceiptDraft = Omit<Receipt, "previousReceiptHash" | "version">;

export const SETTLEMENT_RECEIPT_SIGNER = "unsigned:mitra-settlement-service";

/**
 * The hash the NEXT receipt in the chain must carry as `previousReceiptHash` — and the
 * value a receipt signature signs. The signature itself is excluded, so signing a
 * receipt does not change its place in the chain.
 */
export function receiptHash(receipt: Receipt): string {
  const { previousReceiptHash, signature: _signature, ...body } = receipt;
  return chainHash(previousReceiptHash ?? null, body);
}

/** Signs a receipt's hash. The key never reaches the store: the store calls this. */
export interface ReceiptSigner {
  /** `"eip191:<address>"`, written into `signer` before the hash is computed. */
  readonly id: string;
  /** EIP-191 signature over the receipt hash's 32 bytes (`receiptHashBytes`). */
  sign(hash: `0x${string}`): Promise<string>;
}

/** Links, then signs if a signer is given. Used by both stores inside their append. */
export async function linkAndSign(draft: ReceiptDraft, previous: Receipt | null, signer?: ReceiptSigner): Promise<Receipt> {
  const linked = linkReceipt(signer ? { ...draft, signer: signer.id } : draft, previous);
  return signer ? { ...linked, signature: await signer.sign(receiptHashBytes(linked)) } : linked;
}

/** Links a draft onto the chain whose last receipt is `previous` (null for the first). */
export function linkReceipt(draft: ReceiptDraft, previous: Receipt | null): Receipt {
  return {
    ...draft,
    ...(previous ? { previousReceiptHash: receiptHash(previous) } : {}),
    version: 1,
  };
}

export type ChainVerdict = { ok: true } | { ok: false; brokenAt: string; reason: string };

/** Walks one run's receipts, oldest first, and names the first broken link. */
export function verifyReceiptChain(receipts: Receipt[]): ChainVerdict {
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const expected = i === 0 ? undefined : receiptHash(receipts[i - 1]);
    if (r.previousReceiptHash !== expected) {
      return { ok: false, brokenAt: r.receiptId, reason: i === 0 ? "FIRST_RECEIPT_HAS_PREDECESSOR" : "PREVIOUS_HASH_MISMATCH" };
    }
  }
  return { ok: true };
}

/**
 * The receipt for a CONFIRMED settlement.
 *
 * `payloadHash` commits to the settlement record as confirmed (minus `receiptId`,
 * which cannot exist before this receipt does). `chainEvidence` names the network
 * and transaction, so the receipt points at the authoritative record (§17.5:
 * observed state, not inferred).
 */
export function settlementReceipt(settlement: Settlement, network: string, at: Date): ReceiptDraft {
  if (settlement.status !== "CONFIRMED" || !settlement.txHash) throw new Error("RECEIPT_REQUIRES_CONFIRMED_SETTLEMENT");
  const { receiptId: _r, ...payload } = settlement;
  return {
    receiptId: `rcpt_${settlement.settlementId}`,
    runId: settlement.runId,
    receiptType: "SettlementReceipt",
    eventType: "SETTLEMENT_CONFIRMED",
    subject: settlement.settlementId,
    result: "SUCCESS",
    reasonCodes: ["CONFIRMED_FROM_CHAIN"],
    payloadHash: typedHash("mitra.settlement.v1", payload),
    signer: SETTLEMENT_RECEIPT_SIGNER,
    createdAt: at.toISOString(),
    chainEvidence: [`${network}:tx:${settlement.txHash}`],
  };
}

export interface ReceiptCheck {
  receiptId: string;
  signed: boolean;
  /** For a signed receipt: the signature recovers to the address its `signer` names. */
  valid: boolean;
  reason?: string;
}

/**
 * Checks each receipt's signature (backlog #4). An unsigned receipt is reported as
 * unsigned — not invalid, not valid. A signed one is valid only if the EIP-191
 * signature over its `receiptHash` recovers to the address in `signer`; any edit to
 * the receipt changes the hash and fails it.
 */
export async function verifyReceipts(receipts: Receipt[]): Promise<ReceiptCheck[]> {
  const { recoverMessageAddress } = await import("viem");
  return Promise.all(receipts.map(async (r) => {
    if (!r.signer.startsWith("eip191:")) return { receiptId: r.receiptId, signed: false, valid: false, reason: "UNSIGNED" };
    if (!r.signature) return { receiptId: r.receiptId, signed: true, valid: false, reason: "SIGNATURE_MISSING" };
    try {
      const recovered = await recoverMessageAddress({ message: { raw: receiptHashBytes(r) }, signature: r.signature as `0x${string}` });
      const ok = recovered.toLowerCase() === r.signer.slice("eip191:".length).toLowerCase();
      return { receiptId: r.receiptId, signed: true, valid: ok, ...(ok ? {} : { reason: "SIGNER_MISMATCH" }) };
    } catch {
      return { receiptId: r.receiptId, signed: true, valid: false, reason: "SIGNATURE_MALFORMED" };
    }
  }));
}

/** The 32 bytes a receipt signature signs: the sha256 behind `receiptHash`'s "sha256:<hex>". */
export function receiptHashBytes(r: Receipt): `0x${string}` {
  const h = receiptHash(r);
  return `0x${h.replace(/^sha256:/, "")}`;
}
