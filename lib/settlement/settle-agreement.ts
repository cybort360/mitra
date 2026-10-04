/**
 * Pays an ACCEPTED agreement through a live settlement rail (sprint item 1).
 *
 * `lib/kernel/settlement.ts` decides whether the payment may happen. This module
 * does the IO in an order chosen so that a crash or error at any step leaves either
 * nothing moved or a record that says the outcome is unknown, never a payment the
 * store does not know about and never a second payment:
 *
 *  1. Every refusal that needs no write: the kernel plan, the rail, the vault's
 *     binding to the rail, the adapter's own target check, the commitment.
 *  2. CLAIM the settlement (`PENDING`). Its id is derived from the agreement id,
 *     so the store's key refuses a second concurrent claim.
 *  3. CONSUME the reservation's nonce. The execution guard's single-use boundary.
 *  4. BROADCAST through the adapter.
 *  5. VERIFY from the chain, then mark the agreement settled.
 *
 * ## What an error means at each step
 *
 * Before 4, nothing can have left: the claim is marked `FAILED` (which a later
 * claim may replace). At 4 a transport error is AMBIGUOUS — the transaction may
 * have been broadcast and landed — so the claim stays `PENDING` with the reason,
 * and no retry is possible until someone reconciles it against the chain. Paying
 * twice is worse than paying late. After 4, an unconfirmed transfer stays
 * `SUBMITTED` and `confirmSettlement` re-checks it later.
 *
 * ## Not done here (recorded, not hidden)
 *
 * Vault capital moves with the reservation (backlog #2): `reserved → settling` when
 * settlement begins, and on confirmation the reserved amount leaves `settling` and
 * the paid amount leaves `total` (`settleCapital`). A SettlementReceipt is written on confirmation (`lib/kernel/receipts.ts`); it is
 * hash-chained per run but not yet signed.
 */

import type { Agreement, Settlement } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import { planAgreementSettlement } from "@/lib/kernel/settlement";
import { settlementReceipt, type ReceiptSigner } from "@/lib/kernel/receipts";
import type { Rails, SettlementRail } from "@/lib/settlement/rails";

export type SettleOutcome =
  | { ok: true; httpStatus: 200 | 202; settlement: Settlement; agreement: Agreement }
  | { ok: false; httpStatus: number; reason: string; settlement?: Settlement };

const refuse = (httpStatus: number, reason: string, settlement?: Settlement): SettleOutcome =>
  ({ ok: false, httpStatus, reason, ...(settlement ? { settlement } : {}) });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type SettlementStore = EconomicRepository &
  Required<Pick<EconomicRepository, "getAgreement" | "updateAgreement">>;

function canPersist(repo: EconomicRepository): repo is SettlementStore {
  return typeof repo.getAgreement === "function" && typeof repo.updateAgreement === "function";
}

