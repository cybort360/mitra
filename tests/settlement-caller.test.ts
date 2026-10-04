/**
 * Sprint item 1: an ACCEPTED agreement reaches a SettlementAdapter.
 *
 * Drives the real routes (`/agreements`, `/reservations`, `/settlements`) against an
 * in-memory store, with the REAL `BaseSettlementAdapter` — its target checks and
 * EIP-712 commitment re-derivation — and a recording `BaseTransport` in place of
 * the RPC. The transport is the only stub, it lives here and not in production
 * code, and the rail it builds reports `LOCAL_PASS`, never `TESTNET_PASS`.
 *
 * The property under test is the AGENTS.md mechanism: acceptance makes the price
 * owed, and is still not permission to move value. Every refusal below is checked
 * to have sent NOTHING, which is the half of the property a happy-path test cannot
 * see.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { RpcSignatureVerifier, isErc6492Signature } from "@/lib/evm/erc1271";
import { SETTLEMENT_TYPES, settlementDigest, settlingDomain, verifyAuthorisation } from "@/lib/evm/eip712";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agreement, Mandate, Reservation, Space } from "@/lib/domain/types";
import { CapitalLedger } from "@/lib/store/ledger";
import { reconcileVault, settleCapital } from "@/lib/kernel/vault";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { BASE_ASSETS, BaseSettlementAdapter, settlementCommitment, type BaseTransport } from "@/lib/adapters/base";
import { toAtomic } from "@/lib/evm/eip712";
import { __setRailsForTests, railsFromEnv, type Rails } from "@/lib/settlement/rails";
import { commitmentFromCalldata } from "@/lib/adapters/base-transport";
import { AGREEMENT_PAYMENT_CAPABILITY, settlementIdFor } from "@/lib/kernel/settlement";
import { POST as agreementsPOST } from "@/app/api/v1/agreements/route";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";
import { GET as settlementsGET, POST as settlementsPOST } from "@/app/api/v1/settlements/route";
import { GET as evidenceGET } from "@/app/api/v1/settlements/evidence/route";
import { bundleFromJson, verifyEvidenceBundle } from "@/lib/evm/evidence";

const NOW = "2026-10-01T12:00:00.000Z";
const VAULT_ID = "vault_base_ops";
// Not the seed's address: `0x9EC1A997fF…` fails its EIP-55 checksum, and the commitment
// builder refuses it (`INVALID_ADDRESS:from`) — correctly, before anything is sent.
const VAULT_ADDRESS = "0x3333333333333333333333333333333333333333";
const testVaults = seedVaults.map((v) => (v.vaultId === VAULT_ID ? { ...v, address: VAULT_ADDRESS } : v));
const PAYEE = "0x1111111111111111111111111111111111111111";
const CLIENT = "agent_buyer_07";
const PROVIDER = "provider_alpha";
const PRICE = { asset: "USDC" as const, amount: 15 };

class TestRepo extends InMemoryRepository {
  readonly extraMandates = new Map<string, Mandate>();
  async getMandate(id: string) { return this.extraMandates.get(id) ?? super.getMandate(id); }
}

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  mandateId: "mandate_pay_base_v1", name: "pay providers on base", version: 1, principal: "Mitra Labs",
  agentId: CLIENT, vaultId: VAULT_ID, asset: "USDC", budget: 500, maxTransaction: 100,
  allowedCounterparties: [PROVIDER, "provider_beta"], allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY],
  prohibitedCapabilities: [], approvedChains: ["base"], policyVersion: "test", expiresAt: "2026-12-31T00:00:00Z",
  nonce: 1, status: "ACTIVE", confidentialPolicy: false, ...over,
});

const space: Space = {
  spaceId: "space_settle_base", owner: CLIENT,
  governance: { mode: "ADMIN", admins: [CLIENT], governors: [CLIENT], threshold: 1 },
  rules: { source: "mitra", digest: "test" }, status: "ACTIVE",
  participants: [CLIENT, PROVIDER], allowedCapabilities: ["research", AGREEMENT_PAYMENT_CAPABILITY],
  settlementChains: ["base"], budget: { asset: "USDC", amount: 1000 }, committed: { asset: "USDC", amount: 0 },
  version: 1, createdAt: NOW,
} as Space;

const accepted = (id: string, over: Partial<Agreement> = {}): Agreement => ({
  agreementId: id, spaceIds: [space.spaceId], runId: `run_${id}`, intentId: `intent_${id}`,
  client: CLIENT, provider: PROVIDER, externalJobRefs: [], price: PRICE, deadline: "2026-12-01T00:00:00Z",
  acceptanceCriteria: ["done"], failurePolicy: "refund", status: "ACCEPTED", escrowReleased: true,
  payTo: { chain: "base", address: PAYEE }, version: 5, ...over,
});

/** A BaseTransport that records instead of sending. Test-only. */
function recorder(opts: { confirm?: boolean; throwOnSend?: Error } = {}) {
  const sends: Parameters<BaseTransport["send"]>[0][] = [];
  let confirm = opts.confirm ?? true;
  const transport: BaseTransport = {
    async send(input) {
      sends.push(input);
      if (opts.throwOnSend) throw opts.throwOnSend;
      return { txHash: `0x${sends.length.toString(16).padStart(64, "0")}` as `0x${string}` };
    },
    async verify() { return { confirmed: confirm }; },
    // Reports back exactly what was recorded, as a faithful chain would. Test-only.
    async observe(txHash) {
      const i = Number.parseInt(txHash.slice(2), 16) - 1;
      const sent = sends[i];
      if (!confirm || !sent) return null;
      return {
        txHash, block: 100 + i, carriedCommitment: sent.data, from: VAULT_ADDRESS,
        to: sent.to, amountAtomic: BigInt(sent.amountAtomic), asset: sent.asset!.address,
      };
    },
  };
  return { transport, sends, setConfirm: (v: boolean) => { confirm = v; } };
}

