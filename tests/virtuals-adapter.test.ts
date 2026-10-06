/**
 * PP-2: the Virtuals ACP adapter, against the marketplace's real data.
 *
 * Every agent and offering here comes from tests/fixtures-data/virtuals-acp-agents.json,
 * recorded from https://acpx.virtuals.gg on 2026-10-06. Where a test needs a
 * shape the recording does not contain (a percentage price, say), it derives it
 * from a recorded offering with one field changed, and says which.
 *
 * The live check (`VIRTUALS_LIVE=1`) runs the same verifier over whatever the
 * marketplace lists today.
 */
import { beforeEach, describe, expect, it } from "vitest";
import recorded from "./fixtures-data/virtuals-acp-agents.json";
import {
  ACP_NETWORKS, AcpJobPhase, acpPhaseToAgreementStatus, acpRefs, agreementToAcpJob, attestCounterparty, checkRequirement,
  gigToAgreementDraft, gigToIntent, reachedEvaluation, verifyAcpJob, verifyQuote,
  type AcpApiAgent, type AcpApiJob, type VirtualsGig, type VirtualsQuote,
} from "@/lib/adapters/virtuals";
import { POST as createIntent } from "@/app/api/v1/intents/route";
import { GET as getIntent } from "@/app/api/v1/intents/[id]/route";
import { GET as getAgreements, POST as postAgreement } from "@/app/api/v1/agreements/route";
import { POST as createSpace } from "@/app/api/v1/spaces/route";
import { prepareStore, req } from "./fixtures";

const AGENTS = recorded.data as unknown as AcpApiAgent[];
const blue = AGENTS.find((a) => a.name === "blue")!;                    // ACP v1 contract, fixed 0.01, no schema
const predictor = AGENTS.find((a) => a.name === "predictor-sam")!;     // ACP v2 contract, JSON-Schema requirements
const SEPOLIA = 84532;
const NOW = Date.parse("2026-10-06T00:00:00Z");
const EXPIRES = "2026-10-07T00:00:00.000Z";

const quoteOf = (agent: AcpApiAgent, offering: string, chainId = SEPOLIA): VirtualsQuote => {
  const q = verifyQuote(chainId, agent, offering);
  if (!q.ok) throw new Error(q.reason);
  return q.value;
};
/** A recorded offering with fields overridden, for shapes the recording lacks. */
const withOffering = (agent: AcpApiAgent, name: string, over: Record<string, unknown>): AcpApiAgent =>
  ({ ...agent, jobs: agent.jobs.map((j) => (j.name === name ? { ...j, ...over } : j)) });
const refusal = (r: { ok: boolean; reason?: string }) => (r.ok ? "OK" : r.reason);

