/**
 * Agreement settlement — the check that decides whether an ACCEPTED agreement may
 * be paid from a particular reservation (sprint item 1; PRD Phases 8/9).
 *
 * Until this module existed, no route or kernel code called a `SettlementAdapter`:
 * all three rails settled live, but only from their own tests, so no Mitra
 * obligation ever reached one. This is the kernel half of that wiring. The IO half
 * is `lib/settlement/settle-agreement.ts`.
 *
 * ## ACCEPTED is not permission to move value
 *
 * The lead's seq 55 answer: payment is released only from `ACCEPTED`. That is the
 * *commercial* condition. It says the price is owed; it does not say this vault
 * may pay it, under this mandate, through this instruction. So acceptance is only
 * the first of the checks below, and the last is the execution guard
 * (`validateExecutionBinding`), re-run here against a digest RE-DERIVED from the
 * agreement's own terms. The caller supplies two ids and a clock. It cannot supply
 * the amount, the asset, the chain, the payee or the digest.
 *
 * Pure by kernel convention: no clock, no store, no IO.
 */

import type { Agent, Agreement, Chain, ClearingEpoch, Mandate, Money, Reservation, Vault } from "@/lib/domain/types";
import { assertSettlementBinding, fail, pass, type Result } from "@/lib/kernel/commerce";
import { validateExecutionBinding } from "@/lib/kernel/authorization";
import { actionDigestFor } from "@/lib/store/ids";

/**
 * The capability an agreement payment is reserved under.
 *
 * Fixed rather than taken from the request, because the capability is part of the
 * action digest: a caller allowed to name it could choose whichever capability its
 * mandate happens to allow. `applyAgreementOp` already defaults to `"payment"`.
 */
export const AGREEMENT_PAYMENT_CAPABILITY = "payment";

/**
 * One settlement per agreement, by construction.
 *
 * The id is derived, not generated, so the store's primary key is what refuses a
 * second concurrent settlement for the same agreement — the same pattern as
 * `consumed_nonces`. A random id would leave "is one already in flight?" to a
 * read-then-write, which two racers both pass.
 */
export const settlementIdFor = (agreementId: string) => `set_${agreementId}`;

/**
 * The action digest a reservation must carry to pay this agreement.
 *
 * Every field comes from the agreement or the reservation's own vault/mandate. The
 * agreement id is bound, so a reservation for one agreement cannot pay another
 * with the same provider and price.
 */
export function agreementPaymentDigest(
  agreement: Agreement,
  reservation: Pick<Reservation, "vaultId" | "mandateId" | "mandateVersion">,
  chain: Chain,
): string {
  return actionDigestFor({
    vaultId: reservation.vaultId,
    mandateId: reservation.mandateId,
    mandateVersion: reservation.mandateVersion,
    amount: agreement.price.amount,
    asset: agreement.price.asset,
    chain,
    counterparty: agreement.provider,
    capability: AGREEMENT_PAYMENT_CAPABILITY,
    agreementId: agreement.agreementId,
  });
}

export interface SettlementPlan {
  settlementId: string;
  chain: Chain;
  amount: Money;
  /** The payee, from the agreement's terms. */
  to: string;
}

/**
 * Decides whether `reservation` may pay `agreement`, and what exactly it pays.
 *
 * Each refusal is its own reason code, for the same reason `admitsProposal` keeps
 * them apart: "not accepted yet", "wrong reservation" and "mandate revoked" have
 * different fixes, and one merged code would hide which one applies.
 *
 * The mandate and vault are re-checked here even though policy ran when the
 * reservation was made: a mandate can be revoked and a vault frozen in between,
 * and the on-chain vault re-checks both at spend time too.
 */
export function planAgreementSettlement(input: {
  agreement: Agreement;
  reservation: Reservation;
  mandate: Mandate;
  vault: Vault;
  now: Date;
  /** From the store, never from the request — see the execute route. */
  consumedNonces: number[];
}): Result<SettlementPlan> {
  const { agreement, reservation, mandate, vault, now } = input;

  // ACCEPTED, not already settled. Provider and amount are derived from the
  // agreement itself below, so the binding's substitution checks hold by
  // construction; it is called for the state and ALREADY_SETTLED checks.
  const due = assertSettlementBinding(agreement, { provider: agreement.provider, amount: agreement.price });
  if (!due.ok) return fail(due.reason);

  if (!agreement.payTo) return fail("PAYOUT_ADDRESS_MISSING");
  const chain = agreement.payTo.chain;

  if (reservation.agreementId !== agreement.agreementId) return fail("RESERVATION_NOT_FOR_AGREEMENT");
  if (mandate.mandateId !== reservation.mandateId) return fail("MANDATE_MISMATCH");
  // The client pays, so the mandate spending must be the client's. Without this a
  // reservation under some other agent's mandate could pay the client's debts.
  if (mandate.agentId !== agreement.client) return fail("MANDATE_NOT_HELD_BY_CLIENT");
  if (mandate.vaultId !== vault.vaultId || reservation.vaultId !== vault.vaultId) return fail("VAULT_MISMATCH");
  if (vault.chain !== chain) return fail("VAULT_CHAIN_MISMATCH");

  if (mandate.status !== "ACTIVE") return fail("MANDATE_NOT_ACTIVE");
  if (now >= new Date(mandate.expiresAt)) return fail("MANDATE_EXPIRED");
  if (vault.emergencyFreeze) return fail("VAULT_FROZEN");

  const guard = validateExecutionBinding(
    reservation,
    agreementPaymentDigest(agreement, reservation, chain),
    agreement.price.amount,
    agreement.price.asset,
    chain,
    now,
    { consumedNonces: input.consumedNonces },
  );
  if (!guard.ok) return fail(guard.reason);

  return pass({
    settlementId: settlementIdFor(agreement.agreementId),
    chain,
    amount: agreement.price,
    to: agreement.payTo.address,
  });
}

