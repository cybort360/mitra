/**
 * PP-5: the developer SDK (PRD §20) against the real route handlers.
 *
 * Every call goes through `routeFetch`, which serves the app/api/v1 route modules
 * in-process: the SDK's requests are parsed, signature-checked and applied by the
 * same code a deployment runs. The only secret any party holds is its wallet key,
 * and no test below builds a typed-data message, a body hash or an `auth` envelope
 * itself: that is the boilerplate the SDK exists to remove.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MitraApiError, MitraClient } from "@/lib/sdk";
import { prohibitedDirectTools } from "@/lib/mcp/surface";
import { bindTestParties, goodProposal, prepareStore, TEST_PARTIES, type TestParty } from "./fixtures";
import { ROUTE_BASE_URL, routeFetch } from "./route-fetch";

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

const BASE_SEPOLIA = 84532;
const client = (agentId: TestParty, fetchImpl: typeof fetch = routeFetch) =>
  new MitraClient({ baseUrl: ROUTE_BASE_URL, signer: TEST_PARTIES[agentId], chainId: BASE_SEPOLIA, agentId, fetch: fetchImpl });

const buyer = () => client("agent_buyer_07");
const provider = () => client("agent_data_03");
const evaluator = () => client("agent_eval_02");

async function openAgreement(agreementId: string) {
  return buyer().commerce.createAgreement({
    spaceId: "space_research_1",
    draft: {
      agreementId, runId: `run_${agreementId}`, intentId: `intent_${agreementId}`,
      client: "agent_buyer_07", provider: "agent_data_03", evaluator: "agent_eval_02",
      price: { asset: "USDC", amount: 15 }, deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["report covers 100 companies"],
    },
    proposal: { capability: "research", amount: { asset: "USDC", amount: 15 } },
  });
}

describe("mitra.commerce: a full agreement lifecycle with no signing code in the caller", () => {
  it("open → fund → startExecution → submitDeliverable → acceptDeliverable, each signed by its own party", async () => {
    const opened = await openAgreement("ag_sdk_1");
    expect(opened.agreement.status).toBe("OPEN");
    expect(opened.agreement.availableOps).toContain("fund");

    const funded = await buyer().commerce.fund("ag_sdk_1");
    expect(funded.agreement.status).toBe("FUNDED");
    expect(funded.saga?.status).toBe("ARMED");

    expect((await provider().commerce.startExecution("ag_sdk_1")).agreement.status).toBe("EXECUTING");
    const submitted = await provider().commerce.submitDeliverable("ag_sdk_1", {
      artifactRefs: ["ipfs://report"], contentHash: "sha256:abcd",
    });
    expect(submitted.agreement.status).toBe("SUBMITTED");

    const accepted = await evaluator().commerce.acceptDeliverable("ag_sdk_1");
    expect(accepted.agreement.status).toBe("ACCEPTED");
    expect((await buyer().commerce.getAgreement("ag_sdk_1")).status).toBe("ACCEPTED");
  });

  it("rejection leaves a saga that mitra.recovery can read", async () => {
    await openAgreement("ag_sdk_2");
    await buyer().commerce.fund("ag_sdk_2");
    await provider().commerce.startExecution("ag_sdk_2");
    await provider().commerce.submitDeliverable("ag_sdk_2", { artifactRefs: ["ipfs://bad"], contentHash: "sha256:bad" });
    const rejected = await evaluator().commerce.rejectDeliverable("ag_sdk_2", { failureReason: "POISONED_OUTPUT" });
    expect(rejected.agreement.status).toBe("REJECTED");

    const sagaId = rejected.agreement.sagaIds?.[0];
    expect(sagaId).toBeTruthy();
    const saga = await buyer().recovery.getSaga(sagaId!);
    expect(saga.sagaId).toBe(sagaId);
    expect((await buyer().recovery.listSagas({ runId: "run_ag_sdk_2" })).map((s) => s.sagaId)).toContain(sagaId);
  });

  it("refundEscrow is the signed agreement refund op, not a transfer the caller describes", async () => {
    await openAgreement("ag_sdk_3");
    await buyer().commerce.fund("ag_sdk_3");
    const sent: unknown[] = [];
    const spy: typeof fetch = async (input, init) => {
      if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
      return routeFetch(input, init);
    };
    const refunded = await client("agent_buyer_07", spy).recovery.refundEscrow("ag_sdk_3", { failureReason: "BUYER_CANCELLED" });
    expect(refunded.agreement.status).toBe("REFUNDED");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: "refund", agreementId: "ag_sdk_3", failureReason: "BUYER_CANCELLED" });
    // No route, address, amount or calldata travels with it: the kernel derives
    // the compensation from what was committed at fund (PRD §15.5).
    expect(Object.keys(sent[0] as object).sort()).toEqual(["agreementId", "auth", "failureReason", "op"]);
  });
});

describe("mitra.commerce intents", () => {
  it("creates an intent and reads it back; a different body under the same id is refused", async () => {
    const draft = {
      intentId: "intent_sdk_1", runId: "run_sdk_i1", principal: "org:sdk", initiatingAgentId: "agent_buyer_07",
      mandateId: "mandate_research_public_v7", objective: "Research 100 crypto companies",
      budget: { asset: "USDC" as const, amount: 50 }, constraints: [], expiresAt: "2027-01-01T00:00:00Z",
    };
    expect((await buyer().commerce.createIntent(draft)).intentId).toBe("intent_sdk_1");
    expect((await buyer().commerce.getIntent("intent_sdk_1")).objective).toBe(draft.objective);
    const clash = await buyer().commerce.createIntent({ ...draft, objective: "something else" }).catch((e) => e);
    expect(clash).toMatchObject({ status: 409 });
  });
});

describe("signing: what the SDK signs is exactly what the server verifies", () => {
  it("signs against the agreement's current status and the body it sends", async () => {
    await openAgreement("ag_sdk_4");
    const sent: Array<Record<string, any>> = [];
    const spy: typeof fetch = async (input, init) => {
      if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
      return routeFetch(input, init);
    };
    await client("agent_buyer_07", spy).commerce.fund("ag_sdk_4");
    expect(sent[0].auth).toMatchObject({
      actor: "agent_buyer_07", signer: TEST_PARTIES.agent_buyer_07.address, chainId: BASE_SEPOLIA,
    });
    expect(sent[0].auth.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sent[0].auth.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("a field changed after signing is refused: the body hash covers it", async () => {
    await openAgreement("ag_sdk_5");
    await buyer().commerce.fund("ag_sdk_5");
    await provider().commerce.startExecution("ag_sdk_5");
    const tamper: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return routeFetch(input, init);
      const body = JSON.parse(String(init.body));
      return routeFetch(input, { ...init, body: JSON.stringify({ ...body, contentHash: "sha256:swapped" }) });
    };
    const err = await client("agent_data_03", tamper).commerce
      .submitDeliverable("ag_sdk_5", { artifactRefs: ["ipfs://x"], contentHash: "sha256:original" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MitraApiError);
    expect(err.status).toBe(401);
    expect((await buyer().commerce.getAgreement("ag_sdk_5")).status).toBe("EXECUTING");
  });

  it("a party without the role is refused with the API's own reason code", async () => {
    await openAgreement("ag_sdk_6");
    const err = await provider().commerce.fund("ag_sdk_6").catch((e) => e);
    expect(err).toBeInstanceOf(MitraApiError);
    expect(err).toMatchObject({ status: 403, code: "ACTOR_NOT_PERMITTED" });
  });

  it("a key that is not the agent's registered wallet cannot act for it", async () => {
    await openAgreement("ag_sdk_7");
    const impostor = new MitraClient({
      baseUrl: ROUTE_BASE_URL, signer: privateKeyToAccount(generatePrivateKey()),
      chainId: BASE_SEPOLIA, agentId: "agent_buyer_07", fetch: routeFetch,
    });
    const err = await impostor.commerce.fund("ag_sdk_7").catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: "SIGNER_NOT_AGENT_WALLET" });
    expect((await buyer().commerce.getAgreement("ag_sdk_7")).status).toBe("OPEN");
  });

  it("a missing agreement is a typed 404, never a silent success", async () => {
    const err = await buyer().commerce.fund("ag_does_not_exist").catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "AGREEMENT_NOT_FOUND" });
  });
});

describe("mitra.agents", () => {
  it("registers a new agent with a fresh wallet, then reads and finds it", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const newcomer = new MitraClient({ baseUrl: ROUTE_BASE_URL, signer: key, chainId: BASE_SEPOLIA, agentId: "agent_sdk_new", fetch: routeFetch });
    const agent = await newcomer.agents.register({
      name: "SDK newcomer", owner: "org:sdk", capabilities: ["sdk_testing"],
    });
    expect(agent).toMatchObject({ agentId: "agent_sdk_new", status: "REGISTERED", wallets: [{ chain: "base", address: key.address }] });
    expect((await newcomer.agents.getAgent("agent_sdk_new")).agentId).toBe("agent_sdk_new");
    expect((await newcomer.agents.findAgents({ capability: "sdk_testing" })).map((a) => a.agentId)).toEqual(["agent_sdk_new"]);

    const again = await newcomer.agents.register({ name: "dup", owner: "org:sdk" }).catch((e) => e);
    expect(again).toMatchObject({ status: 409, code: "AGENT_EXISTS" });
  });
});

describe("mitra.authority", () => {
  it("returns the policy decision for ALLOW and DENY alike: a DENY is an answer, not a transport error", async () => {
    const allow = await buyer().authority.requestAuthorization(goodProposal);
    expect(allow.decision).toBe("ALLOW");
    const deny = await buyer().authority.requestAuthorization({ ...goodProposal, counterparty: "evil:provider" });
    expect(deny.decision).toBe("DENY");
    expect(deny.reasonCodes).toContain("COUNTERPARTY_NOT_ALLOWED");
  });

  it("reads a Space's headroom, and refuses an unknown Space", async () => {
    const before = await buyer().authority.getHeadroom("space_research_1");
    expect(before).toEqual({ asset: "USDC", amount: 38 });
    await openAgreement("ag_sdk_8");
    await buyer().commerce.fund("ag_sdk_8");
    expect(await buyer().authority.getHeadroom("space_research_1")).toEqual({ asset: "USDC", amount: 23 });
    expect(await buyer().authority.getHeadroom("space_nope").catch((e) => e)).toMatchObject({ status: 404, code: "SPACE_NOT_FOUND" });
  });
});

describe("mitra.clearing", () => {
  it("previews netting and lists residuals without opening or settling an epoch", async () => {
    const preview = await buyer().clearing.requestClearing();
    expect(preview).toHaveProperty("residualVolume");
    const residuals = await buyer().clearing.listResiduals();
    expect(Array.isArray(residuals)).toBe(true);
    expect(await buyer().clearing.getEpoch("epoch_nope").catch((e) => e)).toMatchObject({ status: 404, code: "EPOCH_NOT_FOUND" });
  });
});

describe("the SDK surface carries intent verbs only", () => {
  it("exposes no prohibited capital verb, and no clearing-epoch mutation, in any namespace", () => {
    const sdk = buyer();
    const names = Object.entries(sdk).flatMap(([ns, v]) =>
      v && typeof v === "object" ? Object.keys(v).map((k) => `${ns}.${k}`) : []);
    const flat = names.map((n) => n.split(".")[1].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    for (const verb of prohibitedDirectTools) expect(flat).not.toContain(verb);
    for (const mutation of ["open_epoch", "calculate_epoch", "challenge", "finalize_epoch", "settle"]) {
      expect(flat).not.toContain(mutation);
    }
    expect(names.sort()).toEqual([
      "agents.findAgents", "agents.getAgent", "agents.register",
      "authority.getHeadroom", "authority.requestAuthorization",
      "clearing.getEpoch", "clearing.listEpochs", "clearing.listResiduals", "clearing.requestClearing",
      "commerce.acceptDeliverable", "commerce.createAgreement", "commerce.createIntent", "commerce.fund",
      "commerce.getAgreement", "commerce.getIntent", "commerce.listAgreements", "commerce.rejectDeliverable",
      "commerce.startExecution", "commerce.submitDeliverable",
      "inbox.list",
      "recovery.getSaga", "recovery.listSagas", "recovery.refundEscrow",
    ]);
  });
});