export async function settleAgreement(
  repo: EconomicRepository,
  rails: Rails,
  input: { agreementId: string; reservationId: string; now: Date; receiptSigner?: ReceiptSigner },
): Promise<SettleOutcome> {
  // A store that cannot write the agreement back would pay and then forget it
  // paid. Refuse up front rather than discover it after the transfer.
  if (!canPersist(repo)) return refuse(501, "STORE_CANNOT_PERSIST_SETTLEMENT");

  const agreement = await repo.getAgreement(input.agreementId);
  if (!agreement) return refuse(404, "AGREEMENT_NOT_FOUND");
  const reservation = await repo.getReservation(input.reservationId);
  if (!reservation) return refuse(404, "RESERVATION_NOT_FOUND");
  const mandate = await repo.getMandate(reservation.mandateId);
  if (!mandate) return refuse(404, "MANDATE_NOT_FOUND");
  const vault = await repo.getVault(reservation.vaultId);
  if (!vault) return refuse(404, "VAULT_NOT_FOUND");

  // From the store, never the request (same rule as /reservations/execute).
  const consumedNonces = (await repo.listReservations(vault.vaultId))
    .filter((r) => r.status === "COMMITTED" || r.status === "SETTLING" || r.status === "SETTLED")
    .map((r) => r.nonce);

  const plan = planAgreementSettlement({ agreement, reservation, mandate, vault, now: input.now, consumedNonces });
  if (!plan.ok) return refuse(409, plan.reason);
  const { settlementId, chain, amount, to } = plan.value;

  const rail = rails[chain];
  if (!rail) return refuse(503, "SETTLEMENT_RAIL_NOT_CONFIGURED");
  if (vault.address !== rail.payer) return refuse(409, "VAULT_NOT_BOUND_TO_RAIL");

  let commitment: string;
  try {
    await rail.adapter.validateTarget({ asset: amount.asset, recipient: to, amount: amount.amount });
    commitment = rail.commitment({ settlementId, from: rail.payer, to, amount });
  } catch (e) {
    return refuse(409, message(e));
  }

  // ── 2. claim ───────────────────────────────────────────────────────────────
  let settlement: Settlement = {
    settlementId,
    runId: agreement.runId,
    agreementId: agreement.agreementId,
    reservationId: reservation.reservationId,
    obligationIds: [],
    chain,
    asset: amount.asset,
    amount: amount.amount,
    from: rail.payer,
    to,
    commitment,
    status: "PENDING",
    submittedAt: input.now.toISOString(),
    evidenceLevel: "DESIGN_ONLY",
  };
  if (!await repo.claimSettlement(settlement)) return refuse(409, "SETTLEMENT_ALREADY_CLAIMED");

  const stopBeforeBroadcast = async (reason: string, httpStatus = 409) => {
    settlement = { ...settlement, status: "FAILED", failureReason: reason };
    await repo.updateSettlement(settlement);
    return refuse(httpStatus, reason, settlement);
  };

  // ── 3. consume ─────────────────────────────────────────────────────────────
  if (!await repo.consumeNonce(vault.vaultId, reservation.nonce, reservation.reservationId)) {
    return stopBeforeBroadcast("NONCE_ALREADY_CONSUMED");
  }
  // The reservation becomes SETTLING and its capital moves reserved → settling, in
  // one store operation. Null means another path moved it first; nothing has been
  // broadcast, so this is a clean stop rather than an unknown outcome.
  let began: Awaited<ReturnType<typeof repo.beginSettlement>>;
  try {
    began = await repo.beginSettlement(reservation.reservationId);
  } catch (e) {
    return stopBeforeBroadcast(`RESERVATION_NOT_EXECUTABLE: ${message(e)}`);
  }
  if (!began) return stopBeforeBroadcast("RESERVATION_NOT_EXECUTABLE");

  // ── 4. broadcast ───────────────────────────────────────────────────────────
  let txHash: string;
  try {
    ({ txHash } = await rail.adapter.settle({ settlementId, from: rail.payer, to, amount, commitmentHash: commitment }));
  } catch (e) {
    // Left PENDING on purpose: see the header. The reason is recorded so an
    // operator knows what to reconcile.
    settlement = { ...settlement, failureReason: `OUTCOME_UNKNOWN: ${message(e)}` };
    await repo.updateSettlement(settlement);
    await event(repo, input.now, agreement, settlement, "FAILURE", "Settlement outcome unknown",
      "The transport failed after the nonce was consumed. The transfer may or may not have been broadcast; reconcile against the chain before any retry.");
    return refuse(502, "SETTLEMENT_OUTCOME_UNKNOWN", settlement);
  }
  settlement = { ...settlement, status: "SUBMITTED", txHash, evidenceLevel: "LOCAL_PASS" };
  await repo.updateSettlement(settlement);

  // ── 5. verify ──────────────────────────────────────────────────────────────
  return finish(repo, rail, agreement, settlement, input.now, input.receiptSigner);
}

/**
 * Re-checks a SUBMITTED settlement against the chain and, if it confirmed, marks
 * the agreement settled. Safe to call repeatedly.
 */
