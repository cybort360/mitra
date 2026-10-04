/**
 * Sprint item 4: the x402 gateway, offline.
 *
 * The paid resource is emulated with the reference SDK's own header encoders
 * (`@x402/core/http`), so the client side — `@x402/fetch` + `ExactEvmScheme`, with
 * Mitra's guard in `onBeforePaymentCreation` — runs unmodified against real x402 V2
 * wire format. The resource records whether a payment signature ever arrived, so a
 * refusal can be checked for the property that matters: NOTHING WAS SIGNED.
 * The live run against the public facilitator is gated on BASE_LIVE=1 below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";
import type { Mandate, Vault } from "@/lib/domain/types";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { actionDigestFor } from "@/lib/store/ids";
import { BASE_ASSETS } from "@/lib/adapters/base";
import { X402_CAPABILITY, x402Counterparty, x402SettlementIdFor } from "@/lib/kernel/x402";
import { baseSepoliaObserver, payX402, type TransferObserver } from "@/lib/payments/x402-gateway";
import { verifyReceiptChain } from "@/lib/kernel/receipts";
import { POST as x402POST } from "@/app/api/v1/x402/route";

const signer = privateKeyToAccount(`0x${"33".repeat(32)}`);
const PAYEE = "0x2222222222222222222222222222222222222222";
const URL_ = "https://data.example/premium";
const USDC = BASE_ASSETS[84532].USDC.address;
const NOW = new Date("2026-10-04T12:00:00.000Z");
const TX = `0x${"9a".repeat(32)}`;

class TestRepo extends InMemoryRepository {
  mandate!: Mandate;
  async getMandate(id: string) { return id === this.mandate?.mandateId ? this.mandate : super.getMandate(id); }
}

let repo: TestRepo;
const vault = (): Vault => ({ ...seedVaults.find((v) => v.vaultId === "vault_base_ops")!, address: signer.address, available: 100, total: 100, reserved: 0 });

async function reserve(over: { amount?: number; payTo?: string } = {}) {
  const amount = over.amount ?? 0.05;
  const r = await repo.reserveCapital({
    vaultId: "vault_base_ops", amount, reservationId: `res_${Math.random().toString(36).slice(2)}`, runId: "run_x402",
    intentId: "intent_x402", mandateId: repo.mandate.mandateId, mandateVersion: 1, asset: "USDC", chain: "base",
    actionDigest: actionDigestFor({
      vaultId: "vault_base_ops", mandateId: repo.mandate.mandateId, mandateVersion: 1, amount, asset: "USDC", chain: "base",
      counterparty: x402Counterparty(over.payTo ?? PAYEE), capability: X402_CAPABILITY,
    }),
    expiresAt: "2026-10-04T13:00:00.000Z",
  });
  if (!r.ok) throw new Error(r.reason);
  return r.reservation;
}

/** A paid resource speaking x402 V2. Records every payment signature it receives. */
function paidResource(over: { payTo?: string; amount?: string; resource?: string; network?: string; asset?: string; settle?: boolean } = {}) {
  const signatures: ReturnType<typeof decodePaymentSignatureHeader>[] = [];
  const requirements = {
    scheme: "exact", network: (over.network ?? "eip155:84532") as `${string}:${string}`, asset: over.asset ?? USDC,
    amount: over.amount ?? "10000", payTo: over.payTo ?? PAYEE, maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sig = headers.get("PAYMENT-SIGNATURE");
    if (!sig) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: over.resource ?? URL_ }, accepts: [requirements] }) } });
    }
    signatures.push(decodePaymentSignatureHeader(sig));
    if (over.settle === false) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: "insufficient_funds", transaction: "", network: requirements.network }) } });
    }
    return new Response(JSON.stringify({ premium: true }), {
      status: 200,
      headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: requirements.network }) },
    });
  }) as typeof fetch;
  return { fetchImpl, signatures };
}

