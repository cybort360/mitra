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

import type { Agreement, ClearingEpoch, Reservation, Settlement, Vault } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import { planAgreementSettlement, planResidualSettlement, residualSettlementIdFor } from "@/lib/kernel/settlement";
import { settlementReceipt, type ReceiptSigner } from "@/lib/kernel/receipts";
import { toAtomic } from "@/lib/evm/eip712";
import type { Rails, SettlementRail } from "@/lib/settlement/rails";
import type { ClearingReader } from "@/lib/settlement/clearing-reader";

/** What a settlement discharged: the agreement it paid, or the epoch whose residual it paid. */
type Discharged = { agreement?: Agreement; epoch?: ClearingEpoch };

export type SettleOutcome =
  | ({ ok: true; httpStatus: 200 | 202; settlement: Settlement } & Discharged)
  | { ok: false; httpStatus: number; reason: string; settlement?: Settlement };

const refuse = (httpStatus: number, reason: string, settlement?: Settlement): SettleOutcome =>
  ({ ok: false, httpStatus, reason, ...(settlement ? { settlement } : {}) });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type SettlementStore = EconomicRepository &
  Required<Pick<EconomicRepository, "getAgreement" | "updateAgreement">>;

function canPersist(repo: EconomicRepository): repo is SettlementStore {
  return typeof repo.getAgreement === "function" && typeof repo.updateAgreement === "function";
}

/**
 * The thing a settlement pays, and what confirming it changes. The IO below is
 * the same for an agreement and a clearing residual; only this differs.
 */
interface Subject {
  runId: string;
  metadata: Record<string, unknown>;
  current: Discharged;
  settledTitle: string;
  settledDescription: string;
  /** Said while the transfer is broadcast but unconfirmed. */
  pendingDescription: string;
  /** Applied once the chain confirmed; idempotent. */
  onConfirmed(settlement: Settlement): Promise<Discharged>;
}

const agreementSubject = (repo: SettlementStore, agreement: Agreement): Subject => ({
  runId: agreement.runId,
  metadata: { agreementId: agreement.agreementId },
  current: { agreement },
  settledTitle: "Agreement settled",
  settledDescription: "The transfer was confirmed from the chain and bound to this agreement.",
  pendingDescription: "The transfer was broadcast but the chain has not confirmed it. The agreement is not marked settled.",
  async onConfirmed(settlement) {
    const settled: Agreement = { ...agreement, settledRef: settlement.settlementId, version: agreement.version + 1 };
    await repo.updateAgreement(settled);
    return { agreement: settled };
  },
});

const residualSubject = (repo: EconomicRepository, epoch: ClearingEpoch, transferIndex: number): Subject => ({
  runId: `run_${epoch.epochId}`,
  metadata: { epochId: epoch.epochId, transferIndex },
  current: { epoch },
  settledTitle: "Clearing residual settled",
  settledDescription: "The residual transfer was confirmed from the chain against the epoch MitraClearing finalized.",
  pendingDescription: "The residual transfer was broadcast but the chain has not confirmed it. The epoch is not marked settled.",
  async onConfirmed() {
    // SETTLED once every residual has a confirmed settlement; SETTLING until then.
    const confirmed = new Set((await repo.listSettlements())
      .filter((s) => s.epochId === epoch.epochId && s.status === "CONFIRMED")
      .map((s) => s.settlementId));
    const latest = (await repo.getEpoch(epoch.epochId)) ?? epoch;
    const all = latest.residualTransfers.every((_, i) => confirmed.has(residualSettlementIdFor(epoch.epochId, i)));
    const next: ClearingEpoch = { ...latest, status: all ? "SETTLED" : "SETTLING" };
    await repo.saveEpoch(next);
    return { epoch: next };
  },
});

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
  const consumedNonces = await consumedNoncesOf(repo, vault);

  const plan = planAgreementSettlement({ agreement, reservation, mandate, vault, now: input.now, consumedNonces });
  if (!plan.ok) return refuse(409, plan.reason);

  return execute(repo, rails, {
    plan: plan.value, reservation, vault, now: input.now, receiptSigner: input.receiptSigner,
    subject: agreementSubject(repo, agreement), draft: { runId: agreement.runId, agreementId: agreement.agreementId },
  });
}