function baseRail(transport: BaseTransport, payer = VAULT_ADDRESS): Rails {
  return {
    base: {
      chain: "base",
      adapter: new BaseSettlementAdapter({ chainId: 84532, transport }),
      payer,
      commitment: (i) => settlementCommitment({ ...i, amount: i.amount.amount, asset: i.amount.asset, chainId: 84532 }),
      confirmedEvidence: "LOCAL_PASS", network: "base-sepolia",
    },
  };
}

let repo: TestRepo;
const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://localhost/api/v1/x", { method: "POST", body: JSON.stringify(body) }));

async function reserveFor(agreementId: string, over: Record<string, unknown> = {}) {
  const res = await post(reservationsPOST, {
    mandateId: "mandate_pay_base_v1", vaultId: VAULT_ID, amount: PRICE.amount, asset: PRICE.asset,
    chain: "base", counterparty: PROVIDER, capability: AGREEMENT_PAYMENT_CAPABILITY,
    intentId: `intent_${agreementId}`, runId: `run_${agreementId}`, agreementId, now: NOW, ...over,
  });
  return { res, body: await res.json() };
}

const settle = (agreementId: string, reservationId: string) =>
  post(settlementsPOST, { op: "settle", agreementId, reservationId, now: NOW });

beforeEach(async () => {
  repo = new TestRepo(new CapitalLedger(testVaults, []));
  repo.extraMandates.set("mandate_pay_base_v1", mandate());
  await repo.updateSpace(space);
  globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });
});

afterEach(() => {
  __setRailsForTests(null);
  globalThis.__mitraStore = undefined;
});

describe("settlement caller — the happy path", () => {
  it("pays an ACCEPTED agreement exactly once, to its payTo, for its price, carrying the commitment", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_1"));
    const { body: r } = await reserveFor("ag_1");

    const res = await settle("ag_1", r.data.reservationId);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const s = body.data.settlement;
    expect(s.status).toBe("CONFIRMED");
    expect(s.settlementId).toBe(settlementIdFor("ag_1"));
    expect(s.evidenceLevel, "a stub transport earns LOCAL_PASS, never TESTNET_PASS").toBe("LOCAL_PASS");
    expect(body.data.agreement.settledRef).toBe(s.settlementId);

    expect(rec.sends).toHaveLength(1);
    const sent = rec.sends[0];
    expect(sent.to).toBe(PAYEE);
    expect(sent.amountAtomic).toBe(toAtomic(PRICE.amount, 6).toString());
    expect(sent.data).toBe(settlementCommitment({
      settlementId: s.settlementId, from: VAULT_ADDRESS, to: PAYEE, amount: PRICE.amount, asset: "USDC", chainId: 84532,
    }));

    expect((await repo.getReservation(r.data.reservationId))!.status).toBe("SETTLED");
    expect((await repo.getAgreement("ag_1"))!.settledRef).toBe(s.settlementId);
    const listed = await (await settlementsGET(new Request("http://localhost/api/v1/settlements?agreementId=ag_1"))).json();
    expect(listed.count).toBe(1);
  });

  it("drives the whole lifecycle through the routes: open → … → accept → reserve → settle", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    const open = await post(agreementsPOST, {
      op: "open", spaceId: space.spaceId,
      draft: {
        agreementId: "ag_e2e", runId: "run_e2e", intentId: "intent_e2e", client: CLIENT, provider: PROVIDER,
        evaluator: CLIENT, price: PRICE, deadline: "2026-12-01T00:00:00Z", acceptanceCriteria: ["done"],
        payTo: { chain: "base", address: PAYEE },
      },
      proposal: { capability: "research", amount: PRICE },
    });
    expect(open.status, JSON.stringify(await open.clone().json())).toBe(201);
    for (const op of ["fund", "startExecution"]) {
      expect((await post(agreementsPOST, { op, agreementId: "ag_e2e" })).status).toBe(200);
    }
    expect((await post(agreementsPOST, { op: "submitDeliverable", agreementId: "ag_e2e", contentHash: "sha256:x", artifactRefs: ["a"] })).status).toBe(200);

    // Not yet ACCEPTED: refused, and nothing sent.
    const { body: early } = await reserveFor("ag_e2e");
    const notDue = await settle("ag_e2e", early.data.reservationId);
    expect(notDue.status).toBe(409);
    expect((await notDue.json()).error).toBe("SETTLEMENT_NOT_DUE");
    expect(rec.sends).toHaveLength(0);

    expect((await post(agreementsPOST, { op: "acceptDeliverable", agreementId: "ag_e2e" })).status).toBe(200);
    const paid = await settle("ag_e2e", early.data.reservationId);
    expect(paid.status).toBe(200);
    expect(rec.sends).toHaveLength(1);
  });
});

