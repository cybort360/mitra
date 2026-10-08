/**
 * PP-6: the agent inbox, over the real routes.
 *
 * The agreements in it are driven to their states by real signed transitions
 * through the SDK (tests/route-fetch.ts serves the route modules in-process), so
 * the inbox is checked against what the API produced, not hand-built fixtures.
 * Provider and evaluator are agents registered here with fresh keys, so seeded
 * agreements cannot leak into the inboxes under test.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MitraClient } from "@/lib/sdk";
import { buildInbox, RECEIPT_LIMIT } from "@/lib/inbox";
import type { Agreement, Settlement } from "@/lib/domain/types";
import { GET as inboxByQuery } from "@/app/api/v1/inbox/route";
import { GET as inboxByPath } from "@/app/api/v1/inbox/[agentId]/route";
import { bindTestParties, prepareStore, TEST_PARTIES } from "./fixtures";
import { ROUTE_BASE_URL, routeFetch } from "./route-fetch";

const BASE_SEPOLIA = 84532;
const sdk = (agentId: string, signer = privateKeyToAccount(generatePrivateKey())) =>
  new MitraClient({ baseUrl: ROUTE_BASE_URL, signer, chainId: BASE_SEPOLIA, agentId, fetch: routeFetch });

let buyer: MitraClient;
let provider: MitraClient;
let evaluator: MitraClient;
let providerWallet: `0x${string}`;

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
  buyer = sdk("agent_buyer_07", TEST_PARTIES.agent_buyer_07);
  const providerKey = privateKeyToAccount(generatePrivateKey());
  providerWallet = providerKey.address;
  provider = sdk("agent_inbox_provider", providerKey);
  evaluator = sdk("agent_inbox_evaluator");
  await provider.agents.register({ name: "Inbox provider", owner: "org:test", capabilities: ["research"] });
  await evaluator.agents.register({ name: "Inbox evaluator", owner: "org:test", capabilities: ["deliverable_evaluation"] });
});

async function agreementAt(agreementId: string, deadline: string, target: "OPEN" | "FUNDED" | "EXECUTING" | "SUBMITTED" | "ACCEPTED") {
  await buyer.commerce.createAgreement({
    spaceId: "space_research_1",
    draft: {
      agreementId, runId: `run_${agreementId}`, intentId: `intent_${agreementId}`,
      client: "agent_buyer_07", provider: "agent_inbox_provider", evaluator: "agent_inbox_evaluator",
      price: { asset: "USDC", amount: 2 }, deadline, acceptanceCriteria: ["delivered"],
    },
    proposal: { capability: "research", amount: { asset: "USDC", amount: 2 } },
  });
  if (target === "OPEN") return;
  await buyer.commerce.fund(agreementId);
  if (target === "FUNDED") return;
  await provider.commerce.startExecution(agreementId);
  if (target === "EXECUTING") return;
  await provider.commerce.submitDeliverable(agreementId, { artifactRefs: ["ipfs://r"], contentHash: "sha256:r" });
  if (target === "SUBMITTED") return;
  await evaluator.commerce.acceptDeliverable(agreementId);
}

async function seedPortfolio() {
  await agreementAt("ag_in_open", "2027-03-01T00:00:00Z", "OPEN");
  // Deadline order disagrees with id order, so a sort that ignored deadlines would show.
  await agreementAt("ag_in_funded", "2027-01-12T00:00:00Z", "FUNDED");
  await agreementAt("ag_in_exec", "2027-02-01T00:00:00Z", "EXECUTING");
  await agreementAt("ag_in_sub", "2027-01-20T00:00:00Z", "SUBMITTED");
  await agreementAt("ag_in_done", "2027-01-10T00:00:00Z", "ACCEPTED");
}

describe("GET /api/v1/inbox/{agentId}", () => {
  it("gives the provider its work, soonest deadline first, then proposals; nothing it cannot act on", async () => {
    await seedPortfolio();
    const inbox = await provider.inbox.list();
    expect(inbox.agentId).toBe("agent_inbox_provider");
    expect(inbox.items.map((i) => [i.kind, "agreementId" in i ? i.agreementId : null, "actions" in i ? i.actions : null])).toEqual([
      ["WORK_REQUIRED", "ag_in_funded", ["startExecution"]],
      ["WORK_REQUIRED", "ag_in_exec", ["submitDeliverable"]],
      ["INBOUND_PROPOSAL", "ag_in_open", []],
    ]);
    expect(inbox.counts).toEqual({ WORK_REQUIRED: 2, EVALUATION_REQUIRED: 0, INBOUND_PROPOSAL: 1, SETTLEMENT_RECEIPT: 0 });
  });

  it("gives the evaluator, and the client, the submitted deliverable to judge", async () => {
    await seedPortfolio();
    const judged = await evaluator.inbox.list();
    expect(judged.items).toHaveLength(1);
    expect(judged.items[0]).toMatchObject({
      kind: "EVALUATION_REQUIRED", agreementId: "ag_in_sub", role: "evaluator", status: "SUBMITTED",
      actions: ["acceptDeliverable", "rejectDeliverable"], acceptanceCriteria: ["delivered"], overdue: false,
    });
    // AGREEMENT_OP_ROLES lets the client accept or reject too. Refund is never an inbox action.
    const client = await buyer.inbox.list({ kinds: ["EVALUATION_REQUIRED", "WORK_REQUIRED"] });
    const mine = client.items.filter((i) => "agreementId" in i && i.agreementId?.startsWith("ag_in_"));
    expect(mine).toEqual([expect.objectContaining({ agreementId: "ag_in_sub", role: "client", actions: ["acceptDeliverable", "rejectDeliverable"] })]);
  });

  it("every action it offers is one the API then accepts from that agent", async () => {
    await seedPortfolio();
    for (const item of (await provider.inbox.list({ kinds: ["WORK_REQUIRED"] })).items) {
      if (item.kind !== "WORK_REQUIRED") continue;
      const op = item.actions[0];
      const result = op === "startExecution"
        ? await provider.commerce.startExecution(item.agreementId)
        : await provider.commerce.submitDeliverable(item.agreementId, { artifactRefs: ["ipfs://x"], contentHash: "sha256:x" });
      expect(result.agreement.status).not.toBe(item.status);
    }
    // Both moved on: one to EXECUTING (still work), one to SUBMITTED (no longer the provider's).
    expect((await provider.inbox.list({ kinds: ["WORK_REQUIRED"] })).items.map((i) => "actions" in i && i.actions))
      .toEqual([["submitDeliverable"]]);
  });

  it("filters by kind, and refuses an unknown kind", async () => {
    await seedPortfolio();
    const proposals = await provider.inbox.list({ kinds: ["INBOUND_PROPOSAL"] });
    expect(proposals.items.map((i) => i.kind)).toEqual(["INBOUND_PROPOSAL"]);
    const res = await inboxByPath(new Request(`${ROUTE_BASE_URL}/api/v1/inbox/agent_inbox_provider?kind=WORK_REQUIRED,BOGUS`),
      { params: Promise.resolve({ agentId: "agent_inbox_provider" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "UNKNOWN_INBOX_KIND", unknown: ["BOGUS"] });
  });

  it("an agent with nothing pending gets an empty inbox, not an error", async () => {
    const inbox = await evaluator.inbox.list();
    expect(inbox.items).toEqual([]);
    expect(inbox.counts).toEqual({ WORK_REQUIRED: 0, EVALUATION_REQUIRED: 0, INBOUND_PROPOSAL: 0, SETTLEMENT_RECEIPT: 0 });
  });

  it("an unknown agent is a 404, and the query form needs an agentId", async () => {
    expect(await provider.inbox.list({ agentId: "agent_nobody" }).catch((e) => e)).toMatchObject({ status: 404, code: "AGENT_NOT_FOUND" });
    const res = await inboxByQuery(new Request(`${ROUTE_BASE_URL}/api/v1/inbox`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("AGENT_ID_REQUIRED");
  });

  it("the query form and the path form answer the same", async () => {
    await seedPortfolio();
    const byQuery = await (await inboxByQuery(new Request(`${ROUTE_BASE_URL}/api/v1/inbox?agentId=agent_inbox_provider`))).json();
    const byPath = await (await inboxByPath(new Request(`${ROUTE_BASE_URL}/api/v1/inbox/agent_inbox_provider`),
      { params: Promise.resolve({ agentId: "agent_inbox_provider" }) })).json();
    expect(byQuery.data.items).toEqual(byPath.data.items);
  });
});

describe("SETTLEMENT_RECEIPT", () => {
  async function putSettlement(s: Partial<Settlement> & Pick<Settlement, "settlementId" | "status" | "to">) {
    const { getStore } = await import("@/lib/store/provider");
    const { repo } = await getStore();
    // Test data in the store, the way a settlement route would have left it.
    expect(await repo.claimSettlement({
      obligationIds: [], chain: "base", asset: "USDC", amount: 2, from: "0xpayer",
      submittedAt: "2026-10-01T00:00:00Z", evidenceLevel: "LOCAL_PASS", ...s,
    } as Settlement)).toBe(true);
  }

  it("lists confirmed settlements paying the agent, for its agreements or to its wallet, newest first", async () => {
    await agreementAt("ag_in_done", "2027-01-10T00:00:00Z", "ACCEPTED");
    await putSettlement({ settlementId: "set_agreement", agreementId: "ag_in_done", status: "CONFIRMED", to: "0xelsewhere", confirmedAt: "2026-10-02T00:00:00Z", txHash: "0xaa" });
    await putSettlement({ settlementId: "set_residual", epochId: "epoch_1", status: "CONFIRMED", to: providerWallet.toLowerCase(), confirmedAt: "2026-10-03T00:00:00Z" });
    await putSettlement({ settlementId: "set_pending", agreementId: "ag_in_done", status: "SUBMITTED", to: providerWallet });
    await putSettlement({ settlementId: "set_other", status: "CONFIRMED", to: "0x0000000000000000000000000000000000000001", confirmedAt: "2026-10-04T00:00:00Z" });

    const inbox = await provider.inbox.list({ kinds: ["SETTLEMENT_RECEIPT"] });
    expect(inbox.items.map((i) => i.kind === "SETTLEMENT_RECEIPT" && i.settlementId)).toEqual(["set_residual", "set_agreement"]);
    expect(inbox.items[1]).toMatchObject({ agreementId: "ag_in_done", txHash: "0xaa", at: "2026-10-02T00:00:00Z", priority: 2 });
  });
});

describe("buildInbox (pure)", () => {
  const base: Agreement = {
    agreementId: "a", spaceIds: ["s"], runId: "r", intentId: "i", client: "c", provider: "p", evaluator: "e",
    externalJobRefs: [], price: { asset: "USDC", amount: 1 }, deadline: "2026-10-01T00:00:00Z",
    acceptanceCriteria: [], failurePolicy: "refund", status: "EXECUTING", version: 1,
  } as Agreement;
  const agent = { agentId: "p", wallets: [] };

  it("marks work past its deadline overdue rather than hiding it", () => {
    const inbox = buildInbox({ agent, agreements: [base], settlements: [], now: new Date("2026-10-02T00:00:00Z") });
    expect(inbox.items[0]).toMatchObject({ kind: "WORK_REQUIRED", overdue: true });
  });

  it("terminal and other parties' agreements never appear", () => {
    const agreements = (["ACCEPTED", "REJECTED", "REFUNDED", "CANCELED", "EXPIRED"] as const)
      .map((status, n): Agreement => ({ ...base, agreementId: `t${n}`, status }))
      .concat({ ...base, agreementId: "theirs", provider: "someone_else" });
    expect(buildInbox({ agent, agreements, settlements: [], now: new Date(0) }).items).toEqual([]);
  });

  it("an agent holding two roles is shown in the one it acts in", () => {
    const selfJudged = { ...base, status: "SUBMITTED" as const, evaluator: "p" };
    expect(buildInbox({ agent, agreements: [selfJudged], settlements: [], now: new Date(0) }).items[0])
      .toMatchObject({ kind: "EVALUATION_REQUIRED", role: "evaluator" });
  });

  it("orders ties by id, so the order is stable", () => {
    const agreements = ["b", "a", "c"].map((agreementId) => ({ ...base, agreementId }));
    expect(buildInbox({ agent, agreements, settlements: [], now: new Date(0) }).items.map((i) => "agreementId" in i && i.agreementId))
      .toEqual(["a", "b", "c"]);
  });

  it(`caps receipts at ${RECEIPT_LIMIT}, keeping the newest`, () => {
    const settlements = Array.from({ length: RECEIPT_LIMIT + 5 }, (_, n) => ({
      settlementId: `s${String(n).padStart(2, "0")}`, status: "CONFIRMED", to: "0xabc", obligationIds: [], chain: "base",
      asset: "USDC", amount: 1, from: "0x1", submittedAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`, evidenceLevel: "LOCAL_PASS",
    }) as Settlement);
    const items = buildInbox({ agent: { agentId: "p", wallets: [{ chain: "base", address: "0xABC" }] }, agreements: [], settlements, now: new Date(0) }).items;
    expect(items).toHaveLength(RECEIPT_LIMIT);
    expect(items[0]).toMatchObject({ settlementId: `s${RECEIPT_LIMIT + 4}` });
  });
});
