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
 * ## Not signed — and the field says so
 *
 * §17.4 lists `signer`. These receipts are hash-chained but carry no signature yet,
 * so `signer` is `"unsigned:<service>"` rather than a name that reads like a key.
 * Signing is open work, recorded in `forge/FAILURES.md` alongside item 2.
 *
 * Pure by kernel convention.
 */

import type { Receipt, Settlement } from "@/lib/domain/types";
import { chainHash, typedHash } from "@/lib/domain/canonical";

export type ReceiptDraft = Omit<Receipt, "previousReceiptHash" | "version">;

export const SETTLEMENT_RECEIPT_SIGNER = "unsigned:mitra-settlement-service";

/** The hash the NEXT receipt in the chain must carry as `previousReceiptHash`. */
export function receiptHash(receipt: Receipt): string {
  const { previousReceiptHash, ...body } = receipt;
  return chainHash(previousReceiptHash ?? null, body);
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
