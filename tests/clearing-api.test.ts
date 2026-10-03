import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/v1/clearing/route";
import { prepareStore } from "./fixtures";
import type { Obligation } from "@/lib/domain/types";

beforeEach(async () => {
  await prepareStore();
});

function makeObligation(over: Partial<Obligation> & Pick<Obligation, "obligationId" | "debtor" | "creditor" | "amount">): Obligation {
  return {
    runId: "run_test",
    sourceEvent: "evt_test",
    dueAt: "2027-01-01T00:00:00Z",
    priority: 1,
    status: "ACCEPTED",
    nonce: 1,
    version: 1,
    ...over,
  };
}

describe("Clearing & Netting API (Pando Horizontal Coordination Surface)", () => {
  it("GET /api/v1/clearing returns netting preview for store obligations", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty("grossVolume");
    expect(body.data).toHaveProperty("residualVolume");
    expect(body.data).toHaveProperty("netPositions");
    expect(body.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("POST /api/v1/clearing action: 'net' reduces gross debt volume and conserves value", async () => {
    // Synthetic mesh: Alice owes Bob 100, Bob owes Charlie 80, Charlie owes Alice 50
    // Gross: 100 + 80 + 50 = 230
    // Net: Alice: -50, Bob: +20, Charlie: +30 (Sum = 0)
    // Residual: Alice -> Charlie 30, Alice -> Bob 20 (Residual volume = 50, compression = 78.26%)
    const mesh: Obligation[] = [
      makeObligation({
        obligationId: "ob_1",
        debtor: "agent_alice",
        creditor: "agent_bob",
        amount: { asset: "USDC", amount: 100 },
      }),
      makeObligation({
        obligationId: "ob_2",
        debtor: "agent_bob",
        creditor: "agent_charlie",
        amount: { asset: "USDC", amount: 80 },
      }),
      makeObligation({
        obligationId: "ob_3",
        debtor: "agent_charlie",
        creditor: "agent_alice",
        amount: { asset: "USDC", amount: 50 },
      }),
    ];

    const req = new Request("http://localhost/api/v1/clearing", {
      method: "POST",
      body: JSON.stringify({
        action: "net",
        obligations: mesh,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.grossVolume).toBe(230);
    expect(body.data.residualVolume).toBe(50);
    expect(body.data.compressionRatio).toBe(0.7826);
    expect(body.data.conservationVerified).toBe(true);

    const positions = body.data.netPositions;
    expect(positions.find((p: any) => p.party === "agent_alice")?.amount).toBe(-50);
    expect(positions.find((p: any) => p.party === "agent_bob")?.amount).toBe(20);
    expect(positions.find((p: any) => p.party === "agent_charlie")?.amount).toBe(30);
  });

  it("POST /api/v1/clearing drives deterministic epoch lifecycle", async () => {
    const obligations: Obligation[] = [
      makeObligation({
        obligationId: "ob_e1",
        debtor: "agent_a",
        creditor: "agent_b",
        amount: { asset: "USDC", amount: 500 },
      }),
      makeObligation({
        obligationId: "ob_e2",
        debtor: "agent_b",
        creditor: "agent_a",
        amount: { asset: "USDC", amount: 200 },
      }),
    ];

    // 1. OPEN EPOCH
    const openRes = await POST(
      new Request("http://localhost/api/v1/clearing", {
        method: "POST",
        body: JSON.stringify({
          action: "open_epoch",
          epochId: "epoch_pando_001",
          asset: "USDC",
          settlementDomain: "base",
          obligations,
        }),
      }),
    );
    expect(openRes.status).toBe(201);
    const openBody = await openRes.json();
    expect(openBody.data.status).toBe("OPEN");
    expect(openBody.data.epochId).toBe("epoch_pando_001");

    // 2. CALCULATE EPOCH (FROZEN -> CALCULATING -> CHALLENGE)
    const calcRes = await POST(
      new Request("http://localhost/api/v1/clearing", {
        method: "POST",
        body: JSON.stringify({
          action: "calculate_epoch",
          epoch: openBody.data,
          obligations,
        }),
      }),
    );
    expect(calcRes.status).toBe(200);
    const calcBody = await calcRes.json();
    expect(calcBody.data.status).toBe("CHALLENGE");
    expect(calcBody.data.inputsRoot).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calcBody.data.grossVolume).toBe(700);
    expect(calcBody.data.netResidual).toBe(300);

    // 3. FINALIZE EPOCH
    const finalizeRes = await POST(
      new Request("http://localhost/api/v1/clearing", {
        method: "POST",
        body: JSON.stringify({
          action: "finalize_epoch",
          epoch: calcBody.data,
        }),
      }),
    );
    expect(finalizeRes.status).toBe(200);
    const finalizeBody = await finalizeRes.json();
    expect(finalizeBody.data.status).toBe("FINALIZED");
    expect(finalizeBody.data.finalizedAt).toBeTruthy();
  });
});
