import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Agreement, Mandate, Settlement } from "@/lib/domain/types";
import { PostgresRepository } from "@/lib/store/postgres";
import { MIGRATIONS } from "@/lib/store/schema";
import { createPool } from "@/lib/store/db";
import { BaseSettlementAdapter, settlementCommitment, type BaseTransport } from "@/lib/adapters/base";
import { agreementPaymentDigest, AGREEMENT_PAYMENT_CAPABILITY, settlementIdFor } from "@/lib/kernel/settlement";
import { settleAgreement } from "@/lib/settlement/settle-agreement";
import type { Rails } from "@/lib/settlement/rails";
import { receiptHash, settlementReceipt, verifyReceiptChain } from "@/lib/kernel/receipts";

/**
 * Sprint item 1 against a real PostgreSQL instance.
 *
 * The at-most-once property of agreement settlement rests on the settlements
 * primary key (`claimSettlement`), and the agreement write path did not exist on
 * this backend before item 1. Neither can be demonstrated by the in-memory store,
 * whose "concurrency" is a single event loop.
 *
 * Skipped, loudly, when DATABASE_URL is unset.
 */
const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
if (!url) {
  // eslint-disable-next-line no-console
  console.warn("[item1] DATABASE_URL unset — skipping settlement persistence tests.");
}

const VAULT_ADDRESS = "0x3333333333333333333333333333333333333333";
const PAYEE = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-10-01T12:00:00.000Z");

const mandate: Mandate = {
  mandateId: "m_pay", name: "pay", version: 1, principal: "P", agentId: "client_1", vaultId: "v_base",
  asset: "USDC", budget: 500, maxTransaction: 100, allowedCounterparties: ["provider_1"],
  allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY], prohibitedCapabilities: [], approvedChains: ["base"],
  policyVersion: "t", expiresAt: "2026-12-31T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
};

class TestPgRepo extends PostgresRepository {
  async getMandate(id: string) { return id === mandate.mandateId ? mandate : super.getMandate(id); }
}

const agreement = (id: string): Agreement => ({
  agreementId: id, spaceIds: [], runId: `run_${id}`, intentId: `intent_${id}`, client: "client_1",
  provider: "provider_1", externalJobRefs: [], price: { asset: "USDC", amount: 15 }, deadline: "2026-12-01T00:00:00Z",
  acceptanceCriteria: [], failurePolicy: "refund", status: "ACCEPTED", payTo: { chain: "base", address: PAYEE }, version: 1,
});

const pending = (id: string, over: Partial<Settlement> = {}): Settlement => ({
  settlementId: id, obligationIds: [], chain: "base", asset: "USDC", amount: 15, from: VAULT_ADDRESS, to: PAYEE,
  status: "PENDING", submittedAt: NOW.toISOString(), evidenceLevel: "DESIGN_ONLY", ...over,
});

