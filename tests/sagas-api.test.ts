/**
 * F49 Step 3 — Layer B routes: /api/v1/sagas exercises sagas produced by real operations.
 *
 * ## The assertion this file exists to make
 *
 * NOT that an operator hand-inserted a mock saga. The test verifies that:
 *  1. A real rejection driven through the commerce-recovery kernel produces a durable saga.
 *  2. /api/v1/sagas lists that saga with its exact recovery status, route, and recovered value.
 *  3. Filtering by ?runId= narrows the result correctly.
 *  4. Fetching by ?sagaId= returns the specific saga entity (and 404s on missing).
 *  5. State helpers (isRecovered, isTerminal) agree with the kernel state machine.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GET as getSagas } from "@/app/api/v1/sagas/route";
import { openAgreement, type Result } from "@/lib/kernel/commerce";
import { applyAgreementOpWithSaga } from "@/lib/kernel/commerce-recovery";
import type { Money, Space } from "@/lib/domain/types";
import { getStore } from "@/lib/store/provider";
import { prepareStore } from "./fixtures";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });

const unwrap = <T>(r: Result<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what} failed: ${r.reason}`);
  return r.value;
};

function makeSpace(spaceId: string, over: Partial<Space> = {}): Space {
  return {
    spaceId, owner: "buyer_1",
    governance: { mode: "QUORUM", admins: [], governors: ["buyer_1", "provider_1", "eval_1"], threshold: 2 },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE", participants: ["buyer_1", "provider_1", "eval_1"],
    allowedCapabilities: ["research", "payment"], settlementChains: ["solana"],
    budget: USDC(100), committed: USDC(0), version: 1, createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(async () => {
  await prepareStore();
});

describe("GET /api/v1/sagas — Layer B read surface", () => {
  it("returns empty list initially when no sagas have run", async () => {
    const res = await getSagas(new Request("http://localhost/api/v1/sagas"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.data).toEqual([]);
    expect(body.backend).toBeTruthy();
    expect(body.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("returns 404 for an unknown sagaId", async () => {
    const res = await getSagas(new Request("http://localhost/api/v1/sagas?sagaId=saga_nonexistent"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("SAGA_NOT_FOUND");
    expect(body.sagaId).toBe("saga_nonexistent");
  });

  it("exposes sagas created and recovered through real commercial operations", async () => {
    const { repo } = await getStore();
    const sp = makeSpace("space_saga_test");

    // 1. Open agreement
    const opened = unwrap(openAgreement(sp, {
      agreementId: "ag_saga_1", runId: "run_alpha", intentId: "intent_alpha",
      client: "buyer_1", provider: "provider_1", evaluator: "eval_1",
      externalJobRefs: [], price: USDC(15), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["deliverable verified"], failurePolicy: "refund on failure",
    }, { capability: "research", amount: USDC(15) }), "openAgreement");

    // 2. Fund agreement -> declares and arms saga in repo
    const funded = unwrap(await applyAgreementOpWithSaga(
      repo, opened.space, opened.agreement, "fund",
      { capability: "research", amount: USDC(15) },
    ), "fund");
    const sagaId = funded.saga!.sagaId;

    // 3. GET /api/v1/sagas lists the armed saga
    const listArmedRes = await getSagas(new Request("http://localhost/api/v1/sagas"));
    expect(listArmedRes.status).toBe(200);
    const armedList = await listArmedRes.json();
    expect(armedList.count).toBe(1);
    expect(armedList.data[0].sagaId).toBe(sagaId);
    expect(armedList.data[0].status).toBe("ARMED");
    expect(armedList.data[0].isRecovered).toBe(false);
    expect(armedList.data[0].isTerminal).toBe(false);

    // 4. Start execution
    const executed = unwrap(await applyAgreementOpWithSaga(
      repo, funded.space, funded.agreement, "startExecution",
    ), "startExecution");

    // 5. Submit deliverable
    const submitted = unwrap(await applyAgreementOpWithSaga(
      repo, executed.space, executed.agreement, "submitDeliverable",
      { artifactRefs: ["ipfs://art1"], contentHash: "sha256:abcd" },
    ), "submitDeliverable");

    // 6. Reject deliverable -> drives saga through STEP_FAILURE -> COMPENSATING -> RECOVERED
    const rejected = unwrap(await applyAgreementOpWithSaga(
      repo, submitted.space, submitted.agreement, "rejectDeliverable",
      { failureReason: "SPEC_MISMATCH" },
    ), "rejectDeliverable");
    expect(rejected.saga!.status).toBe("RECOVERED");

    // 7. GET /api/v1/sagas?sagaId=... fetches the terminal recovered saga
    const getRes = await getSagas(new Request(`http://localhost/api/v1/sagas?sagaId=${sagaId}`));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.sagaId).toBe(sagaId);
    expect(getBody.data.status).toBe("RECOVERED");
    expect(getBody.data.recoveredValue).toBe(15);
    expect(getBody.data.isRecovered).toBe(true);
    expect(getBody.data.isTerminal).toBe(true);

    // Assert compensation step outcome
    const deliverStep = getBody.data.steps.find((s: { stepId: string }) => s.stepId === "deliver");
    expect(deliverStep).toBeDefined();
    expect(deliverStep.state).toBe("COMPENSATED");
  });

  it("filters sagas by runId correctly", async () => {
    const { repo } = await getStore();
    const sp = makeSpace("space_multi_run");

    // Saga for run_101
    const o1 = unwrap(openAgreement(sp, {
      agreementId: "ag_r101", runId: "run_101", intentId: "intent_101",
      client: "buyer_1", provider: "provider_1", evaluator: "eval_1",
      externalJobRefs: [], price: USDC(5), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["crit"], failurePolicy: "refund",
    }, { capability: "research", amount: USDC(5) }), "openAgreement 1");
    await applyAgreementOpWithSaga(repo, o1.space, o1.agreement, "fund", { capability: "research", amount: USDC(5) });

    // Saga for run_202
    const o2 = unwrap(openAgreement(sp, {
      agreementId: "ag_r202", runId: "run_202", intentId: "intent_202",
      client: "buyer_1", provider: "provider_1", evaluator: "eval_1",
      externalJobRefs: [], price: USDC(8), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["crit"], failurePolicy: "refund",
    }, { capability: "research", amount: USDC(8) }), "openAgreement 2");
    await applyAgreementOpWithSaga(repo, o2.space, o2.agreement, "fund", { capability: "research", amount: USDC(8) });

    // Query with filter ?runId=run_101
    const res1 = await getSagas(new Request("http://localhost/api/v1/sagas?runId=run_101"));
    const body1 = await res1.json();
    expect(body1.count).toBe(1);
    expect(body1.runId).toBe("run_101");
    expect(body1.data[0].runId).toBe("run_101");

    // Query with filter ?runId=run_202
    const res2 = await getSagas(new Request("http://localhost/api/v1/sagas?runId=run_202"));
    const body2 = await res2.json();
    expect(body2.count).toBe(1);
    expect(body2.runId).toBe("run_202");
    expect(body2.data[0].runId).toBe("run_202");

    // Query without filter
    const resAll = await getSagas(new Request("http://localhost/api/v1/sagas"));
    const bodyAll = await resAll.json();
    expect(bodyAll.count).toBe(2);
  });
});
