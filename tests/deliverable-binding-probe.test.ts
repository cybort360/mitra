/**
 * F94: a submitted deliverable is now checked AND kept.
 *
 * These were `it.fails` canaries while F94 was open; the invariant now holds, so they are
 * plain `it`s — and a positive case was added at the end, because a submit path that
 * refused everything would satisfy all three of them.
 *
 * Through the real routes via the SDK, not the kernel directly: the defect was that the
 * route never called the guard, so only the route can see it.
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
  it("a submission after the deadline is refused DELIVERABLE_LATE", async () => {
    await executing("ag_f94_late", "2020-01-01T00:00:00Z");
    const err = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_late", { artifactRefs: ["ipfs://x"], contentHash: "sha256:x" })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "DELIVERABLE_LATE" });
  });

  it("a submission with no content hash or artifacts is refused", async () => {
    await executing("ag_f94_empty", "2027-01-01T00:00:00Z");
    const err = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_empty", {} as { artifactRefs: string[]; contentHash: string })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
  });

  it("what the provider signed is readable afterwards, so the evaluator judges that", async () => {
    await executing("ag_f94_kept", "2027-01-01T00:00:00Z");
    await as("agent_data_03").commerce.submitDeliverable("ag_f94_kept", { artifactRefs: ["ipfs://F94_REF"], contentHash: "sha256:F94_HASH" });
    const res = await routeFetch(`${ROUTE_BASE_URL}/api/v1/agreements?agreementId=ag_f94_kept`);
    expect(await res.text()).toContain("sha256:F94_HASH");
  });

  it("a valid submission is accepted and kept", async () => {
    // The positive case, so the guards above cannot be satisfied by refusing everything.
    // A submit path that always returned an error would pass all three canaries.
    await executing("ag_f94_ok", "2027-01-01T00:00:00Z");
    const submitted = await as("agent_data_03").commerce
      .submitDeliverable("ag_f94_ok", { artifactRefs: ["ipfs://F94_OK"], contentHash: "sha256:F94_OK_HASH" });
    expect(submitted.agreement.status).toBe("SUBMITTED");
    const res = await routeFetch(`${ROUTE_BASE_URL}/api/v1/agreements?agreementId=ag_f94_ok`);
    const body = await res.json();
    expect(body.data.deliverables).toHaveLength(1);
    expect(body.data.deliverables[0]).toMatchObject({
      agreementId: "ag_f94_ok", contentHash: "sha256:F94_OK_HASH", accepted: false,
    });
  });
});
