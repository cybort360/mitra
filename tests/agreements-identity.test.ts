/**
 * F55 — caller identity. Seam B: POST /api/v1/agreements.
 *
 * Every lifecycle transition must carry an EIP-712 signature from a wallet of
 * the agent holding a role the op allows. Decision: ctx_d236086bde9601ee.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { GET, POST } from "@/app/api/v1/agreements/route";
import { TEST_PARTIES, bindTestParties, prepareStore, signAs } from "./fixtures";

const { agent_buyer_07: client, agent_data_03: provider, agent_eval_02: evaluator } = TEST_PARTIES;
/** Registered to nobody. */
const stranger = privateKeyToAccount(`0x${"ee".repeat(32)}`);
const signedBody = signAs;

const FUND = { capability: "research", amount: { asset: "USDC", amount: 15 } };
const SUBMIT = { artifactRefs: ["ipfs://report"], contentHash: "sha256:0123456789abcdef" };

/** Open, fund, start and submit, each signed by the party whose role it is. */
async function submittedAgreement(): Promise<string> {
  const agreementId = await openAgreement();
  for (const [account, actor, from, op, extra] of [
    [client, "agent_buyer_07", "OPEN", "fund", FUND],
    [provider, "agent_data_03", "FUNDED", "startExecution", {}],
    [provider, "agent_data_03", "EXECUTING", "submitDeliverable", SUBMIT],
  ] as const) {
    const res = await post(await signedBody(account, actor, from, { op, agreementId, ...extra }));
    expect(res.status, `${op}: ${JSON.stringify(await res.clone().json())}`).toBe(200);
  }
  return agreementId;
}

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/v1/agreements", { method: "POST", body: JSON.stringify(body) }));

const statusOf = async (agreementId: string) =>
  (await (await GET(new Request(`http://localhost/api/v1/agreements?agreementId=${agreementId}`))).json()).data.status;

let seq = 0;
async function openAgreement(): Promise<string> {
  const agreementId = `ag_f55_${++seq}`;
  const res = await post({
    op: "open",
    spaceId: "space_research_1",
    draft: {
      agreementId, runId: `run_${agreementId}`, intentId: `intent_${agreementId}`,
      client: "agent_buyer_07", provider: "agent_data_03", evaluator: "agent_eval_02",
      price: { asset: "USDC", amount: 15 }, deadline: "2027-01-01T00:00:00Z",
    },
    proposal: { capability: "research", amount: { asset: "USDC", amount: 15 } },
  });
  expect(res.status).toBe(201);
  return agreementId;
}

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

describe("agreement transitions require a signed request", () => {
  it("refuses an unsigned transition and leaves the agreement unchanged", async () => {
    const agreementId = await openAgreement();
    const res = await post({ op: "fund", agreementId, capability: "research", amount: { asset: "USDC", amount: 15 } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("SIGNATURE_REQUIRED");
    expect(await statusOf(agreementId)).toBe("OPEN");
  });

  it("applies a fund signed by the client's registered wallet", async () => {
    const agreementId = await openAgreement();
    const res = await post(await signedBody(client, "agent_buyer_07", "OPEN", { op: "fund", agreementId, ...FUND }));
    expect(res.status).toBe(200);
    expect(await statusOf(agreementId)).toBe("FUNDED");
  });

  it("refuses a stranger's valid signature claiming to be the client", async () => {
    const agreementId = await openAgreement();
    const res = await post(await signedBody(stranger, "agent_buyer_07", "OPEN", { op: "fund", agreementId, ...FUND }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("SIGNER_NOT_AGENT_WALLET");
    expect(await statusOf(agreementId)).toBe("OPEN");
  });

  it("refuses the provider accepting its own deliverable, though its signature is valid", async () => {
    const agreementId = await submittedAgreement();
    const res = await post(await signedBody(provider, "agent_data_03", "SUBMITTED", { op: "acceptDeliverable", agreementId }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("ACTOR_NOT_PERMITTED");
    expect(await statusOf(agreementId)).toBe("SUBMITTED");
  });

  it("lets the evaluator accept", async () => {
    const agreementId = await submittedAgreement();
    const res = await post(await signedBody(evaluator, "agent_eval_02", "SUBMITTED", { op: "acceptDeliverable", agreementId }));
    expect(res.status).toBe(200);
    expect(await statusOf(agreementId)).toBe("ACCEPTED");
  });

  it("makes a signature stale once its transition is applied, so a replay is refused", async () => {
    const agreementId = await openAgreement();
    const fund = await signedBody(client, "agent_buyer_07", "OPEN", { op: "fund", agreementId, ...FUND });
    expect((await post(fund)).status).toBe(200);
    const replay = await post(fund);
    expect(replay.status).toBe(401);
    expect(await statusOf(agreementId)).toBe("FUNDED");
  });

  it("refuses a body changed after it was signed", async () => {
    const agreementId = await openAgreement();
    const signed = await signedBody(client, "agent_buyer_07", "OPEN", { op: "fund", agreementId, ...FUND });
    const res = await post({ ...signed, amount: { asset: "USDC", amount: 1 } });
    expect(res.status).toBe(401);
    expect(await statusOf(agreementId)).toBe("OPEN");
  });
});