export async function confirmSettlement(
  repo: EconomicRepository,
  rails: Rails,
  input: { settlementId: string; now: Date; receiptSigner?: ReceiptSigner },
): Promise<SettleOutcome> {
  if (!canPersist(repo)) return refuse(501, "STORE_CANNOT_PERSIST_SETTLEMENT");
  const settlement = await repo.getSettlement(input.settlementId);
  if (!settlement) return refuse(404, "SETTLEMENT_NOT_FOUND");
  if (!settlement.agreementId) return refuse(409, "SETTLEMENT_PAYS_NO_AGREEMENT");
  const agreement = await repo.getAgreement(settlement.agreementId);
  if (!agreement) return refuse(404, "AGREEMENT_NOT_FOUND");
  if (settlement.status === "CONFIRMED") return { ok: true, httpStatus: 200, settlement, agreement };
  if (settlement.status !== "SUBMITTED" || !settlement.txHash) return refuse(409, `SETTLEMENT_${settlement.status}`, settlement);
  const rail = rails[settlement.chain];
  if (!rail) return refuse(503, "SETTLEMENT_RAIL_NOT_CONFIGURED");
  return finish(repo, rail, agreement, settlement, input.now, input.receiptSigner);
}

async function finish(
  repo: SettlementStore,
  rail: SettlementRail,
  agreement: Agreement,
  submitted: Settlement,
  now: Date,
  receiptSigner?: ReceiptSigner,
): Promise<SettleOutcome> {
  let confirmed = false;
  try {
    ({ confirmed } = await rail.adapter.verify(submitted.txHash!));
  } catch {
    // A failed read is not a failed transfer. It stays SUBMITTED.
  }
  if (!confirmed) {
    await event(repo, now, agreement, submitted, "WARNING", "Settlement submitted, not yet confirmed",
      "The transfer was broadcast but the chain has not confirmed it. The agreement is not marked settled.");
    return { ok: true, httpStatus: 202, settlement: submitted, agreement };
  }

  // Capital first, and exactly once: SETTLING → SETTLED is the gate, so a second,
  // racing confirmation finds nothing to apply. The record updates below are
  // idempotent and run either way, so a crash between the two is repaired by the
  // next confirm rather than leaving a settled vault with a SUBMITTED record.
  if (submitted.reservationId) await repo.completeSettlement(submitted.reservationId, submitted.amount);

  const confirmedRecord: Settlement = {
    ...submitted,
    status: "CONFIRMED",
    confirmedAt: now.toISOString(),
    evidenceLevel: rail.confirmedEvidence,
  };
  // The receipt is written before the record names it, so a settlement never
  // points at a receipt that does not exist. A crash in between leaves a receipt
  // for a transfer the chain confirmed — true, and re-used on the next confirm,
  // because appendReceipt returns an existing receipt id unchanged.
  const receipt = await repo.appendReceipt(settlementReceipt(confirmedRecord, rail.network, now), receiptSigner);
  const settlement: Settlement = { ...confirmedRecord, receiptId: receipt.receiptId };
  await repo.updateSettlement(settlement);
  const settled: Agreement = { ...agreement, settledRef: settlement.settlementId, version: agreement.version + 1 };
  await repo.updateAgreement(settled);
  await event(repo, now, settled, settlement, "SUCCESS", "Agreement settled",
    "The transfer was confirmed from the chain and bound to this agreement.");
  return { ok: true, httpStatus: 200, settlement, agreement: settled };
}

async function event(
  repo: EconomicRepository,
  at: Date,
  agreement: Agreement,
  settlement: Settlement,
  status: "SUCCESS" | "WARNING" | "FAILURE",
  title: string,
  description: string,
) {
  await repo.appendEvent({
    runId: agreement.runId,
    at: at.toISOString(),
    kind: "SETTLEMENT",
    title,
    description,
    status,
    objectRef: settlement.settlementId,
    metadata: {
      agreementId: agreement.agreementId,
      chain: settlement.chain,
      amount: settlement.amount,
      asset: settlement.asset,
      settlementStatus: settlement.status,
      evidenceLevel: settlement.evidenceLevel,
      ...(settlement.txHash ? { txHash: settlement.txHash } : {}),
    },
  });
}