describe("settlement evidence through the route (sprint item 2)", () => {
  const getEvidence = (id: string) => evidenceGET(new Request(`http://localhost/api/v1/settlements/evidence?settlementId=${id}`));

  it("a confirmed settlement has a receipt, and its evidence verifies — including after a JSON round trip", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_ev"));
    const { body: r } = await reserveFor("ag_ev");
    const paid = await (await settle("ag_ev", r.data.reservationId)).json();
    const receiptId = paid.data.settlement.receiptId;
    expect(receiptId, "confirmation writes a receipt").toBe(`rcpt_${settlementIdFor("ag_ev")}`);

    const res = await getEvidence(settlementIdFor("ag_ev"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    // The stub transport's network is named base-sepolia, so the verifier grades
    // it TESTNET_PASS: this asserts the grading, not that a chain was observed.
    expect(body.data.verdict).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    expect(body.data.bundle.receiptId).toBe(receiptId);
    expect(body.data.receipt.receiptId).toBe(receiptId);
    expect(body.data.receiptChain.verdict).toEqual({ ok: true });
    // A third party re-verifies from the JSON alone.
    expect(verifyEvidenceBundle(bundleFromJson(body.data.bundle))).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
  });

  it("with MITRA_RECEIPT_SIGNER_KEY_FILE set, the settlement's receipt is signed and verifies (backlog #4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mitra-rcpt-"));
    const keyFile = join(dir, "receipt.key");
    writeFileSync(keyFile, "aa".repeat(32), { mode: 0o600 });
    const saved = process.env.MITRA_RECEIPT_SIGNER_KEY_FILE;
    process.env.MITRA_RECEIPT_SIGNER_KEY_FILE = keyFile;
    try {
      __setRailsForTests(baseRail(recorder().transport));
      await repo.saveAgreement(accepted("ag_signed"));
      const { body: r } = await reserveFor("ag_signed");
      expect((await settle("ag_signed", r.data.reservationId)).status).toBe(200);
      const body = await (await getEvidence(settlementIdFor("ag_signed"))).json();
      expect(body.data.receipt.signer).toBe(`eip191:${privateKeyToAccount(`0x${"aa".repeat(32)}`).address}`);
      expect(body.data.receiptChain.signatures).toEqual([{ receiptId: `rcpt_${settlementIdFor("ag_signed")}`, signed: true, valid: true }]);
    } finally {
      if (saved === undefined) delete process.env.MITRA_RECEIPT_SIGNER_KEY_FILE; else process.env.MITRA_RECEIPT_SIGNER_KEY_FILE = saved;
    }
  });

  it("a submitted-but-unconfirmed settlement has no evidence yet (404), and no receipt", async () => {
    const rec = recorder({ confirm: false });
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_ev2"));
    const { body: r } = await reserveFor("ag_ev2");
    const sub = await (await settle("ag_ev2", r.data.reservationId)).json();
    expect(sub.data.settlement.receiptId).toBeUndefined();
    const res = await getEvidence(settlementIdFor("ag_ev2"));
    expect(res.status).toBe(409);
    expect((await res.json()).error, "no receipt yet, so it cannot be evidenced").toBe("EVIDENCE_WITHOUT_RECEIPT");
  });

  it("if the chain later shows something else, the route reports the contradiction", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_ev3"));
    const { body: r } = await reserveFor("ag_ev3");
    await settle("ag_ev3", r.data.reservationId);
    rec.sends[0] = { ...rec.sends[0], to: "0x2222222222222222222222222222222222222222" };
    const res = await getEvidence(settlementIdFor("ag_ev3"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EVIDENCE_CONTRADICTED:to");
  });
});

