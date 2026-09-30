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

export interface PolicyResult {
  decision: AuthorizationDecision;
  reasonCodes: string[];
}

export function evaluateProposal(mandate: Mandate, vault: Vault, proposal: ActionProposal): PolicyResult {
  const reasons: string[] = [];
  if (mandate.status !== "ACTIVE") reasons.push("MANDATE_NOT_ACTIVE");
  if (proposal.now >= new Date(mandate.expiresAt)) reasons.push("MANDATE_EXPIRED");
  if (proposal.asset !== mandate.asset) reasons.push("ASSET_NOT_ALLOWED");
  if (!mandate.approvedChains.includes(proposal.chain as never)) reasons.push("CHAIN_NOT_ALLOWED");
  if (proposal.amount > mandate.maxTransaction) reasons.push("MAX_TRANSACTION_EXCEEDED");
  if (proposal.amount > mandate.budget) reasons.push("MANDATE_BUDGET_EXCEEDED");
  if (proposal.amount > vault.available) reasons.push("INSUFFICIENT_AVAILABLE_CAPITAL");
  if (vault.emergencyFreeze || vault.frozen >= vault.total) reasons.push("VAULT_FROZEN");
  if (!mandate.allowedCapabilities.includes(proposal.capability)) reasons.push("CAPABILITY_NOT_ALLOWED");
  if (mandate.prohibitedCapabilities.includes(proposal.capability)) reasons.push("CAPABILITY_PROHIBITED");
  const cpAllowed = mandate.allowedCounterparties.some((rule) => rule.endsWith("*") ? proposal.counterparty.startsWith(rule.slice(0, -1)) : rule === proposal.counterparty);
  if (!cpAllowed) reasons.push("COUNTERPARTY_NOT_ALLOWED");
  return reasons.length ? { decision: "DENY", reasonCodes: reasons } : { decision: "ALLOW", reasonCodes: ["POLICY_OK"] };
}

export function validateExecutionBinding(reservation: Reservation, actionDigest: string, amount: number, asset: string, chain: string) {
  if (reservation.status !== "RESERVED" && reservation.status !== "COMMITTED") return { ok: false, reason: "RESERVATION_NOT_EXECUTABLE" };
  if (reservation.actionDigest !== actionDigest) return { ok: false, reason: "ACTION_DIGEST_MISMATCH" };
  if (reservation.amount < amount) return { ok: false, reason: "AMOUNT_EXCEEDS_RESERVATION" };
  if (reservation.asset !== asset) return { ok: false, reason: "ASSET_MISMATCH" };
  if (reservation.chain !== chain) return { ok: false, reason: "CHAIN_MISMATCH" };
  return { ok: true as const };
}