const observer = (found: boolean): TransferObserver => async () => (found ? { block: 1234 } : null);
const pay = (reservationId: string, resource: ReturnType<typeof paidResource>, found = true) =>
  payX402({ repo, reservationId, url: URL_, signer, now: () => NOW, observe: observer(found), fetchImpl: resource.fetchImpl });

beforeEach(async () => {
  repo = new TestRepo(new CapitalLedger([vault()], []));
  repo.mandate = {
    mandateId: "mandate_x402", name: "x402", version: 1, principal: "P", agentId: "agent_buyer_07", vaultId: "vault_base_ops",
    asset: "USDC", budget: 10, maxTransaction: 1, allowedCounterparties: ["x402:*"], allowedCapabilities: [X402_CAPABILITY],
    prohibitedCapabilities: [], approvedChains: ["base"], policyVersion: "t", expiresAt: "2026-12-31T00:00:00Z", nonce: 1,
    status: "ACTIVE", confidentialPolicy: false,
  };
});

describe("x402 gateway — pays only what the reservation approved", () => {
  it("pays the approved payee, from the vault's account, for the announced amount; confirms from the chain", async () => {
    const res = await reserve();
    const resource = paidResource();
    const out = await pay(res.reservationId, resource);
    expect(out.refusal).toBeNull();
    expect(out.response!.status).toBe(200);
    expect(await out.response!.json()).toEqual({ premium: true });

    expect(resource.signatures).toHaveLength(1);
    const auth = (resource.signatures[0].payload as { authorization: { from: string; to: string; value: string } }).authorization;
    expect(auth.from.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAYEE);
    expect(auth.value).toBe("10000");

    const s = out.settlement!;
    expect(s).toMatchObject({ settlementId: x402SettlementIdFor(res.reservationId), status: "CONFIRMED", txHash: TX, amount: 0.01, to: PAYEE });
    expect(s.receiptId).toBe(`rcpt_${s.settlementId}`);
    expect(verifyReceiptChain(await repo.listReceipts("run_x402"))).toEqual({ ok: true });
    expect((await repo.getReservation(res.reservationId))!.status).toBe("SETTLED");
    // Backlog #2: 0.05 was reserved, 0.01 paid — relative to before the reservation,
    // total and available fall by 0.01, and nothing stays reserved or settling.
    const v = (await repo.getVault("vault_base_ops"))!;
    const b = vault();
    expect(v.total).toBeCloseTo(b.total - 0.01, 6);
    expect(v.available).toBeCloseTo(b.available - 0.01, 6);
    expect(v.reserved).toBeCloseTo(b.reserved, 6);
    expect(v.settling).toBeCloseTo(b.settling, 6);
  });

  const refusals: Array<[string, Parameters<typeof paidResource>[0], string, { amount?: number }?]> = [
    ["the 402 names a payee the reservation was not made for", { payTo: "0x4444444444444444444444444444444444444444" }, "ACTION_DIGEST_MISMATCH"],
    ["the 402 asks more than the reservation holds", { amount: "60000" }, "AMOUNT_EXCEEDS_RESERVATION"],
    ["the 402 is for a different resource than the one requested", { resource: "https://data.example/other" }, "X402_RESOURCE_MISMATCH"],
  ];
  for (const [why, over, reason] of refusals) {
    it(`refuses when ${why} → ${reason}, and signs nothing`, async () => {
      const res = await reserve();
      const resource = paidResource(over);
      const out = await pay(res.reservationId, resource);
      expect(out.refusal).toBe(reason);
      expect(resource.signatures, "no payment signature may leave Mitra").toHaveLength(0);
      expect(await repo.getSettlement(x402SettlementIdFor(res.reservationId))).toBeNull();
      expect((await repo.getReservation(res.reservationId))!.status).toBe("RESERVED");
    });
  }

  // For a foreign network or token the SDK refuses before Mitra's hook runs — its
  // registered networks and default spend controls. Mitra's own checks for the same
  // cases are tested directly on planX402Payment below.
  for (const [why, over] of [["another network", { network: "eip155:8453" }], ["another token", { asset: "0x4200000000000000000000000000000000000006" }]] as const) {
    it(`a 402 asking for ${why} is never paid, and the reason is reported`, async () => {
      const res = await reserve();
      const resource = paidResource(over);
      const out = await pay(res.reservationId, resource);
      expect(out.refusal).toMatch(/^X402_PAYMENT_NOT_CREATED: /);
      expect(resource.signatures).toHaveLength(0);
      expect((await repo.getReservation(res.reservationId))!.status).toBe("RESERVED");
    });
  }

  it("a reservation pays once: a second fetch with it is refused and signs nothing", async () => {
    const res = await reserve();
    await pay(res.reservationId, paidResource());
    const again = paidResource();
    const out = await pay(res.reservationId, again);
    expect(out.refusal).toBe("RESERVATION_NOT_EXECUTABLE");
    expect(again.signatures).toHaveLength(0);
  });

  it("a crash between claiming and consuming leaves an outcome-unknown claim; a retry is refused and signs nothing", async () => {
    // The reservation still reads RESERVED with its nonce unspent — only the PENDING
    // claim records that an earlier attempt may have signed.
    const res = await reserve();
    await repo.claimSettlement({
      settlementId: x402SettlementIdFor(res.reservationId), reservationId: res.reservationId, obligationIds: [], chain: "base",
      asset: "USDC", amount: 0.01, from: signer.address, to: PAYEE, status: "PENDING", submittedAt: NOW.toISOString(), evidenceLevel: "DESIGN_ONLY",
    });
    const resource = paidResource();
    const out = await pay(res.reservationId, resource);
    expect(out.refusal).toBe("SETTLEMENT_ALREADY_CLAIMED");
    expect(resource.signatures).toHaveLength(0);
  });

  it("refuses when the vault record does not name the signing account", async () => {
    repo = new TestRepo(new CapitalLedger([{ ...vault(), address: PAYEE }], []));
    repo.mandate = {
      mandateId: "mandate_x402", name: "x402", version: 1, principal: "P", agentId: "a", vaultId: "vault_base_ops", asset: "USDC",
      budget: 10, maxTransaction: 1, allowedCounterparties: ["x402:*"], allowedCapabilities: [X402_CAPABILITY], prohibitedCapabilities: [],
      approvedChains: ["base"], policyVersion: "t", expiresAt: "2026-12-31T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
    };
    const res = await reserve();
    const resource = paidResource();
    expect((await pay(res.reservationId, resource)).refusal).toBe("VAULT_NOT_BOUND_TO_PAYER");
    expect(resource.signatures).toHaveLength(0);
  });
});

