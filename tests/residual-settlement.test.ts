/**
 * Phase 7 — clearing residuals settle through the execution guard. Seam A: the
 * kernel plan. Decision: shared context ctx_9b9e7a8c3172e71b.
 *
 * A residual transfer of a FINALIZED epoch is paid from the FROM party's vault,
 * under its mandate, by a reservation bound to that exact transfer, to the TO
 * party's registered wallet — never to an address the caller names.
 */
import { describe, expect, it } from "vitest";
import type { Agent, ClearingEpoch, Mandate, Reservation, Vault } from "@/lib/domain/types";
import { RESIDUAL_CAPABILITY, planResidualSettlement, residualPaymentDigest, residualRef, residualSettlementIdFor } from "@/lib/kernel/settlement";

const NOW = new Date("2026-10-05T12:00:00Z");
const PAYEE = "0x00000000000000000000000000000000000000d3";

const epoch: ClearingEpoch = {
  epochId: "epoch_1", status: "FINALIZED", asset: "USDC", settlementDomain: "base",
  obligationIds: ["ob_1", "ob_2"], excludedObligations: [], grossVolume: 0.05, netResidual: 0.03,
  netPositions: [{ party: "agent_buyer_07", amount: -0.03 }, { party: "agent_data_03", amount: 0.01 }, { party: "agent_eval_02", amount: 0.02 }],
  residualTransfers: [
    { from: "agent_buyer_07", to: "agent_data_03", amount: 0.01 },
    { from: "agent_buyer_07", to: "agent_eval_02", amount: 0.02 },
  ],
  computationVersion: "netting-v1", openedAt: "2026-10-05T11:00:00Z", finalizedAt: "2026-10-05T11:30:00Z",
};

const vault = { vaultId: "vault_base_ops", chain: "base", address: "0x00000000000000000000000000000000000000a1", emergencyFreeze: false } as Vault;

const mandate: Mandate = {
  mandateId: "m_residual", name: "pay clearing residuals", version: 1, principal: "P", agentId: "agent_buyer_07",
  vaultId: "vault_base_ops", asset: "USDC", budget: 10, maxTransaction: 1, allowedCounterparties: ["agent_data_03", "agent_eval_02"],
  allowedCapabilities: [RESIDUAL_CAPABILITY], prohibitedCapabilities: [], approvedChains: ["base"], policyVersion: "t",
  expiresAt: "2030-01-01T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
};

const payee = { agentId: "agent_eval_02", wallets: [{ chain: "solana", address: "So1ana" }, { chain: "base", address: PAYEE }] } as Agent;

/** A reservation made for transfer `index` of `epoch`. */
const reservationFor = (index: number, over: Partial<Reservation> = {}): Reservation => {
  const base = {
    reservationId: "res_1", runId: "run_clearing", vaultId: "vault_base_ops", intentId: "i", mandateId: "m_residual", mandateVersion: 1,
    asset: "USDC" as const, amount: epoch.residualTransfers[index].amount, chain: "base" as const,
    residualRef: residualRef(epoch.epochId, index), expiresAt: "2026-10-05T13:00:00Z", nonce: 7, status: "RESERVED" as const, version: 1,
  };
  return { ...base, actionDigest: residualPaymentDigest(epoch, index, base, "base"), ...over } as Reservation;
};

const plan = (over: Partial<Parameters<typeof planResidualSettlement>[0]> = {}) =>
  planResidualSettlement({ epoch, transferIndex: 1, payee, reservation: reservationFor(1), mandate, vault, now: NOW, consumedNonces: [], ...over });

describe("planResidualSettlement", () => {
  it("pays the residual from the FROM party's vault to the TO party's registered wallet on the epoch's chain", () => {
    expect(plan()).toEqual({
      ok: true,
      value: { settlementId: residualSettlementIdFor("epoch_1", 1), chain: "base", amount: { asset: "USDC", amount: 0.02 }, to: PAYEE },
    });
    expect(residualSettlementIdFor("epoch_1", 1)).not.toBe(residualSettlementIdFor("epoch_1", 0));
  });

  const refusals: Array<[string, Partial<Parameters<typeof planResidualSettlement>[0]>, string]> = [
    ["the epoch is not finalized", { epoch: { ...epoch, status: "CHALLENGE" } }, "EPOCH_NOT_FINALIZED"],
    ["the transfer does not exist", { transferIndex: 2 }, "UNKNOWN_RESIDUAL"],
    ["the payee record is not the creditor", { payee: { ...payee, agentId: "agent_data_03" } }, "PAYEE_IS_NOT_THE_CREDITOR"],
    ["the payee has no wallet on the epoch's chain", { payee: { ...payee, wallets: [{ chain: "solana", address: "So1ana" }] } }, "PAYEE_HAS_NO_WALLET_ON_CHAIN"],
    ["the reservation was made for another residual", { reservation: reservationFor(0, { amount: 0.02 }) }, "RESERVATION_NOT_FOR_RESIDUAL"],
    ["the mandate is not the reservation's", { mandate: { ...mandate, mandateId: "m_other" } }, "MANDATE_MISMATCH"],
    ["the mandate is not held by the debtor", { mandate: { ...mandate, agentId: "agent_data_03" } }, "MANDATE_NOT_HELD_BY_DEBTOR"],
    ["the vault is not the mandate's", { vault: { ...vault, vaultId: "vault_other" } }, "VAULT_MISMATCH"],
    ["the vault is on another chain", { vault: { ...vault, chain: "tempo" } }, "VAULT_CHAIN_MISMATCH"],
    ["the mandate is revoked", { mandate: { ...mandate, status: "REVOKED" } }, "MANDATE_NOT_ACTIVE"],
    ["the mandate has expired", { mandate: { ...mandate, expiresAt: "2026-10-05T11:00:00Z" } }, "MANDATE_EXPIRED"],
    ["the vault is frozen", { vault: { ...vault, emergencyFreeze: true } }, "VAULT_FROZEN"],
    ["the reservation's nonce was spent", { consumedNonces: [7] }, "NONCE_ALREADY_CONSUMED"],
    ["the reservation carries another amount's digest", { reservation: reservationFor(1, { actionDigest: "sha256:other" }) }, "ACTION_DIGEST_MISMATCH"],
  ];
  it("refuses a digest made for the identical residual of another epoch, whatever the reservation's field says", () => {
    // Same payer, payee, amount and index: only the epoch differs, so only the
    // digest's residualRef can tell them apart.
    const other = { ...epoch, epochId: "epoch_2" };
    const forOther = reservationFor(1);
    forOther.actionDigest = residualPaymentDigest(other, 1, forOther, "base");
    expect(plan({ reservation: forOther })).toEqual({ ok: false, reason: "ACTION_DIGEST_MISMATCH" });
  });

  for (const [why, over, reason] of refusals) {
    it(`refuses when ${why}: ${reason}`, () => expect(plan(over)).toEqual({ ok: false, reason }));
  }
});