describe("settlement caller — refusals send nothing", () => {
  const cases: Array<[string, (a: Agreement) => Promise<{ agreement: Agreement; reservationId: string }>, string]> = [
    ["already settled", async (a) => {
      const { body } = await reserveFor(a.agreementId);
      await repo.updateAgreement({ ...a, settledRef: "set_elsewhere" });
      return { agreement: a, reservationId: body.data.reservationId };
    }, "ALREADY_SETTLED"],
    ["no payout address", async (a) => {
      const { body } = await reserveFor(a.agreementId);
      const { payTo: _p, ...rest } = a;
      await repo.updateAgreement(rest as Agreement);
      return { agreement: a, reservationId: body.data.reservationId };
    }, "PAYOUT_ADDRESS_MISSING"],
    ["reservation made for another agreement", async (a) => {
      await repo.saveAgreement(accepted("ag_other"));
      const { body } = await reserveFor("ag_other");
      return { agreement: a, reservationId: body.data.reservationId };
    }, "RESERVATION_NOT_FOR_AGREEMENT"],
    ["reservation carrying a different counterparty than the agreement", async (a) => {
      // Built directly: the reserve route would refuse this mismatch up front.
      const { body } = await reserveFor(a.agreementId);
      const forged: Reservation = { ...body.data, actionDigest: "sha256:not-this-agreement" };
      await repo.putReservation(forged);
      return { agreement: a, reservationId: forged.reservationId };
    }, "ACTION_DIGEST_MISMATCH"],
    ["reservation relabelled to this agreement but digested for another", async (a) => {
      // Same provider, price and chain: only the agreement id bound into the digest
      // tells the two apart.
      await repo.saveAgreement(accepted("ag_other"));
      const { body } = await reserveFor("ag_other");
      const relabelled: Reservation = { ...body.data, agreementId: a.agreementId };
      await repo.putReservation(relabelled);
      return { agreement: a, reservationId: relabelled.reservationId };
    }, "ACTION_DIGEST_MISMATCH"],
    ["mandate held by an agent other than the client", async (a) => {
      const { body } = await reserveFor(a.agreementId);
      repo.extraMandates.set("mandate_pay_base_v1", mandate({ agentId: "agent_data_03" }));
      return { agreement: a, reservationId: body.data.reservationId };
    }, "MANDATE_NOT_HELD_BY_CLIENT"],
    ["mandate revoked after the reservation was made", async (a) => {
      const { body } = await reserveFor(a.agreementId);
      repo.extraMandates.set("mandate_pay_base_v1", mandate({ status: "REVOKED" }));
      return { agreement: a, reservationId: body.data.reservationId };
    }, "MANDATE_NOT_ACTIVE"],
    ["reservation expired", async (a) => {
      const { body } = await reserveFor(a.agreementId, { ttlMinutes: 1, now: "2026-10-01T11:00:00.000Z" });
      return { agreement: a, reservationId: body.data.reservationId };
    }, "RESERVATION_EXPIRED"],
    ["reservation's nonce already spent through /reservations/execute", async (a) => {
      const { body } = await reserveFor(a.agreementId);
      await repo.consumeNonce(VAULT_ID, body.data.nonce, body.data.reservationId);
      await repo.setReservationStatus(body.data.reservationId, "COMMITTED");
      return { agreement: a, reservationId: body.data.reservationId };
    }, "NONCE_ALREADY_CONSUMED"],
  ];

  it("a nonce consumed elsewhere but not yet marked COMMITTED is still refused, and nothing is sent", async () => {
    // The window /reservations/execute leaves between consumeNonce and the status
    // write: the reservation still reads RESERVED, so only the store's single-use
    // nonce stands between this settlement and a second use of the reservation.
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_win"));
    const { body: r } = await reserveFor("ag_win");
    await repo.consumeNonce(VAULT_ID, r.data.nonce, r.data.reservationId);
    const res = await settle("ag_win", r.data.reservationId);
    expect((await res.json()).error).toBe("NONCE_ALREADY_CONSUMED");
    expect(rec.sends).toHaveLength(0);
    const s = await repo.getSettlement(settlementIdFor("ag_win"));
    expect(s!.status, "FAILED, because nothing can have left").toBe("FAILED");
  });

  for (const [name, arrange, reason] of cases) {
    it(`${name} → ${reason}`, async () => {
      const rec = recorder();
      __setRailsForTests(baseRail(rec.transport));
      const a = accepted("ag_r");
      await repo.saveAgreement(a);
      const { reservationId } = await arrange(a);
      const res = await settle("ag_r", reservationId);
      const body = await res.json();
      expect(body.error).toBe(reason);
      expect(res.status).toBe(409);
      expect(rec.sends, "a refusal must not reach the transport").toHaveLength(0);
      expect(await repo.getSettlement(settlementIdFor("ag_r"))).toBeNull();
    });
  }

  it("an unconfigured rail refuses before anything is claimed or consumed", async () => {
    __setRailsForTests({});
    await repo.saveAgreement(accepted("ag_nr"));
    const { body: r } = await reserveFor("ag_nr");
    const res = await settle("ag_nr", r.data.reservationId);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("SETTLEMENT_RAIL_NOT_CONFIGURED");
    expect(await repo.getSettlement(settlementIdFor("ag_nr"))).toBeNull();
    expect((await repo.getReservation(r.data.reservationId))!.status, "nonce untouched").toBe("RESERVED");
  });

  it("a vault whose address is not the rail's payer is refused", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport, "0x2222222222222222222222222222222222222222"));
    await repo.saveAgreement(accepted("ag_vb"));
    const { body: r } = await reserveFor("ag_vb");
    const res = await settle("ag_vb", r.data.reservationId);
    expect((await res.json()).error).toBe("VAULT_NOT_BOUND_TO_RAIL");
    expect(rec.sends).toHaveLength(0);
  });

  it("the reserve route refuses a reservation whose terms differ from the agreement", async () => {
    await repo.saveAgreement(accepted("ag_t"));
    const { res, body } = await reserveFor("ag_t", { counterparty: "provider_beta" });
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ error: "RESERVATION_TERMS_DO_NOT_MATCH_AGREEMENT", term: "counterparty" });
  });

  it("an agreement cannot be opened with a payout chain its Space does not settle on", async () => {
    const res = await post(agreementsPOST, {
      op: "open", spaceId: space.spaceId,
      draft: {
        agreementId: "ag_sol", runId: "r", intentId: "i", client: CLIENT, provider: PROVIDER, evaluator: CLIENT,
        price: PRICE, deadline: "2026-12-01T00:00:00Z", payTo: { chain: "solana", address: "So1ana1111111111111111111111111111111111111" },
      },
      proposal: { capability: "research", amount: PRICE },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("SETTLEMENT_CHAIN_NOT_ALLOWED_IN_SPACE");
  });
});