describeDb("settlement persistence on postgres (sprint item 1)", () => {
  let pool: Pool;
  let repo: TestPgRepo;

  beforeAll(async () => {
    pool = createPool(url);
    for (const sql of MIGRATIONS) await pool.query(sql);
    repo = new TestPgRepo(pool);
  });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE mitra.reservations, mitra.consumed_nonces, mitra.settlements,
      mitra.agreement_spaces, mitra.agreements, mitra.event_log, mitra.mandates, mitra.vaults, mitra.receipts, mitra.spaces CASCADE`);
    await pool.query(
      `INSERT INTO mitra.vaults
         (vault_id, name, principal, controller_ref, chain, asset, address,
          total, available, reserved, escrowed, encumbered, settling, frozen,
          emergency_freeze, custody_mode, version)
       VALUES ('v_base','Test','P','ctl','base','USDC',$1, 1000, 1000, 0, 0, 0, 0, 0, FALSE, 'POLICY_CONTROLLED_EXTERNAL', 1)`,
      [VAULT_ADDRESS],
    );
  });

  describe("claimSettlement", () => {
    it("claims once; a second claim over PENDING is refused", async () => {
      expect(await repo.claimSettlement(pending("set_a"))).toBe(true);
      expect(await repo.claimSettlement(pending("set_a"))).toBe(false);
    });

    it("may replace a FAILED claim, and only a FAILED one", async () => {
      await repo.claimSettlement(pending("set_b"));
      await repo.updateSettlement(pending("set_b", { status: "SUBMITTED", txHash: "0x1" }));
      expect(await repo.claimSettlement(pending("set_b")), "SUBMITTED is never replaced").toBe(false);
      await repo.updateSettlement(pending("set_b", { status: "FAILED", failureReason: "x" }));
      expect(await repo.claimSettlement(pending("set_b"))).toBe(true);
      expect((await repo.getSettlement("set_b"))!.status).toBe("PENDING");
    });

    it("refuses to update a settlement that was never claimed", async () => {
      await expect(repo.updateSettlement(pending("set_none"))).rejects.toThrow("SETTLEMENT_NOT_CLAIMED");
    });

    it("ten concurrent claims for one settlement: exactly one wins", async () => {
      const wins = await Promise.all(Array.from({ length: 10 }, () => repo.claimSettlement(pending("set_race"))));
      expect(wins.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("agreement writes (absent on this backend before item 1)", () => {
    it("saves, reads back and updates an agreement; membership lives only in the join table", async () => {
      await pool.query("INSERT INTO mitra.spaces (space_id, owner, status, document) VALUES ('sp1','o','ACTIVE','{}'::jsonb)");
      await repo.saveAgreement({ ...agreement("ag_w"), spaceIds: ["sp1"] });
      const read = await repo.getAgreement("ag_w");
      expect(read!.spaceIds).toEqual(["sp1"]);
      const { rows } = await pool.query("SELECT document FROM mitra.agreements WHERE agreement_id = 'ag_w'");
      expect(rows[0].document.spaceIds, "the document must not carry membership (F33)").toBeUndefined();

      await repo.updateAgreement({ ...read!, settledRef: "set_x", version: 2 });
      expect((await repo.getAgreement("ag_w"))!.settledRef).toBe("set_x");
    });

    it("opening the same agreement id twice is a conflict, not an overwrite", async () => {
      await repo.saveAgreement(agreement("ag_dup"));
      await expect(repo.saveAgreement({ ...agreement("ag_dup"), provider: "someone_else" })).rejects.toThrow();
      expect((await repo.getAgreement("ag_dup"))!.provider).toBe("provider_1");
    });

    it("updating an agreement that does not exist throws rather than reporting success", async () => {
      await expect(repo.updateAgreement(agreement("ag_ghost"))).rejects.toThrow("AGREEMENT_NOT_FOUND");
    });
  });

  describe("receipts (sprint item 2)", () => {
    const draft = (id: string) => settlementReceipt(
      { ...pending(id), runId: "run_r", status: "CONFIRMED", txHash: `0x${"ef".repeat(32)}` },
      "base-sepolia", NOW,
    );

    it("ten concurrent appends to one run form one unbroken chain, not a fork", async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => repo.appendReceipt(draft(`set_${i}`))));
      const chain = await repo.listReceipts("run_r");
      expect(chain).toHaveLength(10);
      expect(verifyReceiptChain(chain)).toEqual({ ok: true });
    });

    it("concurrent appends of the same receipt id store it once", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => repo.appendReceipt(draft("set_same"))));
      // Compared by hash: the winner returns its own object, the others the stored
      // JSONB document, whose key order Postgres normalises.
      expect(new Set(results.map((r) => receiptHash(r))).size).toBe(1);
      expect(await repo.listReceipts("run_r")).toHaveLength(1);
    });
  });

  it("five concurrent completions of one settlement move the capital once (backlog #2)", async () => {
    const r = await repo.reserveCapital({
      vaultId: "v_base", amount: 15, reservationId: "res_cap", runId: "r", intentId: "i", mandateId: "m_pay",
      mandateVersion: 1, asset: "USDC", chain: "base", actionDigest: "sha256:x", expiresAt: "2026-10-01T13:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    expect(await repo.beginSettlement("res_cap")).not.toBeNull();
    expect(await repo.beginSettlement("res_cap"), "begins once").toBeNull();
    const wins = await Promise.all(Array.from({ length: 5 }, () => repo.completeSettlement("res_cap", 12)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const v = (await repo.getVault("v_base"))!;
    expect([v.total, v.available, v.reserved, v.settling]).toEqual([988, 988, 0, 0]);
  });

  it("a reservation's agreementId round-trips", async () => {
    const r = await repo.reserveCapital({
      vaultId: "v_base", amount: 15, reservationId: "res_rt", runId: "r", intentId: "i", mandateId: "m_pay",
      mandateVersion: 1, asset: "USDC", chain: "base", actionDigest: "sha256:x",
      expiresAt: "2026-10-01T13:00:00.000Z", agreementId: "ag_rt",
    });
    expect(r.ok).toBe(true);
    expect((await repo.getReservation("res_rt"))!.agreementId).toBe("ag_rt");
  });

  it("two concurrent settles of one agreement, each with its own valid reservation, pay once", async () => {
    const sends: unknown[] = [];
    const transport: BaseTransport = {
      async send(i) { sends.push(i); return { txHash: `0x${"ab".repeat(32)}` }; },
      async verify() { return { confirmed: true }; },
    };
    const rails: Rails = {
      base: {
        chain: "base", payer: VAULT_ADDRESS, confirmedEvidence: "LOCAL_PASS", network: "base-sepolia",
        adapter: new BaseSettlementAdapter({ chainId: 84532, transport }),
        commitment: (i) => settlementCommitment({ ...i, amount: i.amount.amount, asset: i.amount.asset, chainId: 84532 }),
      },
    };
    const a = agreement("ag_pg_race");
    await repo.saveAgreement(a);
    const reserve = (id: string) => repo.reserveCapital({
      vaultId: "v_base", amount: 15, reservationId: id, runId: a.runId, intentId: a.intentId, mandateId: "m_pay",
      mandateVersion: 1, asset: "USDC", chain: "base", agreementId: a.agreementId,
      actionDigest: agreementPaymentDigest(a, { vaultId: "v_base", mandateId: "m_pay", mandateVersion: 1 }, "base"),
      expiresAt: "2026-10-01T13:00:00.000Z",
    });
    expect((await reserve("res_p1")).ok).toBe(true);
    expect((await reserve("res_p2")).ok).toBe(true);

    const [x, y] = await Promise.all([
      settleAgreement(repo, rails, { agreementId: a.agreementId, reservationId: "res_p1", now: NOW }),
      settleAgreement(repo, rails, { agreementId: a.agreementId, reservationId: "res_p2", now: NOW }),
    ]);
    expect([x.httpStatus, y.httpStatus].sort()).toEqual([200, 409]);
    expect(sends).toHaveLength(1);
    expect((await repo.getAgreement(a.agreementId))!.settledRef).toBe(settlementIdFor(a.agreementId));
    expect((await repo.getSettlement(settlementIdFor(a.agreementId)))!.status).toBe("CONFIRMED");
  });
});
