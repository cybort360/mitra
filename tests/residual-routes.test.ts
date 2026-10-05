/**
 * Phase 7 — clearing residuals through the real routes. Seams B (reservations)
 * and C (settlements). Decision: shared context ctx_9b9e7a8c3172e71b.
 *
 * Same harness as tests/settlement-caller.test.ts: the in-memory store, the REAL
 * BaseSettlementAdapter, and a recording transport in place of the RPC. A
 * finalized epoch owes 0.01 to agent_data_03 and 0.02 to agent_eval_02, both
 * from agent_buyer_07.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BaseSettlementAdapter, settlementCommitment, type BaseTransport } from "@/lib/adapters/base";
import { toAtomic } from "@/lib/evm/eip712";
import { __setRailsForTests, type Rails } from "@/lib/settlement/rails";
import { __setClearingReaderForTests, type ClearingReader, type OnChainResidual } from "@/lib/settlement/clearing-reader";
import { residualSettlementIdFor } from "@/lib/kernel/settlement";
import { POST as settlementsPOST } from "@/app/api/v1/settlements/route";
import type { ClearingEpoch, Mandate } from "@/lib/domain/types";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { RESIDUAL_CAPABILITY, residualPaymentDigest, residualRef } from "@/lib/kernel/settlement";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";

const NOW = "2026-10-05T12:00:00.000Z";
const VAULT_ID = "vault_base_ops";
const VAULT_ADDRESS = "0x3333333333333333333333333333333333333333";
const DATA_WALLET = "0x1111111111111111111111111111111111111111";
const EVAL_WALLET = "0x2222222222222222222222222222222222222222";
const testVaults = seedVaults.map((v) => (v.vaultId === VAULT_ID ? { ...v, address: VAULT_ADDRESS } : v));

class TestRepo extends InMemoryRepository {
  readonly extraMandates = new Map<string, Mandate>();
  async getMandate(id: string) { return this.extraMandates.get(id) ?? super.getMandate(id); }
}

const mandate: Mandate = {
  mandateId: "m_residual_base", name: "pay clearing residuals on base", version: 1, principal: "Mitra Labs",
  agentId: "agent_buyer_07", vaultId: VAULT_ID, asset: "USDC", budget: 500, maxTransaction: 100,
  allowedCounterparties: ["agent_data_03", "agent_eval_02"], allowedCapabilities: [RESIDUAL_CAPABILITY],
  prohibitedCapabilities: [], approvedChains: ["base"], policyVersion: "test", expiresAt: "2026-12-31T00:00:00Z",
  nonce: 1, status: "ACTIVE", confidentialPolicy: false,
};

const epoch = (over: Partial<ClearingEpoch> = {}): ClearingEpoch => ({
  epochId: "epoch_live_1", status: "FINALIZED", asset: "USDC", settlementDomain: "base",
  obligationIds: ["ob_1", "ob_2"], excludedObligations: [], grossVolume: 0.05, netResidual: 0.03,
  netPositions: [{ party: "agent_buyer_07", amount: -0.03 }, { party: "agent_data_03", amount: 0.01 }, { party: "agent_eval_02", amount: 0.02 }],
  residualTransfers: [
    { from: "agent_buyer_07", to: "agent_data_03", amount: 0.01 },
    { from: "agent_buyer_07", to: "agent_eval_02", amount: 0.02 },
  ],
  computationVersion: "netting-v1", openedAt: NOW, finalizedAt: NOW, ...over,
});

let repo: TestRepo;
const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://localhost/api/v1/x", { method: "POST", body: JSON.stringify(body) }));

/** A reservation request for residual `index`, with that transfer's terms. */
const reserveResidual = async (index: number, over: Record<string, unknown> = {}) => {
  const t = epoch().residualTransfers[index];
  const res = await post(reservationsPOST, {
    mandateId: mandate.mandateId, vaultId: VAULT_ID, amount: t.amount, asset: "USDC", chain: "base",
    counterparty: t.to, capability: RESIDUAL_CAPABILITY, intentId: "intent_clearing", runId: "run_clearing",
    residual: { epochId: "epoch_live_1", transferIndex: index }, now: NOW, ...over,
  });
  return { res, body: await res.json() };
};

beforeEach(async () => {
  repo = new TestRepo(new CapitalLedger(testVaults, []));
  repo.extraMandates.set(mandate.mandateId, mandate);
  await repo.saveEpoch(epoch());
  for (const [agentId, address] of [["agent_data_03", DATA_WALLET], ["agent_eval_02", EVAL_WALLET]] as const) {
    const agent = (await repo.getAgent(agentId))!;
    repo.__putAgentForTests({ ...agent, wallets: [...agent.wallets, { chain: "base", address }] });
  }
  globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });
});

