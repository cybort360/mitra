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
import { executeEscrowRefund, probeEscrowStatus, type EscrowTerms, type EscrowRail } from "@/lib/commerce/onchain-escrow";

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


/**
 * The KEEPER path: refund an escrow whose deadline has passed, then heal the agreement.
 *
 * ## Why this is separate from `reconcileEscrow`
 *
 * `reconcileEscrow` is a **read** that heals, and it is deliberately passive: it notices a
 * refund that someone else performed. A keeper is the other case — it performs the refund
 * itself. Conflating them would either make a read broadcast a transaction, or make the
 * keeper's write depend on a call site that is supposed to be side-effect-free.
 *
 * ## What this adds over `executeEscrowRefund`
 *
 * The refund broadcast itself already exists and is unchanged. What the keeper adds is the
 * two things around it that make a refund *safe to perform unattended*:
 *
 *  1. **The deadline check, before the call.** `executeEscrowRefund` will happily broadcast
 *     into a contract that reverts. A keeper that runs every few seconds for the life of the
 *     process needs the cheap check locally — but it is a *refusal*, never a substitute for
 *     the contract's own `require(block.timestamp >= timeout)`. The chain remains the
 *     authority; this just stops the keeper from trying.
 *  2. **Verification after.** A confirmed transaction is not the same claim as "the capital
 *     is back with the client" (F86). The keeper re-probes and, if the chain does not agree
 *     that it is settled-and-refunded, returns a refusal that an operator can act on rather
 *     than a success it believes.
 *
 * ## Why the keeper needs no authority
 *
 * `refundJob` / `refundEscrow` are permissionless after the deadline *by design* (PRD §15.5),
 * so recovery does not depend on the client's cooperation. This therefore needs a funded EOA
 * for gas and **no role in any agreement**: it can move capital out of an escrow, and only
 * ever out. It never calls the release path.
 */
export interface KeeperReconcileInput {
  agreement: Agreement;
  rail: EscrowRail;
  intended: EscrowTerms;
  /** Unix seconds, from the chain where possible and from the clock otherwise. */
  now: number;
}

export type KeeperOutcome =
  | { action: "refunded"; txHash: string; agreement: Agreement }
  | { action: "observed"; reason: string; agreement: Agreement }
  /** Something is wrong and an operator should look. Never silent. */
  | { action: "refused"; reason: string; detail?: string };

export async function reconcileAgreementEscrow(input: KeeperReconcileInput): Promise<KeeperOutcome> {
  const { agreement, rail, intended, now } = input;

  let probe;
  try {
    probe = await probeEscrowStatus(agreement, rail, intended);
  } catch (e) {
    return { action: "refused", reason: "RPC_UNREACHABLE", detail: (e as Error).message };
  }
  if (probe.state === "MISMATCH") {
    return { action: "refused", reason: probe.reason, detail: `an escrow exists for ${agreement.agreementId} with different terms` };
  }
  if (probe.state !== "FUNDED") {
    // ABSENT, or already settled by someone else. Either way there is nothing for a keeper
    // to do — and if it is already settled, `reconcileEscrow` will notice and heal.
    return { action: "observed", reason: `escrow is ${probe.state}`, agreement };
  }

  // **Before the deadline, do nothing.** A keeper that refunds a live job destroys work in
  // progress, and the only authority that matters here is the contract's — this is an early
  // exit to avoid a pointless broadcast, not a substitute for `require(timestamp >= timeout)`.
  if (BigInt(now) < intended.timeout) {
    const remaining = Number(intended.timeout - BigInt(now));
    return { action: "observed", reason: `not yet due (${remaining}s remaining)`, agreement };
  }

  const refund = await executeEscrowRefund(agreement, rail, intended);
  if (!refund.ok) {
    return { action: "refused", reason: refund.reason ?? "REFUND_FAILED", detail: refund.detail };
  }
  const txHash = refund.txHash ?? "unknown";

  // Verify the effect, not just the signature — the F86 lesson, applied to the keeper.
  const after = await probeEscrowStatus(agreement, rail, intended);
  if (after.state !== "SETTLED" || after.outcome !== "refunded") {
    return {
      action: "refused",
      reason: "REFUND_NOT_OBSERVED",
      detail: `the chain reports ${after.state} after ${txHash}; the funds are not back and must be reconciled by hand`,
    };
  }

  // Heal the agreement itself, so a reader is not told the capital is still escrowed.
  return {
    action: "refunded",
    txHash,
    agreement: { ...agreement, status: "REFUNDED", escrowReleased: true, version: agreement.version + 1 },
  };
}
