/**
 * Backlog #5: the stores that replaced fixtures — authorizations, agents, clearing
 * epochs — and F60, the clearing route finalizing a client-supplied epoch.
 * Runs against whichever backend `prepareStore` selects (Postgres with DATABASE_URL).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prepareStore, goodProposal } from "./fixtures";
import { GET as authGET, POST as authPOST } from "@/app/api/v1/authorizations/route";
import { GET as agentsGET } from "@/app/api/v1/agents/route";
import { GET as clearingGET, POST as clearingPOST } from "@/app/api/v1/clearing/route";

beforeEach(async () => { await prepareStore(); });

const post = (h: (r: Request) => Promise<Response>, body: unknown) =>
  h(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
const get = (h: (r: Request) => Promise<Response>, q: string) => h(new Request(`http://localhost/x${q}`));

describe("authorizations are listed from the store", () => {
  it("a recorded decision is listed, filtered by run, with its recipient constraint", async () => {
    expect((await post(authPOST, { ...goodProposal, runId: "run_auth_list" })).status).toBe(201);
    expect((await post(authPOST, { ...goodProposal, runId: "run_other" })).status).toBe(201);
    const body = await (await get(authGET, "?runId=run_auth_list")).json();
    expect(body.count).toBe(1);
    expect(body.data[0]).toMatchObject({ runId: "run_auth_list", decision: "ALLOW", recipientConstraint: goodProposal.counterparty });
  });
});

describe("agents are read from the store", () => {
  it("lists, gets, filters, and 404s", async () => {
    const all = await (await get(agentsGET, "")).json();
    expect(all.count).toBeGreaterThan(0);
    const one = await (await get(agentsGET, "?agentId=agent_buyer_07")).json();
    expect(one.data.agentId).toBe("agent_buyer_07");
    const base = await (await get(agentsGET, "?chain=base")).json();
    expect(base.data.every((a: { wallets: { chain: string }[] }) => a.wallets.some((w) => w.chain === "base"))).toBe(true);
    expect((await get(agentsGET, "?agentId=nobody")).status).toBe(404);
  });
});

describe("clearing epochs are stored, and only a stored calculation is finalized (F60)", () => {
  const ob = (id: string, d: string, c: string, amount: number) => ({ obligationId: id, debtor: d, creditor: c, amount: { asset: "USDC", amount }, status: "ACCEPTED" });
  const obligations = [ob("o1", "a", "b", 10), ob("o2", "b", "a", 4), ob("o3", "b", "c", 3)];

  async function openAndCalculate(epochId: string, obs = obligations) {
    const open = await post(clearingPOST, { action: "open_epoch", epochId, asset: "USDC", settlementDomain: "base", obligations: obs });
    expect(open.status).toBe(201);
    const calc = await post(clearingPOST, { action: "calculate_epoch", epoch: (await open.json()).data, obligations: obs });
    const body = await calc.json();
    expect(calc.status, JSON.stringify(body)).toBe(200);
    expect(body.persisted).toBe(true);
    return body.data;
  }

  it("an epoch opened once is stored; opening the same id again is refused", async () => {
    await openAndCalculate("ep_store");
    const read = await (await get(clearingGET, "?epochId=ep_store")).json();
    expect(read.data.status).toBe("CHALLENGE");
    const again = await post(clearingPOST, { action: "open_epoch", epochId: "ep_store", asset: "USDC", settlementDomain: "base", obligations });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("EPOCH_EXISTS");
  });

  it("THE ATTACK: finalize with a forged epoch object seals the STORED calculation, not the forgery", async () => {
    const calculated = await openAndCalculate("ep_forge");
    const forged = {
      ...calculated,
      residualTransfers: [{ from: "a", to: "attacker", amount: 1_000_000 }],
      netPositions: [{ party: "attacker", amount: 1_000_000 }],
    };
    const res = await post(clearingPOST, { action: "finalize_epoch", epoch: forged });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data.status).toBe("FINALIZED");
    expect(body.data.residualTransfers).toEqual(calculated.residualTransfers);
    expect(JSON.stringify(body.data)).not.toContain("attacker");
    const stored = await (await get(clearingGET, "?epochId=ep_forge")).json();
    expect(stored.data.status).toBe("FINALIZED");
    expect(stored.data.resultHash).toBe(body.data.resultHash);
  });

  it("an epoch this server never opened cannot be finalized", async () => {
    const res = await post(clearingPOST, { action: "finalize_epoch", epoch: { epochId: "ep_made_up", status: "CHALLENGE", obligationIds: [] } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EPOCH_NOT_FOUND");
  });

  it("an obligation enters at most one finalized epoch (SECURITY.md, via finalizeEpochOnce)", async () => {
    await openAndCalculate("ep_first");
    expect((await post(clearingPOST, { action: "finalize_epoch", epoch: { epochId: "ep_first" } })).status).toBe(200);
    await openAndCalculate("ep_second");
    const res = await post(clearingPOST, { action: "finalize_epoch", epoch: { epochId: "ep_second" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^OBLIGATION_ALREADY_FINALIZED:o1,o2,o3$/);
  });

  it("lists stored epochs", async () => {
    await openAndCalculate("ep_listed");
    const body = await (await get(clearingGET, "?view=epochs")).json();
    expect(body.data.map((e: { epochId: string }) => e.epochId)).toContain("ep_listed");
  });
});
