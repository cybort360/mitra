/**
 * PP-7: the sandbox, end to end on a real anvil chain running the compiled MitraJobEscrow.
 *
 * Skipped only when anvil is not installed. Each test drives Mitra's real route code
 * in-process and the real contract on chain; the scripted parts are the counterparties'
 * decisions and the keeper. The canaries at the end pin defects the sandbox exposed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store/provider";
import { anvilAvailable, SANDBOX_BANNER, startSandbox, type Sandbox } from "@/lib/sandbox";
import { jobEscrowAddress } from "@/lib/adapters/erc8183-transport";
import { escrowRailFor } from "@/lib/commerce/escrow-rail";
import { prepareStore } from "./fixtures";

const ESCROW = { NONE: 0, FUNDED: 1, COMPLETED: 2, REFUNDED: 3 };
const units = (usdc: number) => BigInt(usdc) * 10n ** 6n;

describe("startSandbox refuses a real store", () => {
  it("will not start with DATABASE_URL set", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://should-not-be-touched";
    try {
      await expect(startSandbox()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    }
  });
});

describe("the local escrow network (lead files, additive)", () => {
  it("has no rail unless both MITRA_LOCAL_EVM_RPC and MITRA_LOCAL_JOB_ESCROW are set", () => {
    const key = { MITRA_EVM_SETTLEMENT_KEY: `0x${"11".repeat(32)}` };
    expect(escrowRailFor("local", key)).toBeNull();
    expect(escrowRailFor("local", { ...key, MITRA_LOCAL_EVM_RPC: "http://127.0.0.1:8545" })).toBeNull();
    expect(escrowRailFor("local", { ...key, MITRA_LOCAL_JOB_ESCROW: "0x5fbdb2315678afecb367f032d93f642f64180aa3" })).toBeNull();
    const rail = escrowRailFor("local", { ...key, MITRA_LOCAL_EVM_RPC: "http://127.0.0.1:8545", MITRA_LOCAL_JOB_ESCROW: "0x5fbdb2315678afecb367f032d93f642f64180aa3" });
    expect(rail).toMatchObject({ chain: "evm", network: "local" });
  });

  it("reads its escrow address from the environment, never deployments.json, and refuses when unset", () => {
    const saved = process.env.MITRA_LOCAL_JOB_ESCROW;
    try {
      delete process.env.MITRA_LOCAL_JOB_ESCROW;
      expect(() => jobEscrowAddress("local")).toThrow(/MITRA_LOCAL_JOB_ESCROW/);
      process.env.MITRA_LOCAL_JOB_ESCROW = "0x00000000000000000000000000000000000000aa";
      expect(jobEscrowAddress("local")).toBe("0x00000000000000000000000000000000000000aa");
    } finally {
      if (saved === undefined) delete process.env.MITRA_LOCAL_JOB_ESCROW; else process.env.MITRA_LOCAL_JOB_ESCROW = saved;
    }
  });
});

describe.skipIf(!anvilAvailable() || !!process.env.DATABASE_URL)("the sandbox on anvil", () => {
  let sb: Sandbox;

  beforeAll(async () => {
    await prepareStore();
    sb = await startSandbox({ adversary: "withhold" });
  }, 60_000);
  afterAll(async () => { await sb?.stop(); });

  it("announces itself and runs on chain 31337 only", () => {
    expect(sb.banner).toBe(SANDBOX_BANNER);
    expect(sb.banner).toMatch(/simulation/);
    expect(sb.chain.chainId).toBe(31337);
  });

  it("happy path: fund locks the price on chain, delivery is accepted, the provider is paid on chain", async () => {
    const before = await sb.chain.tokenBalance(sb.provider.account.address);
    await sb.openAgreement({ agreementId: "sb_happy", price: 25 });
    await sb.fund("sb_happy");
    expect(await sb.escrowStatus("sb_happy")).toBe(ESCROW.FUNDED);

    const log = [...(await sb.tick()), ...(await sb.tick())];
    expect(log).toContain("sandbox_provider: started sb_happy");
    expect(log).toContain("sandbox_provider: submitted sb_happy (deliver)");
    expect(log.some((l) => l.startsWith("evaluator: accepted sb_happy"))).toBe(true);

    expect(await sb.escrowStatus("sb_happy")).toBe(ESCROW.COMPLETED);
    expect(await sb.chain.tokenBalance(sb.provider.account.address)).toBe(before + units(25));
    expect((await sb.client.mitra.commerce.getAgreement("sb_happy")).status).toBe("ACCEPTED");
  }, 60_000);

  it("time travel: a withheld delivery is refunded by the contract's own timeout, two hours in one call", async () => {
    const clientBefore = await sb.chain.tokenBalance(sb.client.account.address);
    await sb.openAgreement({ agreementId: "sb_timeout", provider: "adversary", price: 40, timeoutSeconds: 7200 });
    await sb.fund("sb_timeout");
    await sb.tick(); // the adversary starts
    expect(await sb.tick()).toContain("sandbox_adversary: withholding sb_timeout");

    // Before the timeout only the client vault or evaluator may refund; the keeper has no role.
    await expect(sb.keeper.refundTimedOut("sb_timeout")).rejects.toThrow();
    expect(await sb.escrowStatus("sb_timeout")).toBe(ESCROW.FUNDED);

    const started = Date.now();
    const t0 = await sb.clock.now();
    const t1 = await sb.clock.advanceSeconds(7200);
    expect(t1 - t0).toBeGreaterThanOrEqual(7200);
    await sb.keeper.refundTimedOut("sb_timeout");
    expect(Date.now() - started, "two hours of chain time in well under a minute of wall time").toBeLessThan(10_000);

    expect(await sb.escrowStatus("sb_timeout")).toBe(ESCROW.REFUNDED);
    expect(await sb.chain.tokenBalance(sb.client.account.address)).toBe(clientBefore);

    // F97: Mitra now learns of it from the CHAIN, on the read that asks. The keeper is not a
    // party and told nobody, so this used to keep reporting FUNDED over returned capital.
    const seen = await sb.client.mitra.commerce.getAgreement("sb_timeout");
    expect(seen.status, "reconciled against the chain, with no message from any party").toBe("REFUNDED");

    // And the client's own refund op is now correctly terminal rather than re-refunding.
    await expect(
      sb.client.mitra.recovery.refundEscrow("sb_timeout", { failureReason: "PROVIDER_TIMEOUT" }),
    ).rejects.toThrow(/AGREEMENT_TERMINAL/);
  }, 60_000);

  it("a garbage delivery is rejected by the evaluator and the escrow is refunded on chain by the committed route", async () => {
    sb.adversary.behaviour = "garbage";
    try {
      const clientBefore = await sb.chain.tokenBalance(sb.client.account.address);
      await sb.openAgreement({ agreementId: "sb_garbage", provider: "adversary", price: 10 });
      await sb.fund("sb_garbage");
      const log = [...(await sb.tick()), ...(await sb.tick())];
      expect(log.some((l) => l.startsWith("evaluator: rejected sb_garbage (CRITERION_FAILED"))).toBe(true);
      expect(await sb.escrowStatus("sb_garbage")).toBe(ESCROW.REFUNDED);
      expect(await sb.chain.tokenBalance(sb.client.account.address)).toBe(clientBefore);
      const agreement = await sb.client.mitra.commerce.getAgreement("sb_garbage");
      expect(agreement.status).toBe("REJECTED");
      expect(agreement.sagaIds?.length).toBeGreaterThan(0);
    } finally {
      sb.adversary.behaviour = "withhold";
    }
  }, 60_000);

  // ── canaries: defects the sandbox exposed (forge/FAILURES.md) ─────────────────

  // F95, fixed: `depositToEscrow` measures the deposit against `totalAllocated` rather
  // than the contract's whole balance, so a second job cannot be funded out of the first
  // job's tokens. The companion `test_second_deposit_requires_its_own_tokens` in
  // contracts/test/MitraJobEscrow.t.sol pins the same property at the contract boundary.
  it("F95: a second escrow cannot be funded by the first escrow's tokens", async () => {
    await sb.openAgreement({ agreementId: "sb_f95_a", price: 30 });
    await sb.openAgreement({ agreementId: "sb_f95_b", price: 30 });
    await sb.fund("sb_f95_a");
    // B's price is never sent to the escrow.
    const err = await sb.client.mitra.commerce.fund("sb_f95_b", { onChainEscrow: sb.escrowRef("sb_f95_b") }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  }, 60_000);

  it("F96: an agreement whose evaluator is an agent id can be escrowed on chain", async () => {
    await sb.client.mitra.commerce.createAgreement({
      spaceId: "space_sandbox",
      draft: {
        agreementId: "sb_f96", runId: "run_sb_f96", intentId: "intent_sb_f96",
        client: sb.client.agentId, provider: sb.provider.agentId, evaluator: "sandbox_provider",
        price: { asset: "USDC", amount: 5 }, deadline: new Date(Date.now() + 86_400_000).toISOString(),
        payTo: { chain: "base", address: sb.provider.account.address },
      },
      proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } },
    });
    await sb.chain.transferToken(sb.client.account, sb.chain.escrow, units(5));
    const ref = { chain: "local", contractAddress: sb.client.account.address, jobId: (await import("@/lib/commerce/onchain-escrow")).escrowIdFor("sb_f96"), timeout: (await sb.clock.now()) + 7200 };
    const funded = await sb.client.mitra.commerce.fund("sb_f96", { onChainEscrow: ref });
    expect(funded.agreement.status).toBe("FUNDED");
  }, 60_000);

  it("F97: a refund op on an escrowed agreement refunds the escrow, so Mitra and the chain agree", async () => {
    await sb.openAgreement({ agreementId: "sb_f97_split", price: 20 });
    await sb.fund("sb_f97_split");
    const refunded = await sb.client.mitra.recovery.refundEscrow("sb_f97_split", { failureReason: "CHANGED_MIND" });
    expect(refunded.agreement.status).toBe("REFUNDED");
    expect(await sb.escrowStatus("sb_f97_split")).toBe(ESCROW.REFUNDED);
  }, 60_000);

  it("F97: Mitra notices an escrow's timeout refund without a party telling it", async () => {
    await sb.openAgreement({ agreementId: "sb_f97", provider: "adversary", price: 5, timeoutSeconds: 60 });
    await sb.fund("sb_f97");
    await sb.tick();
    await sb.clock.advanceSeconds(61);
    await sb.keeper.refundTimedOut("sb_f97");
    expect((await sb.client.mitra.commerce.getAgreement("sb_f97")).status).toBe("REFUNDED");
  }, 60_000);
  /**
   * F99 — the sandbox seeds the ROOT of the authority tree (Mandate).
   *
   * It seeded 100,000 USDC and zero Mandates, so every sandbox flow skipped
   * Mandate → Authorization → Intent → Agreement and went straight to the agreement. Nothing
   * in the sandbox ever had to prove that a spend was AUTHORISED; the root was assumed.
   *
   * Read back through the STORE rather than an HTTP call: there is no `mandates` route or
   * SDK namespace, so "query it as a client" is not reachable today. Saying so is better
   * than adding a public surface to a polish packet, and better than asserting against a
   * client that cannot.
   */
  it("seeds an ACTIVE mandate for the client, readable back from the store", async () => {
    expect(sb.mandates.length).toBeGreaterThan(0);
    const mandate = sb.mandates[0];
    expect(mandate.status).toBe("ACTIVE");
    expect(mandate.agentId).toBe(sb.client.agentId);
    expect(mandate.asset).toBe("USDC");

    const { repo } = await getStore();
    const stored = await repo.getMandate(mandate.mandateId);
    expect(stored, "persisted, not merely returned").toMatchObject({ mandateId: mandate.mandateId });
  });

  it("carries the fields the spend guards read, not just an id", async () => {
    // A mandate with no ceiling would make every guard pass VACUOUSLY, which is the failure
    // mode this seeding exists to catch.
    const m = sb.mandates[0];
    expect(m.maxTransaction).toBeGreaterThan(0);
    expect(m.budget).toBeGreaterThan(0);
    expect(m.approvedChains.length).toBeGreaterThan(0);
    expect(m.allowedCapabilities.length).toBeGreaterThan(0);
    expect(Date.parse(m.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("its ceiling exceeds the sandbox's largest agreement, so guards pass rather than block", async () => {
    // A too-small mandate would make every sandbox agreement fail at the ceiling, which
    // would read as a product bug rather than as a fixture sized wrong.
    expect(sb.mandates[0].maxTransaction).toBeGreaterThan(100);
  });

  it("is listed by the repository alongside the seeded fixtures", async () => {
    const { repo } = await getStore();
    const listed = await repo.listMandates();
    expect(listed.map((m) => m.mandateId)).toContain(sb.mandates[0].mandateId);
  });
});