describe("settlement moves the vault's books (backlog #2)", () => {
  const book = async () => {
    const v = (await repo.getVault(VAULT_ID))!;
    expect(reconcileVault(v).ok, "the vault reconciles at every step").toBe(true);
    return { total: v.total, available: v.available, reserved: v.reserved, settling: v.settling };
  };

  it("reserved → settling → paid out: total falls by exactly the price, nothing stays reserved", async () => {
    __setRailsForTests(baseRail(recorder().transport));
    await repo.saveAgreement(accepted("ag_book"));
    const before = await book();
    const { body: r } = await reserveFor("ag_book");
    const reserved = await book();
    expect(reserved.reserved - before.reserved).toBeCloseTo(PRICE.amount, 6);
    expect((await settle("ag_book", r.data.reservationId)).status).toBe(200);
    const after = await book();
    expect(after.reserved).toBeCloseTo(before.reserved, 6);
    expect(after.settling).toBeCloseTo(before.settling, 6);
    expect(before.total - after.total).toBeCloseTo(PRICE.amount, 6);
    expect(after.available).toBeCloseTo(before.available - PRICE.amount, 6);
  });

  it("an unknown outcome keeps the money in settling — neither spent nor available", async () => {
    __setRailsForTests(baseRail(recorder({ throwOnSend: new Error("socket hang up") }).transport));
    await repo.saveAgreement(accepted("ag_book_unknown"));
    const before = await book();
    const { body: r } = await reserveFor("ag_book_unknown");
    await settle("ag_book_unknown", r.data.reservationId);
    const after = await book();
    expect(after.settling - before.settling).toBeCloseTo(PRICE.amount, 6);
    expect(after.total).toBeCloseTo(before.total, 6);
  });

  it("confirming twice applies the capital once", async () => {
    const rec = recorder({ confirm: false });
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_book_twice"));
    const before = await book();
    const { body: r } = await reserveFor("ag_book_twice");
    await settle("ag_book_twice", r.data.reservationId);
    rec.setConfirm(true);
    const confirm = () => post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor("ag_book_twice"), now: NOW });
    await Promise.all([confirm(), confirm()]);
    await confirm();
    const after = await book();
    expect(before.total - after.total).toBeCloseTo(PRICE.amount, 6);
    expect(after.settling).toBeCloseTo(before.settling, 6);
  });
});