afterEach(() => {
  globalThis.__mitraStore = undefined;
  __setRailsForTests(null);
  __setClearingReaderForTests(null);
});

/** A BaseTransport that records instead of sending, and reports what it recorded. Test-only. */
function recorder() {
  const sends: Parameters<BaseTransport["send"]>[0][] = [];
  const transport: BaseTransport = {
    async send(input) {
      sends.push(input);
      return { txHash: `0x${sends.length.toString(16).padStart(64, "0")}` as `0x${string}` };
    },
    async verify() { return { confirmed: true }; },
    async observe(txHash) {
      const i = Number.parseInt(txHash.slice(2), 16) - 1;
      const sent = sends[i];
      return sent ? { txHash, block: 100 + i, carriedCommitment: sent.data, from: VAULT_ADDRESS, to: sent.to,
        amountAtomic: BigInt(sent.amountAtomic), asset: sent.asset!.address } : null;
    },
  };
  return { transport, sends };
}

const baseRail = (transport: BaseTransport): Rails => ({
  base: {
    chain: "base", adapter: new BaseSettlementAdapter({ chainId: 84532, transport }), payer: VAULT_ADDRESS,
    commitment: (i) => settlementCommitment({ ...i, amount: i.amount.amount, asset: i.amount.asset, chainId: 84532 }),
    confirmedEvidence: "LOCAL_PASS", network: "base-sepolia",
  },
});

/** What MitraClearing says about each residual, as the chain would. Test-only. */
function chainSays(status: OnChainResidual["status"], over: Partial<Record<number, Partial<OnChainResidual>>> = {}) {
  const asked: Array<{ epochId: string; transferIndex: number }> = [];
  const wallets = [DATA_WALLET, EVAL_WALLET];
  const reader: ClearingReader = {
    async residual({ epochId, transferIndex }) {
      asked.push({ epochId, transferIndex });
      const t = epoch().residualTransfers[transferIndex];
      if (!t) return null;
      return { status, from: VAULT_ADDRESS, to: wallets[transferIndex], amountAtomic: toAtomic(t.amount, 6), ...over[transferIndex] };
    },
  };
  __setClearingReaderForTests(reader);
  return asked;
}

const settleResidual = async (transferIndex: number, reservationId: string) => {
  const res = await post(settlementsPOST, { op: "settleResidual", epochId: "epoch_live_1", transferIndex, reservationId, now: NOW });
  return { res, body: await res.json() };
};

describe("reserving capital for a clearing residual (seam B)", () => {
  it("binds the reservation to that exact residual", async () => {
    const { res, body } = await reserveResidual(1);
    expect(res.status, JSON.stringify(body)).toBe(201);
    const r = body.data;
    expect(r.residualRef).toBe(residualRef("epoch_live_1", 1));
    expect(r.actionDigest).toBe(residualPaymentDigest(epoch(), 1, r, "base"));
    expect((await repo.getReservation(r.reservationId))?.residualRef).toBe("epoch_live_1#1");
  });

  const refused: Array<[string, () => Promise<void>, Record<string, unknown>, number, string]> = [
    ["the payee is not the transfer's creditor", async () => {}, { counterparty: "agent_data_03" }, 409, "RESERVATION_TERMS_DO_NOT_MATCH_RESIDUAL"],
    ["the amount is not the transfer's", async () => {}, { amount: 0.03 }, 409, "RESERVATION_TERMS_DO_NOT_MATCH_RESIDUAL"],
    ["the capability is not clearing_residual", async () => {}, { capability: "payment" }, 409, "RESERVATION_TERMS_DO_NOT_MATCH_RESIDUAL"],
    ["the epoch is still open to challenge", async () => { await repo.saveEpoch(epoch({ status: "CHALLENGE" })); }, {}, 409, "EPOCH_NOT_FINALIZED"],
    ["the transfer does not exist", async () => {}, { residual: { epochId: "epoch_live_1", transferIndex: 5 } }, 404, "UNKNOWN_RESIDUAL"],
    ["it also names an agreement", async () => {}, { agreementId: "ag_x" }, 400, "RESERVATION_PAYS_ONE_THING"],
    ["the mandate is not the debtor's", async () => {
      repo.extraMandates.set(mandate.mandateId, { ...mandate, agentId: "agent_data_03" });
    }, {}, 409, "RESERVATION_TERMS_DO_NOT_MATCH_RESIDUAL"],
  ];
  for (const [why, arrange, over, status, error] of refused) {
    it(`refuses, reserving nothing, when ${why}`, async () => {
      await arrange();
      const before = (await repo.getVault(VAULT_ID))!.reserved;
      const { res, body } = await reserveResidual(1, over);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(body.error).toBe(error);
      expect((await repo.getVault(VAULT_ID))!.reserved).toBe(before);
    });
  }
});

