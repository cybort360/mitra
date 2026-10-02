/**
 * x402 and MPP — machine payment protocols (PRD Phase 5; MPP also Phase 9 for
 * Tempo, where the PRD explicitly requires "payment metadata" and "receipt
 * mapping").
 *
 * ## What they are for, in one sentence each
 *
 * **x402** — an HTTP 402 response carrying a payment instruction, so a paid
 * resource can be fetched by a machine that holds a bounded allowance rather than
 * by a human with a card.
 *
 * **MPP** — the same idea made explicit for *sessions*: a metered flow where
 * many small charges accumulate against one pre-authorised ceiling and settle
 * once, rather than one transaction per call.
 *
 * ## The property that matters for Mitra
 *
 * **Neither may move capital on its own.** Both issue *instructions*; the vault
 * decides whether value actually moves. An adapter that treated a 402 challenge or
 * an MPP session as authorisation would make the payment protocol the execution
 * guard — precisely the inversion §1.3 forbids ("Authority is a condition of vault
 * use"). So every charge here returns a CEILING and a debit instruction, and the
 * caller must still route it through the reservation and execution-binding path.
 *
 * This is also why the existing `PaymentAdapter` interface is kept rather than
 * replaced: `charge()` returns a `paymentRef` and an evidence level, never a
 * transfer.
 */

import type { EvidenceLevel } from "@/lib/domain/types";

export interface PaymentCeiling {
  asset: string;
  amount: number;
  /** Absolute expiry. A session must not outlive its authority. */
  expiresAt: string;
}