describe("settlement caller — never pays twice", () => {
  it("a repeat settle of a paid agreement is refused and sends nothing more", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_twice"));
    const { body: r1 } = await reserveFor("ag_twice");
    expect((await settle("ag_twice", r1.data.reservationId)).status).toBe(200);
    const { body: r2 } = await reserveFor("ag_twice");
    const again = await settle("ag_twice", r2.data.reservationId);
    expect((await again.json()).error).toBe("ALREADY_SETTLED");
    expect(rec.sends).toHaveLength(1);
  });

  it("two concurrent settles with two valid reservations pay once", async () => {
    const rec = recorder();
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_race"));
    const { body: r1 } = await reserveFor("ag_race");
    const { body: r2 } = await reserveFor("ag_race");
    const results = await Promise.all([settle("ag_race", r1.data.reservationId), settle("ag_race", r2.data.reservationId)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(rec.sends).toHaveLength(1);
  });

  it("a transport error leaves the settlement PENDING and blocks any retry — the transfer may have landed", async () => {
    const rec = recorder({ throwOnSend: new Error("socket hang up") });
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_unk"));
    const { body: r1 } = await reserveFor("ag_unk");
    const res = await settle("ag_unk", r1.data.reservationId);
    expect(res.status).toBe(502);
    const s = await repo.getSettlement(settlementIdFor("ag_unk"));
    expect(s!.status).toBe("PENDING");
    expect(s!.failureReason).toMatch(/^OUTCOME_UNKNOWN/);
    expect((await repo.getAgreement("ag_unk"))!.settledRef).toBeUndefined();

    // A fresh, valid reservation still cannot pay it again.
    const { body: r2 } = await reserveFor("ag_unk");
    const retry = await settle("ag_unk", r2.data.reservationId);
    expect((await retry.json()).error).toBe("SETTLEMENT_ALREADY_CLAIMED");
    expect(rec.sends).toHaveLength(1);
  });

  it("an unconfirmed transfer stays SUBMITTED (202) until confirm finds it on chain", async () => {
    const rec = recorder({ confirm: false });
    __setRailsForTests(baseRail(rec.transport));
    await repo.saveAgreement(accepted("ag_slow"));
    const { body: r } = await reserveFor("ag_slow");
    const first = await settle("ag_slow", r.data.reservationId);
    expect(first.status).toBe(202);
    expect((await first.json()).data.settlement.status).toBe("SUBMITTED");
    expect((await repo.getAgreement("ag_slow"))!.settledRef, "not settled until confirmed").toBeUndefined();

    rec.setConfirm(true);
    const confirmed = await post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor("ag_slow"), now: NOW });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).data.settlement.status).toBe("CONFIRMED");
    expect((await repo.getAgreement("ag_slow"))!.settledRef).toBe(settlementIdFor("ag_slow"));
    expect((await repo.getReservation(r.data.reservationId))!.status).toBe("SETTLED");
    expect(rec.sends, "confirm re-reads; it never re-sends").toHaveLength(1);
  });
});

/**
 * LIVE: the whole Mitra path — ACCEPTED agreement, reservation through the reserve
 * route, `/settlements` — through the rail `railsFromEnv()` builds, to Base Sepolia.
 * Pays the relayer's own address (only gas is spent). The vault record is bound to
 * the relayer EOA, which is what the testnet custody decision (seq 55) means.
 */
const LIVE_KEY = ".dev-keys/evm-testnet.key";
describe.skipIf(!(process.env.BASE_LIVE === "1" && existsSync(LIVE_KEY)))("live: an ACCEPTED agreement settles on Base Sepolia (BASE_LIVE=1)", () => {
  it("settles through /api/v1/settlements and confirms from the chain", async () => {
    const rails = await railsFromEnv({
      MITRA_EVM_SETTLEMENT_KEY_FILE: LIVE_KEY,
      BASE_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    });
    expect(rails.base, "railsFromEnv must build the Base rail from these two variables").toBeDefined();
    const relayer = rails.base!.payer;
    __setRailsForTests(rails);

    // Re-bind the test vault to the relayer EOA: the rail refuses any other.
    repo = new TestRepo(new CapitalLedger(seedVaults.map((v) => (v.vaultId === VAULT_ID ? { ...v, address: relayer } : v)), []));
    repo.extraMandates.set("mandate_pay_base_v1", mandate());
    await repo.updateSpace(space);
    globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });

    const id = `ag_live_${Date.now()}`;
    const price = { asset: "USDC" as const, amount: 0.01 };
    await repo.saveAgreement(accepted(id, { price, payTo: { chain: "base", address: relayer } }));
    const now = new Date().toISOString();
    const { res: rr, body: r } = await reserveFor(id, { amount: price.amount, now });
    expect(rr.status, JSON.stringify(r)).toBe(201);

    const first = await post(settlementsPOST, { op: "settle", agreementId: id, reservationId: r.data.reservationId, now });
    let body = await first.json();
    expect([200, 202], JSON.stringify(body)).toContain(first.status);
    for (let i = 0; i < 30 && body.data.settlement.status !== "CONFIRMED"; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      body = await (await post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor(id), now: new Date().toISOString() })).json();
    }
    const s = body.data.settlement;
    console.log(`live agreement settlement ${s.settlementId} tx ${s.txHash} status ${s.status} evidence ${s.evidenceLevel}`);
    expect(s.status).toBe("CONFIRMED");
    expect(s.evidenceLevel).toBe("TESTNET_PASS");
    expect((await repo.getAgreement(id))!.settledRef).toBe(s.settlementId);

    // Read the transaction back from the node, independently of verify(): the
    // calldata must carry this settlement's commitment.
    const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
    const tx = await (await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [s.txHash] }),
    })).json() as { result: { input: `0x${string}` } };
    expect(commitmentFromCalldata(tx.result.input)).toBe(s.commitment);

    // Sprint item 2: evidence, re-observed from the chain through the route. The
    // block number must be the node's, and the bundle must verify from JSON alone.
    const receiptRes = await (await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionReceipt", params: [s.txHash] }),
    })).json() as { result: { blockNumber: string } };
    const ev = await evidenceGET(new Request(`http://localhost/api/v1/settlements/evidence?settlementId=${s.settlementId}`));
    const evBody = await ev.json();
    console.log(`live evidence ${s.settlementId}: ${JSON.stringify(evBody.data?.verdict ?? evBody)} block ${evBody.data?.bundle?.confirmation?.blockNumber} receipt ${evBody.data?.receipt?.receiptId}`);
    expect(ev.status, JSON.stringify(evBody)).toBe(200);
    expect(evBody.data.verdict).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    expect(evBody.data.bundle.chain).toBe("base-sepolia");
    expect(evBody.data.bundle.confirmation.blockNumber).toBe(Number(BigInt(receiptRes.result.blockNumber)));
    expect(verifyEvidenceBundle(bundleFromJson(evBody.data.bundle))).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    expect(evBody.data.receiptChain.verdict).toEqual({ ok: true });
  }, 120_000);
});