describe("settling a clearing residual (seam C)", () => {
  it("pays each residual once, through the guard, to the creditor's registered wallet, after the chain confirms the epoch finalized", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    const asked = chainSays("Finalized");

    const r1 = (await reserveResidual(1)).body.data;
    const { res, body } = await settleResidual(1, r1.reservationId);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data.settlement).toMatchObject({
      settlementId: residualSettlementIdFor("epoch_live_1", 1), epochId: "epoch_live_1", status: "CONFIRMED", to: EVAL_WALLET, amount: 0.02,
    });
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0].to).toBe(EVAL_WALLET);
    expect(rec.sends[0].amountAtomic).toBe(toAtomic(0.02, 6).toString());
    expect(asked).toEqual([{ epochId: "epoch_live_1", transferIndex: 1 }]);
    expect((await repo.getEpoch("epoch_live_1"))!.status).toBe("SETTLING");

    const again = await settleResidual(1, r1.reservationId);
    expect(again.res.status).toBe(409);
    expect(rec.sends, "a residual is paid once").toHaveLength(1);

    const r0 = (await reserveResidual(0)).body.data;
    expect((await settleResidual(0, r0.reservationId)).res.status).toBe(200);
    expect(rec.sends[1].to).toBe(DATA_WALLET);
    expect((await repo.getEpoch("epoch_live_1"))!.status).toBe("SETTLED");
  });

  const refusals: Array<[string, () => unknown, number, string]> = [
    ["the chain has not finalized the epoch", () => chainSays("Proposed"), 409, "RESIDUAL_NOT_FINALIZED_ON_CHAIN"],
    ["a challenge is open on chain", () => chainSays("Challenged"), 409, "RESIDUAL_NOT_FINALIZED_ON_CHAIN"],
    ["the chain's transfer pays someone else", () => chainSays("Finalized", { 1: { to: DATA_WALLET } }), 409, "RESIDUAL_MISMATCH_ON_CHAIN"],
    ["the chain's transfer is another amount", () => chainSays("Finalized", { 1: { amountAtomic: 1n } }), 409, "RESIDUAL_MISMATCH_ON_CHAIN"],
    ["the chain's transfer is from another payer", () => chainSays("Finalized", { 1: { from: DATA_WALLET } }), 409, "RESIDUAL_MISMATCH_ON_CHAIN"],
    ["the chain has no such transfer", () => __setClearingReaderForTests({ residual: async () => null }), 409, "RESIDUAL_MISMATCH_ON_CHAIN"],
    ["no clearing contract can be read", () => __setClearingReaderForTests(null), 503, "CLEARING_READER_NOT_CONFIGURED"],
  ];
  for (const [why, arrange, status, error] of refusals) {
    it(`refuses, sending nothing and spending no nonce, when ${why}`, async () => {
      const rec = recorder();
      __setRailsForTests(baseRail(rec.transport));
      const r = (await reserveResidual(1)).body.data;
      arrange();
      const { res, body } = await settleResidual(1, r.reservationId);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(body.error).toBe(error);
      expect(rec.sends).toHaveLength(0);
      expect((await repo.getReservation(r.reservationId))!.status).toBe("RESERVED");
    });
  }

  it("refuses a creditor that is not a registered agent", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    chainSays("Finalized");
    await repo.saveEpoch(epoch({ residualTransfers: [epoch().residualTransfers[0], { from: "agent_buyer_07", to: "nobody_registered", amount: 0.02 }] }));
    // The mandate allows the counterparty, so it is the registry, not policy, that refuses.
    repo.extraMandates.set(mandate.mandateId, { ...mandate, allowedCounterparties: [...mandate.allowedCounterparties, "nobody_registered"] });
    const reserved = await reserveResidual(1, { counterparty: "nobody_registered" });
    expect(reserved.res.status, JSON.stringify(reserved.body)).toBe(201);
    const { res, body } = await settleResidual(1, reserved.body.data.reservationId);
    expect(res.status).toBe(404);
    expect(body.error).toBe("PAYEE_NOT_REGISTERED");
    expect(rec.sends).toHaveLength(0);
  });
});
