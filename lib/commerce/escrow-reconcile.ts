/**
 * Reconciling an agreement with the escrow that holds its capital (F97).
 *
 * ## The problem
 *
 * On Solana a keeper — nobody in particular, possibly nobody in the system — may refund a
 * timed-out escrow. On EVM a client or evaluator may refund for a failed verdict. Neither
 * involves Mitra, so neither produces a state transition, and the agreement keeps saying
 * `FUNDED` while the chain says `REFUNDED` and the money has gone home.
 *
 * That divergence is not cosmetic. An agreement whose capital has been returned but which
 * still reads as funded will be counted as outstanding, can be `acceptDeliverable`d into a
 * release against an escrow that no longer exists, and its §15.5 compensation route stays
 * "committed" to a refund that has already happened.
 *
 * ## Direction: the chain is authoritative for ESCROW state
 *
 * Only one direction is reconciled automatically, and it is the one where the chain is
 * unambiguous: **the escrow has been refunded**. A chain-completed escrow is *not*
 * auto-advanced to `ACCEPTED`, because acceptance has to drive the settlement saga — the
 * release happens as part of `acceptDeliverable`, so seeing `COMPLETED` here means that op
 * ran and only its database half failed. Reconciling that would advance an agreement past
 * the state machine without arming or discharging the saga that is supposed to carry it.
 *
 * ## Why this can write
 *
 * Reconciliation runs on the agreement read path, and a read that mutates state is normally
 * wrong. Here it is the lesser evil, and the alternative is worse: a GET that returns a
 * known-stale status is a lie told to whoever asked, and the caller has no way to know which
 * number is stale. The write is bounded — only agreements that HAVE an escrow, only when the
 * probe reports a terminal divergence, and only in the refunded direction — and every
 * reconciliation records an event, so the read that healed is visible in the audit log.
 */

import type { Agreement } from "@/lib/domain/types";
import { escrowIdFor, type EscrowRail } from "@/lib/commerce/onchain-escrow";
import { probeEscrowStatus, type EscrowTerms } from "@/lib/commerce/onchain-escrow";

/** Statuses an agreement may still be pulled out of by a refund that already happened. */
const REFUNDABLE_STATUSES = new Set<Agreement["status"]>(["FUNDED", "EXECUTING", "SUBMITTED", "OPEN"]);

export type ReconcileOutcome =
  /** Nothing to do: no escrow, or the chain agrees. */
  | { changed: false; reason?: string }
  /** The chain says refunded and Mitra now agrees. */
  | { changed: true; from: Agreement["status"]; to: Agreement["status"]; onChainRefundTx?: string };

/**
 * Ask the chain what happened to an agreement's escrow, and heal the agreement if needed.
 *
 * `intended` is the agreement's own terms. A probe that reports `MISMATCH` means the chain
 * holds a *different* escrow under this agreement's identity — which is not a divergence to
 * heal but an identity collision to refuse, so it is reported and nothing is written.
 */
export async function reconcileEscrow(input: {
  agreement: Agreement;
  rail: EscrowRail;
  intended: EscrowTerms;
}): Promise<ReconcileOutcome> {
  const { agreement, rail, intended } = input;
  if (!agreement.escrowRef) return { changed: false, reason: "NO_ESCROW" };
  if (!REFUNDABLE_STATUSES.has(agreement.status)) {
    // Already terminal or past the point where capital is escrowed. Not ours to change.
    return { changed: false, reason: "STATUS_NOT_REFUNDABLE" };
  }

  const probe = await probeEscrowStatus({ ...agreement, agreementId: agreement.agreementId }, rail, intended);
  if (probe.state === "MISMATCH") {
    return { changed: false, reason: probe.reason };
  }
  if (probe.state !== "SETTLED" || probe.outcome !== "refunded") {
    // ABSENT or FUNDED, or COMPLETED — the completed case is deliberately not advanced here.
    return { changed: false, reason: probe.state === "SETTLED" ? "ESCROW_COMPLETED_NOT_ADVANCED" : "ESCROW_NOT_TERMINAL" };
  }

  return { changed: true, from: agreement.status, to: "REFUNDED" };
}

/**
 * The terms to probe with, rebuilt from the agreement.
 *
 * Mirrors the route's own term construction. If the two drift, reconciliation will either
 * never fire or fire on a mismatch — so it is derived from the same fields, and a Solana
 * agreement is probed with the authority the rail reports rather than a request field.
 */
export function intendedTermsFor(
  agreement: Agreement,
  rail: EscrowRail,
  fallbackClient: string,
  fallbackTimeout: bigint,
): EscrowTerms | null {
  const provider = agreement.payTo?.address;
  if (!provider) return null;
  return {
    amount: rail.solana ? 1n : 0n, // refined by the caller for the asset it prices
    provider,
    client: rail.solana ? rail.solana.authority : fallbackClient,
    timeout: fallbackTimeout,
  };
}

export { escrowIdFor };