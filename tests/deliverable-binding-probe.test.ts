/**
 * F94 canary: a submitted deliverable is neither checked nor kept.
 *
 * Each `it.fails` asserts the INVARIANT, so the suite is green while F94 is open
 * and vitest reports a failure the moment the submit path is fixed — the cue to
 * turn these into plain `it`s. The plain `it` at the end pins today's behaviour
 * that makes the defect reachable, through the real routes via the SDK.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MitraClient } from "@/lib/sdk";
import { bindTestParties, prepareStore, TEST_PARTIES, type TestParty } from "./fixtures";
import { ROUTE_BASE_URL, routeFetch } from "./route-fetch";

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

const as = (agentId: TestParty) =>
  new MitraClient({ baseUrl: ROUTE_BASE_URL, signer: TEST_PARTIES[agentId], chainId: 84532, agentId, fetch: routeFetch });

async function executing(agreementId: string, deadline: string) {
  await as("agent_buyer_07").commerce.createAgreement({
    spaceId: "space_research_1",
    draft: {
      agreementId, runId: `run_${agreementId}`, intentId: "intent_f78",
      client: "agent_buyer_07", provider: "agent_data_03", evaluator: "agent_eval_02",
      price: { asset: "USDC", amount: 1 }, deadline,
    },
    proposal: { capability: "research", amount: { asset: "USDC", amount: 1 } },
  });
  await as("agent_buyer_07").commerce.fund(agreementId);
  await as("agent_data_03").commerce.startExecution(agreementId);
}

describe("F94: the submit path binds the deliverable", () => {
  it.fails("a submission after the deadline is refused DELIVERABLE_LATE", async () => {
    await executing("ag_f94_late", "2020-01-01T00:00:00Z");
    const err = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_late", { artifactRefs: ["ipfs://x"], contentHash: "sha256:x" })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "DELIVERABLE_LATE" });
  });

  it.fails("a submission with no content hash or artifacts is refused", async () => {
    await executing("ag_f94_empty", "2027-01-01T00:00:00Z");
    const err = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_empty", {} as { artifactRefs: string[]; contentHash: string })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
  });

  it.fails("what the provider signed is readable afterwards, so the evaluator judges that", async () => {
    await executing("ag_f94_kept", "2027-01-01T00:00:00Z");
    await as("agent_data_03").commerce.submitDeliverable("ag_f94_kept", { artifactRefs: ["ipfs://F94_REF"], contentHash: "sha256:F94_HASH" });
    const res = await routeFetch(`${ROUTE_BASE_URL}/api/v1/agreements?agreementId=ag_f94_kept`);
    expect(await res.text()).toContain("sha256:F94_HASH");
  });

  it("today: a late, empty submission is SUBMITTED and can then be ACCEPTED", async () => {
    await executing("ag_f94_today", "2020-01-01T00:00:00Z");
    const submitted = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_today", {} as { artifactRefs: string[]; contentHash: string });
    expect(submitted.agreement.status).toBe("SUBMITTED");
    expect((await as("agent_eval_02").commerce.acceptDeliverable("ag_f94_today")).agreement.status).toBe("ACCEPTED");
  });
});
