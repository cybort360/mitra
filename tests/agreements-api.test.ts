import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/v1/agreements/route";
import { bindTestParties, prepareStore, signedTransition } from "./fixtures";

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

describe("Commercial Agreements API (Prometheus Vertical Agency Surface)", () => {
  it("GET /api/v1/agreements returns seeded agreements with availableOps", async () => {
    const res = await GET(new Request("http://localhost/api/v1/agreements"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty("availableOps");
    expect(body.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("GET /api/v1/agreements?spaceId= filters agreements by space", async () => {
    const res = await GET(new Request("http://localhost/api/v1/agreements?spaceId=space_research_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaceId).toBe("space_research_1");
    for (const a of body.data) {
      expect(a.spaceIds).toContain("space_research_1");
    }
  });

  it("POST /api/v1/agreements opens a new agreement, funds it, and drives recovery on rejection", async () => {
    // 1. OPEN agreement in space_research_1
    const openReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        op: "open",
        spaceId: "space_research_1",
        draft: {
          agreementId: "ag_prometheus_1",
          runId: "run_p1",
          intentId: "intent_p1",
          client: "agent_buyer_07",
          // F55: a party must be a registered agent to instruct a transition.
          provider: "agent_data_03",
          evaluator: "agent_eval_02",
          price: { asset: "USDC", amount: 15 },
          deadline: "2027-01-01T00:00:00Z",
          acceptanceCriteria: ["market research report verified"],
          failurePolicy: "refund on expiry",
        },
        proposal: {
          capability: "research",
          amount: { asset: "USDC", amount: 15 },
        },
      }),
    });

    const openRes = await POST(openReq);
    expect(openRes.status).toBe(201);
    const openBody = await openRes.json();
    expect(openBody.data.agreement.status).toBe("OPEN");
    expect(openBody.data.agreement.agreementId).toBe("ag_prometheus_1");
    expect(openBody.data.agreement.availableOps).toContain("fund");

    // 2. FUND agreement -> arms TALOS recovery saga
    const fundReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", {
        op: "fund",
        agreementId: "ag_prometheus_1",
      })),
    });

    const fundRes = await POST(fundReq);
    expect(fundRes.status).toBe(200);
    const fundBody = await fundRes.json();
    expect(fundBody.data.agreement.status).toBe("FUNDED");
    expect(fundBody.data.saga).toBeTruthy();
    expect(fundBody.data.saga.status).toBe("ARMED");
    expect(fundBody.data.space.committed.amount).toBeGreaterThanOrEqual(15);

    // 3. START EXECUTION -> saga advances to EXECUTING
    const execReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_data_03", "FUNDED", {
        op: "startExecution",
        agreementId: "ag_prometheus_1",
      })),
    });

    const execRes = await POST(execReq);
    expect(execRes.status).toBe(200);
    const execBody = await execRes.json();
    expect(execBody.data.agreement.status).toBe("EXECUTING");
    expect(execBody.data.saga.status).toBe("EXECUTING");

    // 4. SUBMIT DELIVERABLE
    const submitReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_data_03", "EXECUTING", {
        op: "submitDeliverable",
        agreementId: "ag_prometheus_1",
        artifactRefs: ["ipfs://bad-inference-model"],
        contentHash: "sha256:0123456789abcdef",
      })),
    });

    const submitRes = await POST(submitReq);
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(submitBody.data.agreement.status).toBe("SUBMITTED");

    // 5. REJECT DELIVERABLE -> triggers TALOS compensation & refunds locked escrow
    const committedBefore = submitBody.data.space.committed.amount;
    const rejectReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_eval_02", "SUBMITTED", {
        op: "rejectDeliverable",
        agreementId: "ag_prometheus_1",
        failureReason: "POISONED_OUTPUT",
      })),
    });

    const rejectRes = await POST(rejectReq);
    expect(rejectRes.status).toBe(200);
    const rejectBody = await rejectRes.json();

    // Verify Invariant §4.5: Failure is a state transition, not an exception
    expect(rejectBody.data.agreement.status).toBe("REJECTED");
    expect(rejectBody.data.agreement.escrowReleased).toBe(true);
    expect(rejectBody.data.saga.status).toBe("RECOVERED");
    expect(rejectBody.data.saga.recoveredValue).toBe(15);
    // Headroom restored: committed drops by the agreement price
    expect(rejectBody.data.space.committed.amount).toBe(committedBefore - 15);
  });

  it("POST /api/v1/agreements rejects invalid requests with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/agreements", {
        method: "POST",
        body: JSON.stringify({ op: "invalid_op" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("POST /api/v1/agreements returns 404 for unknown agreement", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/agreements", {
        method: "POST",
        body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "non_existent_ag" })),
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("AGREEMENT_NOT_FOUND");
  });
});