/**
 * Pays residual `transferIndex` of a FINALIZED epoch (Phase 7). Refused unless the
 * kernel plan passes AND MitraClearing on the epoch's chain says the epoch is
 * Finalized (or Settling) with exactly this transfer at this index.
 */
export async function settleResidual(
  repo: EconomicRepository,
  rails: Rails,
  reader: ClearingReader | null,
  input: { epochId: string; transferIndex: number; reservationId: string; now: Date; receiptSigner?: ReceiptSigner },
): Promise<SettleOutcome> {
  const epoch = await repo.getEpoch(input.epochId);
  if (!epoch) return refuse(404, "EPOCH_NOT_FOUND");
  const transfer = epoch.residualTransfers[input.transferIndex];
  if (!transfer) return refuse(404, "UNKNOWN_RESIDUAL");
  const payee = await repo.getAgent(transfer.to);
  if (!payee) return refuse(404, "PAYEE_NOT_REGISTERED");
  const reservation = await repo.getReservation(input.reservationId);
  if (!reservation) return refuse(404, "RESERVATION_NOT_FOUND");
  const mandate = await repo.getMandate(reservation.mandateId);
  if (!mandate) return refuse(404, "MANDATE_NOT_FOUND");
  const vault = await repo.getVault(reservation.vaultId);
  if (!vault) return refuse(404, "VAULT_NOT_FOUND");

  const plan = planResidualSettlement({
    epoch, transferIndex: input.transferIndex, payee, reservation, mandate, vault, now: input.now,
    consumedNonces: await consumedNoncesOf(repo, vault),
  });
  if (!plan.ok) return refuse(409, plan.reason);

  // The chain must agree before anything is claimed or spent.
  if (!reader) return refuse(503, "CLEARING_READER_NOT_CONFIGURED");
  let onChain: Awaited<ReturnType<ClearingReader["residual"]>>;
  try {
    onChain = await reader.residual({ chain: plan.value.chain, epochId: epoch.epochId, transferIndex: input.transferIndex });
  } catch (e) {
    return refuse(503, message(e).startsWith("CLEARING_READER_NOT_CONFIGURED") ? "CLEARING_READER_NOT_CONFIGURED" : "CLEARING_READ_FAILED");
  }
  if (onChain && onChain.status !== "Finalized" && onChain.status !== "Settling") {
    return refuse(409, "RESIDUAL_NOT_FINALIZED_ON_CHAIN");
  }
  const rail = rails[plan.value.chain];
  const matches = !!onChain && !!rail
    && onChain.from.toLowerCase() === rail.payer.toLowerCase()
    && onChain.to.toLowerCase() === plan.value.to.toLowerCase()
    && onChain.amountAtomic === toAtomic(plan.value.amount.amount, 6);
  if (rail && !matches) return refuse(409, "RESIDUAL_MISMATCH_ON_CHAIN");

  return execute(repo, rails, {
    plan: plan.value, reservation, vault, now: input.now, receiptSigner: input.receiptSigner,
    subject: residualSubject(repo, epoch, input.transferIndex), draft: { runId: `run_${epoch.epochId}`, epochId: epoch.epochId },
  });
}

async function consumedNoncesOf(repo: EconomicRepository, vault: Vault): Promise<number[]> {
  return (await repo.listReservations(vault.vaultId))
    .filter((r) => r.status === "COMMITTED" || r.status === "SETTLING" || r.status === "SETTLED")
    .map((r) => r.nonce);
}