describe("planX402Payment — Mitra's own checks, directly", () => {
  const base = async () => {
    const reservation = await reserve();
    return {
      requirements: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAYEE },
      announcedResource: URL_, expectedResource: URL_, reservation, mandate: repo.mandate, vault: vault(),
      payer: signer.address, now: NOW, consumedNonces: [] as number[],
    };
  };
  const cases: Array<[string, (b: Awaited<ReturnType<typeof base>>) => Awaited<ReturnType<typeof base>>, string]> = [
    ["another network", (b) => ({ ...b, requirements: { ...b.requirements, network: "eip155:8453" } }), "X402_NETWORK_MISMATCH"],
    ["another token", (b) => ({ ...b, requirements: { ...b.requirements, asset: "0x4200000000000000000000000000000000000006" } }), "X402_ASSET_MISMATCH"],
    ["another scheme", (b) => ({ ...b, requirements: { ...b.requirements, scheme: "upto" } }), "X402_SCHEME_NOT_SUPPORTED"],
    ["a non-numeric amount", (b) => ({ ...b, requirements: { ...b.requirements, amount: "1e6" } }), "X402_AMOUNT_INVALID"],
    ["a revoked mandate", (b) => ({ ...b, mandate: { ...b.mandate, status: "REVOKED" } }), "MANDATE_NOT_ACTIVE"],
    ["a frozen vault", (b) => ({ ...b, vault: { ...b.vault, emergencyFreeze: true } }), "VAULT_FROZEN"],
    ["a spent nonce", (b) => ({ ...b, consumedNonces: [b.reservation.nonce] }), "NONCE_ALREADY_CONSUMED"],
  ];
  for (const [why, change, reason] of cases) {
    it(`${why} → ${reason}`, async () => {
      const { planX402Payment } = await import("@/lib/kernel/x402");
      expect(planX402Payment(change(await base()))).toEqual({ ok: false, reason });
    });
  }
  it("the approved terms pass", async () => {
    const { planX402Payment } = await import("@/lib/kernel/x402");
    expect(planX402Payment(await base()).ok).toBe(true);
  });
});

