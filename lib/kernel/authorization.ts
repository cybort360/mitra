import type { AuthorizationDecision, Mandate, Reservation, Vault } from "@/lib/domain/types";

export interface ActionProposal {
  amount: number;
  asset: string;
  chain: string;
  counterparty: string;
  capability: string;
  actionDigest: string;
  now: Date;
}

/**
 * Spend already executed inside the mandate's velocity window, oldest-first.
 * Supplied by the caller so that policy evaluation stays a pure function and
 * remains deterministically testable.
 */
export interface SpendEvent {
  at: string;
  amount: number;
}

export interface PolicyContext {
  /** Spend records to evaluate the velocity limit against. */
  recentSpend?: SpendEvent[];
}

export interface PolicyResult {
  decision: AuthorizationDecision;
  reasonCodes: string[];
}

const MINUTE_MS = 60_000;

export function evaluateProposal(mandate: Mandate, vault: Vault, proposal: ActionProposal, context: PolicyContext = {}): PolicyResult {
  const reasons: string[] = [];
  if (mandate.status !== "ACTIVE") reasons.push("MANDATE_NOT_ACTIVE");
  if (proposal.now >= new Date(mandate.expiresAt)) reasons.push("MANDATE_EXPIRED");
  if (proposal.asset !== mandate.asset) reasons.push("ASSET_NOT_ALLOWED");
  if (!mandate.approvedChains.includes(proposal.chain as never)) reasons.push("CHAIN_NOT_ALLOWED");
  // Guard the lower bound before any `>` comparison. Every remaining amount
  // check is one-sided, so a negative or non-finite amount would otherwise
  // sail through policy and be caught (if at all) far downstream.
  if (!Number.isFinite(proposal.amount) || proposal.amount <= 0) reasons.push("INVALID_AMOUNT");
  if (proposal.amount > mandate.maxTransaction) reasons.push("MAX_TRANSACTION_EXCEEDED");
  if (proposal.amount > mandate.budget) reasons.push("MANDATE_BUDGET_EXCEEDED");
  if (proposal.amount > vault.available) reasons.push("INSUFFICIENT_AVAILABLE_CAPITAL");
  if (vault.emergencyFreeze || vault.frozen >= vault.total) reasons.push("VAULT_FROZEN");
  if (!mandate.allowedCapabilities.includes(proposal.capability)) reasons.push("CAPABILITY_NOT_ALLOWED");
  if (mandate.prohibitedCapabilities.includes(proposal.capability)) reasons.push("CAPABILITY_PROHIBITED");
  const cpAllowed = mandate.allowedCounterparties.some((rule) => rule.endsWith("*") ? proposal.counterparty.startsWith(rule.slice(0, -1)) : rule === proposal.counterparty);
  if (!cpAllowed) reasons.push("COUNTERPARTY_NOT_ALLOWED");
  if (mandate.velocityLimit) {
    const windowStart = proposal.now.getTime() - mandate.velocityLimit.windowMinutes * MINUTE_MS;
    const spentInWindow = (context.recentSpend ?? [])
      .filter((event) => new Date(event.at).getTime() > windowStart)
      .reduce((sum, event) => sum + event.amount, 0);
    if (spentInWindow + proposal.amount > mandate.velocityLimit.amount) reasons.push("VELOCITY_LIMIT_EXCEEDED");
  }
  return reasons.length ? { decision: "DENY", reasonCodes: reasons } : { decision: "ALLOW", reasonCodes: ["POLICY_OK"] };
}

export interface ExecutionContext {
  /** Reservation nonces already consumed on this vault/mandate. */
  consumedNonces?: number[];
}

/**
 * The execution guard. An authorization decision is not itself permission to
 * move value: the exact instruction must still match the evaluated action.
 *
 * `now` is required rather than defaulted so callers cannot silently evaluate
 * against wall-clock time; a caller that ignores reservation expiry cannot
 * accidentally pass a stale reservation.
 */
export function validateExecutionBinding(
  reservation: Reservation,
  actionDigest: string,
  amount: number,
  asset: string,
  chain: string,
  now: Date,
  context: ExecutionContext = {},
) {
  if (reservation.status !== "RESERVED" && reservation.status !== "COMMITTED") return { ok: false as const, reason: "RESERVATION_NOT_EXECUTABLE" };
  if (now >= new Date(reservation.expiresAt)) return { ok: false as const, reason: "RESERVATION_EXPIRED" };
  if (context.consumedNonces?.includes(reservation.nonce)) return { ok: false as const, reason: "NONCE_ALREADY_CONSUMED" };
  if (reservation.actionDigest !== actionDigest) return { ok: false as const, reason: "ACTION_DIGEST_MISMATCH" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false as const, reason: "INVALID_AMOUNT" };
  if (reservation.amount < amount) return { ok: false as const, reason: "AMOUNT_EXCEEDS_RESERVATION" };
  if (reservation.asset !== asset) return { ok: false as const, reason: "ASSET_MISMATCH" };
  if (reservation.chain !== chain) return { ok: false as const, reason: "CHAIN_MISMATCH" };
  return { ok: true as const };
}