/**
 * LIVE, sprint item 3: the same Mitra path, but the payer is a SMART ACCOUNT
 * (Coinbase Smart Wallet v1) settling through a UserOperation the relayer submits
 * to the real EntryPoint v0.6 — and the account's signatures checked on chain via
 * ERC-6492 (before deployment) and ERC-1271 (after).
 *
 * Provisioning is one-time and conditional: the relayer tops the account up with a
 * little ETH (its own UserOperation gas) and USDC only when it is short.
 */
describe.skipIf(!(process.env.BASE_LIVE === "1" && existsSync(LIVE_KEY)))("live: ERC-4337 smart account settles, ERC-1271/6492 verify (BASE_LIVE=1)", () => {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

  it("ERC-6492: an undeployed smart account's settlement signature verifies on chain; a stranger's does not", async () => {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }) as PublicClient;
    const owner = privateKeyToAccount(`0x${readFileSync(LIVE_KEY, "utf8").trim().replace(/^0x/, "")}`);
    // A fresh account nonce, so this account is guaranteed undeployed.
    const fresh = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1", nonce: BigInt(Date.now()) });
    expect(await fresh.isDeployed()).toBe(false);
    const domain = settlingDomain(84532, "0x0000000000000000000000000000000000000000");
    const typed = { settlementId: `live-6492-${Date.now()}`, from: fresh.address, to: PAYEE as `0x${string}`, amountAtomic: 10_000n, asset: BASE_ASSETS[84532].USDC.address };
    const message = { settlementId: typed.settlementId, from: typed.from, to: typed.to, amount: typed.amountAtomic, asset: typed.asset };
    const signature = await fresh.signTypedData({ domain, types: SETTLEMENT_TYPES, primaryType: "Settlement", message } as never);
    expect(isErc6492Signature(signature)).toBe(true);
    const verifier = new RpcSignatureVerifier(client);
    const digest = settlementDigest(domain, typed);
    const ok = await verifyAuthorisation({ digest, signature, expectedSigner: fresh.address, domain, typed, verifier });
    console.log(`live 6492 ${fresh.address}: ${JSON.stringify(ok)}`);
    expect(ok).toEqual({ ok: true, mode: "contract" });

    const stranger = await toCoinbaseSmartAccount({ client, owners: [privateKeyToAccount(`0x${"44".repeat(32)}`)], version: "1" });
    const forged = await stranger.signTypedData({ domain, types: SETTLEMENT_TYPES, primaryType: "Settlement", message } as never);
    expect((await verifyAuthorisation({ digest, signature: forged, expectedSigner: fresh.address, domain, typed, verifier })).ok).toBe(false);
  }, 60_000);

  it("an ACCEPTED agreement is paid by the smart account through the EntryPoint; evidence verifies; then ERC-1271", async () => {
    const rails = await railsFromEnv({
      MITRA_EVM_SETTLEMENT_KEY_FILE: LIVE_KEY, BASE_RPC_URL: rpcUrl, MITRA_BASE_SETTLEMENT_ACCOUNT: "erc4337",
    });
    const smart = rails.base!.payer as `0x${string}`;
    const relayer = privateKeyToAccount(`0x${readFileSync(LIVE_KEY, "utf8").trim().replace(/^0x/, "")}`);
    expect(smart.toLowerCase(), "the payer is the smart account, not the relayer").not.toBe(relayer.address.toLowerCase());

    // One-time, conditional provisioning from the relayer.
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }) as PublicClient;
    const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpcUrl), account: relayer });
    const usdc = BASE_ASSETS[84532].USDC.address;
    if ((await client.getBalance({ address: smart })) < 200_000_000_000_000n) {
      await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: smart, value: 500_000_000_000_000n }) });
    }
    if ((await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [smart] })) < 10_000n) {
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [smart, 100_000n] }) });
    }

    __setRailsForTests(rails);
    repo = new TestRepo(new CapitalLedger(seedVaults.map((v) => (v.vaultId === VAULT_ID ? { ...v, address: smart } : v)), []));
    repo.extraMandates.set("mandate_pay_base_v1", mandate());
    await repo.updateSpace(space);
    globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });

    const id = `ag_live4337_${Date.now()}`;
    const price = { asset: "USDC" as const, amount: 0.01 };
    await repo.saveAgreement(accepted(id, { price, payTo: { chain: "base", address: relayer.address } }));
    const now = new Date().toISOString();
    const { res: rr, body: r } = await reserveFor(id, { amount: price.amount, now });
    expect(rr.status, JSON.stringify(r)).toBe(201);

    const first = await post(settlementsPOST, { op: "settle", agreementId: id, reservationId: r.data.reservationId, now });
    let body = await first.json();
    expect([200, 202], JSON.stringify(body)).toContain(first.status);
    for (let i = 0; i < 30 && body.data.settlement.status !== "CONFIRMED"; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      body = await (await post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor(id), now: new Date().toISOString() })).json();
    }
    const s = body.data.settlement;
    console.log(`live 4337 settlement ${s.settlementId} handleOps tx ${s.txHash} from ${s.from} status ${s.status}`);
    expect(s.status).toBe("CONFIRMED");
    expect(s.from.toLowerCase()).toBe(smart.toLowerCase());

    const ev = await (await evidenceGET(new Request(`http://localhost/api/v1/settlements/evidence?settlementId=${s.settlementId}`))).json();
    console.log(`live 4337 evidence: ${JSON.stringify(ev.data?.verdict ?? ev)} block ${ev.data?.bundle?.confirmation?.blockNumber}`);
    expect(ev.data.verdict).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    expect(verifyEvidenceBundle(bundleFromJson(ev.data.bundle))).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });

    // ERC-1271 against the now-deployed account: a plain (not 6492) signature.
    const account = await toCoinbaseSmartAccount({ client, owners: [relayer], version: "1" });
    expect(await account.isDeployed()).toBe(true);
    const domain = settlingDomain(84532, "0x0000000000000000000000000000000000000000");
    const typed = { settlementId: s.settlementId, from: smart, to: relayer.address, amountAtomic: 10_000n, asset: usdc };
    const sig = await account.signTypedData({ domain, types: SETTLEMENT_TYPES, primaryType: "Settlement", message: { settlementId: typed.settlementId, from: typed.from, to: typed.to, amount: typed.amountAtomic, asset: typed.asset } } as never);
    expect(isErc6492Signature(sig), "a deployed account signs plain ERC-1271").toBe(false);
    const v1271 = await verifyAuthorisation({ digest: settlementDigest(domain, typed), signature: sig, expectedSigner: smart, domain, typed, verifier: new RpcSignatureVerifier(client) });
    console.log(`live 1271 ${smart}: ${JSON.stringify(v1271)}`);
    expect(v1271).toEqual({ ok: true, mode: "contract" });
  }, 180_000);
});

describe("settleCapital (kernel)", () => {
  const v = { ...seedVaults[0], total: 100, available: 50, reserved: 0, escrowed: 0, encumbered: 0, settling: 10, frozen: 40 };
  it("pays out what was paid and returns the rest", () => {
    const n = settleCapital(v, 10, 4);
    expect([n.total, n.settling, n.available]).toEqual([96, 0, 56]);
    expect(reconcileVault(n).ok).toBe(true);
  });
  it("refuses to pay more than was reserved, more than is settling, or nothing", () => {
    expect(() => settleCapital(v, 10, 11)).toThrow("PAID_EXCEEDS_RESERVATION");
    expect(() => settleCapital(v, 11, 4)).toThrow("SETTLEMENT_EXCEEDS_SETTLING_CAPITAL");
    expect(() => settleCapital(v, 10, 0)).toThrow("INVALID_PAID_AMOUNT");
  });
});