describe("x402 gateway — a signed authorization is live money until it expires", () => {
  it("signed but not settled → PENDING, naming the expiry; the reservation stays SETTLING", async () => {
    const res = await reserve();
    const resource = paidResource({ settle: false });
    const out = await pay(res.reservationId, resource);
    expect(resource.signatures).toHaveLength(1);
    expect(out.settlement!.status).toBe("PENDING");
    expect(out.settlement!.failureReason).toMatch(/^AUTHORIZATION_OUTSTANDING_UNTIL \d{4}-\d\d-\d\dT/);
    expect((await repo.getReservation(res.reservationId))!.status).toBe("SETTLING");
  });

  it("settled per the facilitator but not found on chain → SUBMITTED, not CONFIRMED", async () => {
    const res = await reserve();
    const out = await pay(res.reservationId, paidResource(), false);
    expect(out.settlement!.status).toBe("SUBMITTED");
    expect(out.settlement!.receiptId).toBeUndefined();
  });
});

describe("x402 route", () => {
  const post = (body: unknown) => x402POST(new Request("http://localhost/api/v1/x402", { method: "POST", body: JSON.stringify(body) }));
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("refuses an origin that is not allow-listed (the server must not fetch arbitrary hosts)", async () => {
    process.env.MITRA_X402_ALLOWED_ORIGINS = "https://allowed.example";
    const res = await post({ reservationId: "r", url: "http://169.254.169.254/latest/meta-data" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("X402_ORIGIN_NOT_ALLOWED");
  });

  it("refuses to pay with no payer configured", async () => {
    process.env.MITRA_X402_ALLOWED_ORIGINS = "https://data.example";
    delete process.env.MITRA_EVM_SETTLEMENT_KEY_FILE;
    const res = await post({ reservationId: "r", url: URL_ });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("X402_PAYER_NOT_CONFIGURED");
  });
});

/**
 * LIVE: a real x402 V2 resource server (the SDK's `x402HTTPResourceServer`) backed by
 * the PUBLIC facilitator at x402.org, on Base Sepolia. Mitra pays 0.01 USDC from the
 * relayer EOA by EIP-3009; the facilitator — not Mitra — submits the transaction.
 * The payee is our own smart account, so the USDC stays in our hands.
 */
const LIVE_KEY = ".dev-keys/evm-testnet.key";
describe.skipIf(!(process.env.BASE_LIVE === "1" && existsSync(LIVE_KEY)))("live x402 against the public facilitator (BASE_LIVE=1)", () => {
  it("pays a real x402 resource from a reservation; the facilitator settles; Mitra confirms from the chain", async () => {
    const { x402ResourceServer, HTTPFacilitatorClient } = await import("@x402/core/server");
    const { x402HTTPResourceServer } = await import("@x402/core/http");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const live = privateKeyToAccount(`0x${readFileSync(LIVE_KEY, "utf8").trim().replace(/^0x/, "")}`);
    const payee = "0x00aD7C71680A5b1a9B86d41440022857fC17E7CA"; // our Coinbase Smart Wallet (item 3)

    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }))
      .register("eip155:84532", new ExactEvmScheme());
    await resourceServer.initialize();
    const routes = { "GET /premium": { accepts: { scheme: "exact", network: "eip155:84532" as const, payTo: payee, price: "$0.01" }, description: "Mitra x402 live test", mimeType: "application/json" } };
    const httpServer = new x402HTTPResourceServer(resourceServer, routes);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = `http://${req.headers.host}${req.url}`;
      const adapter = {
        getHeader: (n: string) => { const v = req.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v; },
        getMethod: () => req.method ?? "GET", getPath: () => new URL(url).pathname, getUrl: () => url,
        getAcceptHeader: () => String(req.headers.accept ?? "*/*"), getUserAgent: () => String(req.headers["user-agent"] ?? ""),
      };
      const result = await httpServer.processHTTPRequest({ adapter, path: adapter.getPath(), method: adapter.getMethod() } as never);
      const send = (status: number, headers: Record<string, string>, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
      };
      if (result.type === "payment-error") return send(result.response.status, result.response.headers, result.response.body);
      if (result.type === "payment-verified") {
        const settled = await httpServer.processSettlement(result.paymentPayload, result.paymentRequirements);
        if (!settled.success) return send(402, settled.headers, { error: settled.errorReason });
        return send(200, settled.headers, { premium: true });
      }
      return send(200, {}, { free: true });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/premium`;

    try {
      repo = new TestRepo(new CapitalLedger([{ ...vault(), address: live.address }], []));
      repo.mandate = { ...repo.mandate! } as Mandate;
      repo.mandate = {
        mandateId: "mandate_x402", name: "x402", version: 1, principal: "P", agentId: "a", vaultId: "vault_base_ops", asset: "USDC",
        budget: 10, maxTransaction: 1, allowedCounterparties: ["x402:*"], allowedCapabilities: [X402_CAPABILITY], prohibitedCapabilities: [],
        approvedChains: ["base"], policyVersion: "t", expiresAt: "2027-12-31T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
      };
      const now = new Date();
      const r = await repo.reserveCapital({
        vaultId: "vault_base_ops", amount: 0.05, reservationId: `res_live_${Date.now()}`, runId: "run_x402_live", intentId: "i",
        mandateId: "mandate_x402", mandateVersion: 1, asset: "USDC", chain: "base",
        actionDigest: actionDigestFor({ vaultId: "vault_base_ops", mandateId: "mandate_x402", mandateVersion: 1, amount: 0.05, asset: "USDC", chain: "base", counterparty: x402Counterparty(payee), capability: X402_CAPABILITY }),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      });
      if (!r.ok) throw new Error(r.reason);

      const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
      let out = await payX402({ repo, reservationId: r.reservation.reservationId, url, signer: live, now: () => new Date(), observe: baseSepoliaObserver(http(rpc)) });
      // The facilitator may return before the node indexes the receipt; re-observe briefly.
      for (let i = 0; i < 15 && out.settlement?.status === "SUBMITTED"; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const seen = await baseSepoliaObserver(http(rpc))(out.settlement.txHash!, { token: USDC, from: live.address, to: payee, amountAtomic: 10_000n });
        if (seen) out = { ...out, settlement: { ...out.settlement, status: "CONFIRMED" } };
      }
      console.log(`live x402: refusal=${out.refusal} http=${out.response?.status} settlement=${out.settlement?.status} tx=${out.settlement?.txHash} reason=${out.settlement?.failureReason ?? ""}`);
      expect(out.refusal).toBeNull();
      expect(out.response!.status).toBe(200);
      expect(out.settlement!.status).toBe("CONFIRMED");
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  }, 120_000);
});