/** Steps 1 (rail checks) to 5, shared by every kind of settlement. */
async function execute(
  repo: EconomicRepository,
  rails: Rails,
  input: {
    plan: { settlementId: string; chain: Settlement["chain"]; amount: { asset: Settlement["asset"]; amount: number }; to: string };
    reservation: Reservation;
    vault: Vault;
    now: Date;
    receiptSigner?: ReceiptSigner;
    subject: Subject;
    draft: Pick<Settlement, "runId" | "agreementId" | "epochId">;
  },
): Promise<SettleOutcome> {
  const { settlementId, chain, amount, to } = input.plan;
  const { reservation, vault, subject } = input;

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
    ...input.draft,
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
    await event(repo, input.now, subject, settlement, "FAILURE", "Settlement outcome unknown",
      "The transport failed after the nonce was consumed. The transfer may or may not have been broadcast; reconcile against the chain before any retry.");
    return refuse(502, "SETTLEMENT_OUTCOME_UNKNOWN", settlement);
  }
  settlement = { ...settlement, status: "SUBMITTED", txHash, evidenceLevel: "LOCAL_PASS" };
  await repo.updateSettlement(settlement);

  // ── 5. verify ──────────────────────────────────────────────────────────────
  return finish(repo, rail, subject, settlement, input.now, input.receiptSigner);
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
  let subject: Subject;
  if (settlement.agreementId) {
    const agreement = await repo.getAgreement(settlement.agreementId);
    if (!agreement) return refuse(404, "AGREEMENT_NOT_FOUND");
    subject = agreementSubject(repo, agreement);
  } else if (settlement.epochId) {
    const epoch = await repo.getEpoch(settlement.epochId);
    if (!epoch) return refuse(404, "EPOCH_NOT_FOUND");
    const index = epoch.residualTransfers.findIndex((_, i) => residualSettlementIdFor(epoch.epochId, i) === settlement.settlementId);
    if (index < 0) return refuse(409, "UNKNOWN_RESIDUAL");
    subject = residualSubject(repo, epoch, index);
  } else {
    return refuse(409, "SETTLEMENT_PAYS_NO_AGREEMENT");
  }
  if (settlement.status === "CONFIRMED") return { ok: true, httpStatus: 200, settlement, ...subject.current };
  if (settlement.status !== "SUBMITTED" || !settlement.txHash) return refuse(409, `SETTLEMENT_${settlement.status}`, settlement);
  const rail = rails[settlement.chain];
  if (!rail) return refuse(503, "SETTLEMENT_RAIL_NOT_CONFIGURED");
  return finish(repo, rail, subject, settlement, input.now, input.receiptSigner);
}

async function finish(
  repo: EconomicRepository,
  rail: SettlementRail,
  subject: Subject,
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
    await event(repo, now, subject, submitted, "WARNING", "Settlement submitted, not yet confirmed", subject.pendingDescription);
    return { ok: true, httpStatus: 202, settlement: submitted, ...subject.current };
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
  const discharged = await subject.onConfirmed(settlement);
  await event(repo, now, subject, settlement, "SUCCESS", subject.settledTitle, subject.settledDescription);
  return { ok: true, httpStatus: 200, settlement, ...discharged };
}

async function event(
  repo: EconomicRepository,
  at: Date,
  subject: Subject,
  settlement: Settlement,
  status: "SUCCESS" | "WARNING" | "FAILURE",
  title: string,
  description: string,
) {
  await repo.appendEvent({
    runId: subject.runId,
    at: at.toISOString(),
    kind: "SETTLEMENT",
    title,
    description,
    status,
    objectRef: settlement.settlementId,
    metadata: {
      ...subject.metadata,
      chain: settlement.chain,
      amount: settlement.amount,
      asset: settlement.asset,
      settlementStatus: settlement.status,
      evidenceLevel: settlement.evidenceLevel,
      ...(settlement.txHash ? { txHash: settlement.txHash } : {}),
    },
  });
}