describe("verifyQuote: a recorded ACP offering becomes a bounded quote", () => {
  it("prices blue's 'provide market alpha' at 0.01 USDC = 10000 base units of Base Sepolia's fare token", () => {
    const q = quoteOf(blue, "provide market alpha");
    expect(q).toMatchObject({
      chainId: 84532, acpContract: "0x8Db6B1c839Fc8f6bd35777E194677B67b4D51928",
      providerWallet: "0x67768f90d188992AfE2FD8705d4855d454b22cB9", providerAcpId: "176",
      price: { asset: "USDC", amount: 0.01 }, priceBaseUnits: "10000",
      fareToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", slaMinutes: 30,
    });
    expect(q.requirementSchema).toBeUndefined();
    expect(q.quoteDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("recognises the ACP v2 contract too, and keeps the offering's JSON-Schema requirement", () => {
    // Recorded predictor-sam offerings all set requiredFunds; cleared here to reach the schema.
    const q = quoteOf(withOffering(predictor, "close_bet", { requiredFunds: false }), "close_bet");
    expect(q.acpContract).toBe("0xdf54E6Ed6cD1d0632d973ADECf96597b7e87893c");
    expect(q.requirementSchema).toMatchObject({ required: ["marketId"] });
    expect(q.deliverableSpec).toBe("close bet confirmation");
  });

  it("refuses every recorded predictor-sam offering as it is listed: each requires a funds transfer beyond the price", () => {
    for (const j of predictor.jobs) expect(refusal(verifyQuote(SEPOLIA, predictor, j.name)), j.name).toBe("REQUIRES_FUNDS_TRANSFER");
  });

  it("the digest binds the terms: any changed term is a different quote", () => {
    const base = quoteOf(blue, "provide market alpha").quoteDigest;
    expect(quoteOf(withOffering(blue, "provide market alpha", { priceV2: { type: "fixed", value: 0.02 } }), "provide market alpha").quoteDigest).not.toBe(base);
    expect(quoteOf(withOffering(blue, "provide market alpha", { slaMinutes: 31 }), "provide market alpha").quoteDigest).not.toBe(base);
    expect(quoteOf({ ...blue, walletAddress: predictor.walletAddress }, "provide market alpha").quoteDigest).not.toBe(base);
  });

  describe("malformed pricing is refused, not rounded or defaulted", () => {
    const priced = (over: Record<string, unknown>) => refusal(verifyQuote(SEPOLIA, withOffering(blue, "provide market alpha", over), "provide market alpha"));
    it.each([
      [{ priceV2: { type: "percentage", value: 0.05 } }, "PRICE_TYPE_UNSUPPORTED"],
      [{ priceV2: { type: "subscription", value: 10 } }, "PRICE_TYPE_UNSUPPORTED"],
      [{ priceV2: { type: "fixed", value: 0 } }, "PRICE_INVALID"],
      [{ priceV2: { type: "fixed", value: -1 } }, "PRICE_INVALID"],
      [{ priceV2: { type: "fixed", value: Number.NaN } }, "PRICE_INVALID"],
      [{ priceV2: { type: "fixed", value: Number.POSITIVE_INFINITY } }, "PRICE_INVALID"],
      [{ priceV2: undefined, price: undefined }, "PRICE_INVALID"],
      [{ priceV2: { type: "fixed", value: "0.01" } }, "PRICE_INVALID"],
      [{ priceV2: { type: "fixed", value: 0.0000001 } }, "PRICE_PRECISION_EXCEEDS_TOKEN"],
      [{ priceV2: { type: "fixed", value: 1.0000005 } }, "PRICE_PRECISION_EXCEEDS_TOKEN"],
      [{ slaMinutes: 0 }, "SLA_INVALID"],
      [{ slaMinutes: 2.5 }, "SLA_INVALID"],
    ])("%j → %s", (over, reason) => expect(priced(over)).toBe(reason));

    it("falls back to the legacy fixed `price` only when priceV2 is absent, as the ACP SDK does", () => {
      expect(priced({ priceV2: undefined, price: 0.5 })).toBe("OK");
    });
  });

  describe("missing or unrecognised identifiers are refused", () => {
    it.each([
      [{ id: undefined }, "MISSING_AGENT_IDENTIFIER"],
      [{ id: "" }, "MISSING_AGENT_IDENTIFIER"],
      [{ walletAddress: "" }, "MISSING_AGENT_IDENTIFIER"],
      [{ walletAddress: "0x1234" }, "AGENT_WALLET_INVALID"],
      [{ walletAddress: "not-an-address" }, "AGENT_WALLET_INVALID"],
      [{ contractAddress: "0x0000000000000000000000000000000000000001" }, "ACP_CONTRACT_NOT_RECOGNIZED"],
      [{ contractAddress: "" }, "ACP_CONTRACT_NOT_RECOGNIZED"],
    ])("%j → %s", (over, reason) => expect(refusal(verifyQuote(SEPOLIA, { ...blue, ...over } as AcpApiAgent, "provide market alpha"))).toBe(reason));

    it("an unknown offering, an unknown network, and a Sepolia agent quoted as mainnet", () => {
      expect(refusal(verifyQuote(SEPOLIA, blue, "no such offering"))).toBe("OFFERING_NOT_FOUND");
      expect(refusal(verifyQuote(1, blue, "provide market alpha"))).toBe("ACP_NETWORK_UNKNOWN");
      expect(refusal(verifyQuote(8453, blue, "provide market alpha")), "the v1 Sepolia contract is not mainnet's").toBe("ACP_CONTRACT_NOT_RECOGNIZED");
    });
  });
});

describe("checkRequirement: a pre-flight against the offering's own schema", () => {
  const q = () => quoteOf(withOffering(predictor, "place_bet", { requiredFunds: false }), "place_bet");
  it("accepts a requirement with every required field at its declared type", () => {
    expect(checkRequirement(q(), { marketId: "m1", outcome: "YES", token: "USDC", amount: 5 })).toEqual({ ok: true, value: true });
  });
  it.each([
    [{ outcome: "YES", token: "USDC", amount: 5 }, "REQUIREMENT_MISSING_FIELD:marketId"],
    [{ marketId: "m1", outcome: "YES", token: "USDC", amount: "5" }, "REQUIREMENT_TYPE_MISMATCH:amount"],
    ["place a bet", "REQUIREMENT_NOT_AN_OBJECT"],
    [["m1"], "REQUIREMENT_NOT_AN_OBJECT"],
  ])("%j → %s", (r, reason) => expect(refusal(checkRequirement(q(), r))).toBe(reason));
  it("an offering with no schema takes any requirement (ACP's own validation applies at initiation)", () => {
    expect(checkRequirement(quoteOf(blue, "provide market alpha"), "anything").ok).toBe(true);
  });
});

describe("two-way: an ACP gig ⇄ a Mitra agreement", () => {
  const gig = (over: Partial<VirtualsGig> = {}): VirtualsGig => ({
    quote: quoteOf(blue, "provide market alpha"), requirement: { topic: "ETH funding rates" }, expiredAt: EXPIRES, ...over,
  });
  const ids = { agreementId: "ag_v_1", runId: "run_v_1", intentId: "intent_v_1", client: "agent_buyer_07",
    provider: "virtuals_blue", evaluator: "agent_eval_02", capability: "research" };

  it("gig → agreement → ACP job request recovers the same job, priced in the fare token's base units", () => {
    const g = gig({ evaluatorAddress: "0x67768f90d188992afe2fd8705d4855d454b22cb9" });
    const args = gigToAgreementDraft(g, ids, NOW);
    expect(args.ok, refusal(args)).toBe(true);
    if (!args.ok) return;
    expect(args.value.draft).toMatchObject({
      price: { asset: "USDC", amount: 0.01 }, deadline: EXPIRES,
      payTo: { chain: "base", address: "0x67768f90d188992AfE2FD8705d4855d454b22cB9" },
      externalJobRefs: acpRefs(g),
    });
    expect(args.value.proposal).toEqual({ capability: "research", amount: { asset: "USDC", amount: 0.01 } });
    const job = agreementToAcpJob(args.value.draft, g);
    expect(job).toEqual({ ok: true, value: {
      chainId: 84532, acpContract: "0x8Db6B1c839Fc8f6bd35777E194677B67b4D51928",
      providerAddress: "0x67768f90d188992AfE2FD8705d4855d454b22cB9", offeringName: "provide market alpha",
      requirement: { topic: "ETH funding rates" }, evaluatorAddress: "0x67768f90d188992AfE2FD8705d4855d454b22cB9",
      expiredAt: EXPIRES, fare: { token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amountBaseUnits: "10000" },
    } });
  });

  it("an agreement that drifted from its quote does not become an ACP job", () => {
    const g = gig();
    const args = gigToAgreementDraft(g, ids, NOW);
    if (!args.ok) throw new Error(args.reason);
    const d = args.value.draft;
    expect(refusal(agreementToAcpJob({ ...d, price: { asset: "USDC", amount: 0.02 } }, g))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:PRICE");
    expect(refusal(agreementToAcpJob({ ...d, price: { asset: "USDT", amount: 0.01 } }, g))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:PRICE");
    expect(refusal(agreementToAcpJob({ ...d, payTo: { chain: "base", address: predictor.walletAddress } }, g))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:PAYEE");
    expect(refusal(agreementToAcpJob({ ...d, payTo: { chain: "tempo", address: d.payTo.address } }, g))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:PAYEE");
    expect(refusal(agreementToAcpJob({ ...d, externalJobRefs: [] }, g))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:REF");
    // The same agreement, presented with a different requirement than was hashed into it.
    expect(refusal(agreementToAcpJob(d, { ...g, requirement: { topic: "something else" } }))).toBe("AGREEMENT_DIVERGES_FROM_QUOTE:REF");
  });

  it("refuses a gig that is malformed before anything is recorded for it", () => {
    const schemaQuote = quoteOf(withOffering(predictor, "close_bet", { requiredFunds: false }), "close_bet");
    const ctx = { runId: "r", principal: "Mitra Labs", initiatingAgentId: "agent_buyer_07", mandateId: "m" };
    expect(refusal(gigToIntent(gig({ expiredAt: "2026-10-05T00:00:00Z" }), ctx, NOW))).toBe("EXPIRY_IN_PAST");
    expect(refusal(gigToIntent(gig({ expiredAt: "tomorrow" }), ctx, NOW))).toBe("EXPIRY_INVALID");
    expect(refusal(gigToIntent(gig({ evaluatorAddress: "0xnope" as `0x${string}` }), ctx, NOW))).toBe("EVALUATOR_WALLET_INVALID");
    expect(refusal(gigToIntent(gig({ quote: schemaQuote, requirement: {} }), ctx, NOW))).toBe("REQUIREMENT_MISSING_FIELD:marketId");
    expect(refusal(gigToAgreementDraft(gig({ quote: schemaQuote, requirement: {} }), ids, NOW))).toBe("REQUIREMENT_MISSING_FIELD:marketId");
  });

  it("a mainnet ACP quote is recognised but never becomes a settleable agreement", () => {
    const mainnetBlue = { ...blue, contractAddress: ACP_NETWORKS[8453].contracts[1] };
    const q = quoteOf(mainnetBlue, "provide market alpha", 8453);
    expect(q.fareToken).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(refusal(gigToAgreementDraft(gig({ quote: q }), ids, NOW))).toBe("ACP_NETWORK_NOT_SETTLEABLE");
  });
});

describe("through the real routes: the intent and agreement a gig becomes", () => {
  beforeEach(async () => { await prepareStore(); });

  it("records the intent and opens the agreement with its ACP refs intact", async () => {
    const g: VirtualsGig = { quote: quoteOf(blue, "provide market alpha"), requirement: { topic: "ETH funding rates" },
      expiredAt: new Date(Date.now() + 86_400_000).toISOString() };
    const intentBody = gigToIntent(g, { runId: "run_virtuals", principal: "Mitra Labs", initiatingAgentId: "agent_buyer_07", mandateId: "mandate_research_public_v7" });
    if (!intentBody.ok) throw new Error(intentBody.reason);
    const created = await createIntent(req(intentBody.value));
    expect(created.status).toBe(201);
    const { intentId } = (await created.json()).data;
    const stored = (await (await getIntent(new Request("http://x"), { params: Promise.resolve({ id: intentId }) })).json()).data;
    expect(stored.constraints).toEqual(expect.arrayContaining(acpRefs(g)));
    expect(stored.budget).toEqual({ asset: "USDC", amount: 0.01 });

    const space = await createSpace(req({ spaceId: "space_virtuals", owner: "agent_buyer_07", participants: ["agent_buyer_07"],
      allowedCapabilities: ["research", "payment"], settlementChains: ["base"], budget: { asset: "USDC", amount: 10 } }));
    expect(space.status, await space.clone().text()).toBe(201);
    const args = gigToAgreementDraft(g, { agreementId: "ag_virtuals", runId: "run_virtuals", intentId, client: "agent_buyer_07",
      provider: "virtuals_blue", evaluator: "agent_eval_02", capability: "research" });
    if (!args.ok) throw new Error(args.reason);
    const opened = await postAgreement(req({ op: "open", spaceId: "space_virtuals", ...args.value }));
    expect(opened.status, await opened.clone().text()).toBe(201);
    const back = (await (await getAgreements(new Request("http://x/api/v1/agreements?agreementId=ag_virtuals"))).json()).data;
    expect(back).toMatchObject({ status: "OPEN", intentId, payTo: { chain: "base", address: blue.walletAddress } });
    expect(back.externalJobRefs, "PRD §8.4: the external job identity is never discarded").toEqual(acpRefs(g));
  });
});

describe("counterparty attestation: the ACP provider is the registered Mitra agent", () => {
  const q = () => quoteOf(blue, "provide market alpha");
  const agent = (wallets: Array<{ chain: "base" | "solana" | "tempo"; address: string }>, status = "REGISTERED") =>
    ({ agentId: "virtuals_blue", status, wallets }) as Parameters<typeof attestCounterparty>[1];

  it("attests when the listed wallet is one the agent registered on the settling rail (any case)", () => {
    expect(attestCounterparty(q(), agent([{ chain: "base", address: blue.walletAddress.toLowerCase() }])).ok).toBe(true);
  });
  it.each([
    ["another wallet", agent([{ chain: "base", address: predictor.walletAddress }]), "COUNTERPARTY_NOT_ATTESTED"],
    ["the wallet, on another rail", agent([{ chain: "tempo", address: blue.walletAddress }]), "COUNTERPARTY_NOT_ATTESTED"],
    ["no wallets", agent([]), "COUNTERPARTY_NOT_ATTESTED"],
    ["a suspended agent", agent([{ chain: "base", address: blue.walletAddress }], "SUSPENDED"), "COUNTERPARTY_INACTIVE"],
    ["a revoked agent", agent([{ chain: "base", address: blue.walletAddress }], "REVOKED"), "COUNTERPARTY_INACTIVE"],
  ])("refuses %s", (_label, a, reason) => expect(refusal(attestCounterparty(q(), a))).toBe(reason));
});

describe("an observed ACP job, checked against its quote", () => {
  const q = () => quoteOf(blue, "provide market alpha");
  const job = (over: Partial<AcpApiJob> = {}): AcpApiJob => ({
    id: 4242, clientAddress: "0x1111111111111111111111111111111111111111", providerAddress: blue.walletAddress,
    evaluatorAddress: "0x1111111111111111111111111111111111111111", price: 0.01,
    priceTokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", phase: AcpJobPhase.TRANSACTION,
    contractAddress: blue.contractAddress, ...over,
  });
  it("matches", () => expect(verifyAcpJob(job(), q()).ok).toBe(true));
  it.each([
    [{ priceTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, "UNMAPPED_TOKEN"], // mainnet USDC on a Sepolia job
    [{ priceTokenAddress: "0x4200000000000000000000000000000000000006" }, "UNMAPPED_TOKEN"], // WETH
    [{ providerAddress: predictor.walletAddress }, "PROVIDER_MISMATCH"],
    [{ price: 0.02 }, "PRICE_MISMATCH"],
    [{ contractAddress: ACP_NETWORKS[84532].contracts[1] }, "ACP_CONTRACT_MISMATCH"],
  ])("%j → %s", (over, reason) => expect(refusal(verifyAcpJob(job(over), q()))).toBe(reason));
});

describe("ACP phases as Mitra agreement statuses", () => {
  it.each([
    [AcpJobPhase.REQUEST, false, "OPEN"], [AcpJobPhase.NEGOTIATION, false, "OPEN"], [AcpJobPhase.TRANSACTION, false, "EXECUTING"],
    [AcpJobPhase.EVALUATION, true, "SUBMITTED"], [AcpJobPhase.COMPLETED, true, "ACCEPTED"],
    [AcpJobPhase.REJECTED, true, "REJECTED"], [AcpJobPhase.REJECTED, false, "CANCELED"],
    [AcpJobPhase.EXPIRED, false, "EXPIRED"], [7, false, null], [-1, false, null],
  ])("phase %i (reached evaluation: %s) → %s", (phase, reached, status) =>
    expect(acpPhaseToAgreementStatus(phase, { reachedEvaluation: reached })).toBe(status));

  it("reads 'reached evaluation' from the memo history, so a rejected deliverable is told apart from a declined request", () => {
    expect(reachedEvaluation({ phase: AcpJobPhase.REJECTED, memos: [{ nextPhase: 1 }, { nextPhase: 2 }, { nextPhase: 3 }, { nextPhase: 5 }] })).toBe(true);
    expect(reachedEvaluation({ phase: AcpJobPhase.REJECTED, memos: [{ nextPhase: 1 }, { nextPhase: 5 }] })).toBe(false);
    expect(reachedEvaluation({ phase: AcpJobPhase.REJECTED })).toBe(false);
  });
});

/**
 *   VIRTUALS_LIVE=1 npx vitest run tests/virtuals-adapter.test.ts -t live
 */
describe.skipIf(!process.env.VIRTUALS_LIVE)("live: the verifier over the marketplace's listing today", () => {
  it("every listed offering on Base Sepolia either quotes or is refused for a named reason", async () => {
    const known = new Set(["OK", "PRICE_TYPE_UNSUPPORTED", "PRICE_INVALID", "PRICE_PRECISION_EXCEEDS_TOKEN", "REQUIRES_FUNDS_TRANSFER",
      "SLA_INVALID", "ACP_CONTRACT_NOT_RECOGNIZED", "AGENT_WALLET_INVALID", "MISSING_AGENT_IDENTIFIER"]);
    const tally: Record<string, number> = {};
    let agents = 0;
    for (const kw of ["research", "data", "analysis", "trading", "market"]) {
      const res = await fetch(`${ACP_NETWORKS[84532].api}/api/agents/v4/search?search=${kw}&top_k=10`);
      expect(res.ok, `acpx ${res.status}`).toBe(true);
      for (const a of ((await res.json()).data ?? []) as AcpApiAgent[]) {
        agents++;
        for (const j of a.jobs ?? []) {
          const r = refusal(verifyQuote(84532, a, j.name))!;
          tally[r] = (tally[r] ?? 0) + 1;
          expect(known.has(r), `${a.name}/${j.name}: ${r}`).toBe(true);
        }
      }
    }
    console.log(`virtuals live (${ACP_NETWORKS[84532].api}): ${agents} agents, offerings by verdict ${JSON.stringify(tally)}`);
    expect(tally.OK ?? 0, "at least one real offering quotes").toBeGreaterThan(0);
  }, 60_000);
});