export interface BoundedSession {
  sessionId: string;
  reservationId: string;
  ceiling: PaymentCeiling;
  spent: number;
  charges: number;
  status: "OPEN" | "CLOSED" | "EXPIRED";
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const sfail = <T>(reason: string): SessionResult<T> => ({ ok: false, reason });
const spass = <T>(value: T): SessionResult<T> => ({ ok: true, value });

/**
 * Opens a metered session against a pre-existing reservation.
 *
 * The reservation id is required: a session with no reservation behind it is a
 * floating allowance, which is exactly the unbounded-authority case the vault
 * exists to prevent.
 */
export function openSession(input: {
  sessionId: string;
  reservationId: string;
  ceiling: PaymentCeiling;
}): SessionResult<BoundedSession> {
  if (!input.reservationId) return sfail("SESSION_REQUIRES_RESERVATION");
  if (!(input.ceiling.amount > 0)) return sfail("SESSION_CEILING_MUST_BE_POSITIVE");
  if (Date.parse(input.ceiling.expiresAt) <= 0) return sfail("SESSION_EXPIRY_INVALID");
  return spass({
    sessionId: input.sessionId,
    reservationId: input.reservationId,
    ceiling: input.ceiling,
    spent: 0,
    charges: 0,
    status: "OPEN",
  });
}

/**
 * Records a charge against a session.
 *
 * **Refuses once the ceiling is reached.** The ceiling is the whole point: a
 * session that can be charged past its allowance is a wallet with no limit, and
 * the failure appears as an oversized bill rather than a refusal.
 */
export function chargeSession(
  session: BoundedSession,
  amount: number,
  now: Date,
): SessionResult<{ session: BoundedSession; paymentRef: string; evidenceLevel: EvidenceLevel }> {
  if (session.status !== "OPEN") return sfail("SESSION_NOT_OPEN");
  if (!(amount > 0) || !Number.isFinite(amount)) return sfail("CHARGE_MUST_BE_POSITIVE");
  if (now >= new Date(session.ceiling.expiresAt)) {
    // Refuse rather than charge. The session is expired, so the correct answer
    // is a named refusal the caller can act on, not a zero-amount charge against
    // a closed session.
    return sfail("SESSION_EXPIRED");
  }
  if (session.spent + amount > session.ceiling.amount) {
    return sfail("SESSION_CEILING_EXCEEDED");
  }
  const next: BoundedSession = {
    ...session,
    spent: Number((session.spent + amount).toFixed(8)),
    charges: session.charges + 1,
  };
  return spass({
    session: next,
    // A REFERENCE, not a transfer. Nothing has moved; the reservation still has
    // to be executed through the guard.
    paymentRef: `pay:${session.sessionId}:${next.charges}`,
    evidenceLevel: "LOCAL_PASS" as EvidenceLevel,
  });
}

export function closeSession(session: BoundedSession, now: Date): BoundedSession {
  const expired = now >= new Date(session.ceiling.expiresAt);
  return { ...session, status: expired ? "EXPIRED" : "CLOSED" };
}

/**
 * The x402 challenge.
 *
 * A 402 carries the instruction; it does not authorise anything. `amount` is a
 * ceiling the payer must satisfy from its own policy, and the resource is not
 * granted until a settlement receipt exists.
 */
export interface X402Challenge {
  resource: string;
  asset: string;
  amount: number;
  reservationId?: string;
  recipient: string;
}

export function x402ChallengeValid(c: X402Challenge, now: Date): SessionResult<true> {
  if (!c.resource) return sfail("CHALLENGE_RESOURCE_REQUIRED");
  if (!(c.amount > 0)) return sfail("CHALLENGE_AMOUNT_INVALID");
  if (!c.recipient) return sfail("CHALLENGE_RECIPIENT_REQUIRED");
  // No reservation means nothing bounds this payment. Refused rather than
  // allowed through on the theory that the payer will be careful.
  if (!c.reservationId) return sfail("CHALLENGE_REQUIRES_RESERVATION");
  return spass(true);
}

// ── Tempo: payment metadata and receipt mapping (PRD Phase 9) ────────────────

/**
 * Tempo payment metadata.
 *
 * Tempo settles in TIP-20 (F12: native balance is a constant), so payment
 * metadata MUST name the token mint and its decimals. A metadata blob without a
 * mint is unusable on this chain, and a wrong `decimals` silently mis-scales
 * every amount by a power of ten — the most expensive kind of metadata bug.
 */
export interface TempoPaymentMetadata {
  network: string;
  mint: string;
  decimals: number;
  asset: string;
}

export function tempoPaymentMetadata(
  network: string,
  mint: string,
  asset: string,
): SessionResult<TempoPaymentMetadata> {
  if (!mint || !mint.startsWith("0x")) return sfail("METADATA_MINT_MUST_BE_ADDRESS");
  if (!network) return sfail("METADATA_NETWORK_REQUIRED");
  // Decimals are resolved by the caller from the token contract; the adapter
  // stores them rather than guessing. A guess here is F12 wearing a different hat.
  return spass({ network, mint, decimals: -1, asset });
}

export function withDecimals(
  m: TempoPaymentMetadata,
  decimals: number,
): TempoPaymentMetadata {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("INVALID_TOKEN_DECIMALS");
  }
  return { ...m, decimals };
}

/**
 * Maps a Mitra receipt onto a Tempo-side settlement record.
 *
 * Requires a metadata block that already carries **resolved** decimals. An
 * unresolved block (`decimals: -1`) is refused rather than mapped, because
 * converting an amount without a scale silently multiplies or divides it by a
 * power of ten — and a receipt whose `amountAtomic` is off by 10^6 is worse than
 * one that was never produced.
 */
export type TempoReceiptRecord = TempoPaymentMetadata & {
  receiptId: string;
  settlementId: string;
  amount: number;
  amountAtomic: string;
};

export function tempoReceiptMapping(
  metadata: TempoPaymentMetadata,
  receipt: { receiptId: string; settlementId: string; amount: number },
): SessionResult<TempoReceiptRecord> {
  if (metadata.decimals < 0) {
    return sfail("RECEIPT_MAPPING_REQUIRES_RESOLVED_DECIMALS");
  }
  if (!(receipt.amount > 0)) return sfail("RECEIPT_AMOUNT_INVALID");
  if (!receipt.settlementId) return sfail("RECEIPT_SETTLEMENT_ID_REQUIRED");
  return spass({
    ...metadata,
    receiptId: receipt.receiptId,
    settlementId: receipt.settlementId,
    amount: receipt.amount,
    amountAtomic: (receipt.amount * 10 ** metadata.decimals).toFixed(0),
  });
}