// ── Clearing residuals (Phase 7) ─────────────────────────────────────────────
//
// A FINALIZED epoch's residual transfer is paid like an agreement: from the
// FROM party's vault, under its mandate, by a reservation the policy engine
// approved for exactly that transfer, through the execution guard. Decision:
// shared context ctx_9b9e7a8c3172e71b.

/** Fixed for the same reason as AGREEMENT_PAYMENT_CAPABILITY: it is part of the digest. */
export const RESIDUAL_CAPABILITY = "clearing_residual";

/** Names one residual transfer of one epoch. */
export const residualRef = (epochId: string, index: number) => `${epochId}#${index}`;

/** One settlement per residual, by construction: the store's key refuses a second. */
export const residualSettlementIdFor = (epochId: string, index: number) => `set_${epochId}_${index}`;

/** The action digest a reservation must carry to pay residual `index` of `epoch`. */
export function residualPaymentDigest(
  epoch: ClearingEpoch,
  index: number,
  reservation: Pick<Reservation, "vaultId" | "mandateId" | "mandateVersion">,
  chain: Chain,
): string {
  const t = epoch.residualTransfers[index];
  return actionDigestFor({
    vaultId: reservation.vaultId,
    mandateId: reservation.mandateId,
    mandateVersion: reservation.mandateVersion,
    amount: t.amount,
    asset: epoch.asset,
    chain,
    counterparty: t.to,
    capability: RESIDUAL_CAPABILITY,
    residualRef: residualRef(epoch.epochId, index),
  });
}

/**
 * Decides whether `reservation` may pay residual `transferIndex` of `epoch`, and to
 * which address. The payee is the TO party's registered wallet on the epoch's
 * chain, so no caller can name where the money goes.
 */
export function planResidualSettlement(input: {
  epoch: ClearingEpoch;
  transferIndex: number;
  /** The TO party's agent record, from the registry. */
  payee: Pick<Agent, "agentId" | "wallets">;
  reservation: Reservation;
  mandate: Mandate;
  vault: Vault;
  now: Date;
  /** From the store, never from the request. */
  consumedNonces: number[];
}): Result<SettlementPlan> {
  const { epoch, transferIndex, payee, reservation, mandate, vault, now } = input;

  // FINALIZED, or SETTLING once its first residual is paid. Never before: a
  // result still open to challenge is not a debt yet.
  if (epoch.status !== "FINALIZED" && epoch.status !== "SETTLING") return fail("EPOCH_NOT_FINALIZED");
  const transfer = epoch.residualTransfers[transferIndex];
  if (!transfer) return fail("UNKNOWN_RESIDUAL");
  const chain = epoch.settlementDomain;

  if (payee.agentId !== transfer.to) return fail("PAYEE_IS_NOT_THE_CREDITOR");
  const wallet = payee.wallets.find((w) => w.chain === chain);
  if (!wallet) return fail("PAYEE_HAS_NO_WALLET_ON_CHAIN");

  if (reservation.residualRef !== residualRef(epoch.epochId, transferIndex)) return fail("RESERVATION_NOT_FOR_RESIDUAL");
  if (mandate.mandateId !== reservation.mandateId) return fail("MANDATE_MISMATCH");
  // The debtor pays, so the mandate spending must be the debtor's.
  if (mandate.agentId !== transfer.from) return fail("MANDATE_NOT_HELD_BY_DEBTOR");
  if (mandate.vaultId !== vault.vaultId || reservation.vaultId !== vault.vaultId) return fail("VAULT_MISMATCH");
  if (vault.chain !== chain) return fail("VAULT_CHAIN_MISMATCH");

  if (mandate.status !== "ACTIVE") return fail("MANDATE_NOT_ACTIVE");
  if (now >= new Date(mandate.expiresAt)) return fail("MANDATE_EXPIRED");
  if (vault.emergencyFreeze) return fail("VAULT_FROZEN");

  const guard = validateExecutionBinding(
    reservation,
    residualPaymentDigest(epoch, transferIndex, reservation, chain),
    transfer.amount,
    epoch.asset,
    chain,
    now,
    { consumedNonces: input.consumedNonces },
  );
  if (!guard.ok) return fail(guard.reason);

  return pass({
    settlementId: residualSettlementIdFor(epoch.epochId, transferIndex),
    chain,
    amount: { asset: epoch.asset, amount: transfer.amount },
    to: wallet.address,
  });
}
