/**
 * PP-4: incident controls. An operator pause stops value movement and nothing
 * else: reads, the event stream, and the recovery path keep working.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getPause, POST as postPause } from "@/app/api/v1/admin/pause/route";
import { GET as listAgreements, POST as postAgreement } from "@/app/api/v1/agreements/route";
import { POST as createReservation } from "@/app/api/v1/reservations/route";
import { POST as execute } from "@/app/api/v1/reservations/execute/route";
import { POST as settle } from "@/app/api/v1/settlements/route";
import { POST as x402 } from "@/app/api/v1/x402/route";
import { POST as authorize } from "@/app/api/v1/authorizations/route";
import { POST as createIntent } from "@/app/api/v1/intents/route";
import { GET as obligations } from "@/app/api/v1/obligations/route";
import { GET as events } from "@/app/api/v1/events/route";
import { GET as stream } from "@/app/api/v1/events/stream/route";
import { __resetIncidentStoreForTests, getPauseState } from "@/lib/admin/incident";
import { webhookEventType } from "@/lib/webhooks/events";
import { NOW, bindTestParties, goodProposal, json, prepareStore, req, signedTransition } from "./fixtures";

const TOKEN = "op_".padEnd(40, "p");
beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
  await __resetIncidentStoreForTests();
  process.env.MITRA_OPERATOR_TOKEN = TOKEN;
});
afterEach(() => { delete process.env.MITRA_OPERATOR_TOKEN; });

const operator = (body?: unknown, token: string | null = TOKEN) => new Request("http://localhost/api/v1/admin/pause", {
  method: body === undefined ? "GET" : "POST",
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const pause = async (scopes?: string[]) => {
  const r = await postPause(operator({ paused: true, reason: "incident 2026-10-06: suspected key leak", ...(scopes ? { scopes } : {}) }));
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()).data;
};
const resume = () => postPause(operator({ paused: false, reason: "incident closed" }));

const draft = (id: string) => ({ op: "open", spaceId: "space_research_1",
  draft: { agreementId: id, runId: `run_${id}`, intentId: `intent_${id}`, client: "agent_buyer_07", provider: "agent_data_03",
    evaluator: "agent_eval_02", price: { asset: "USDC", amount: 2 }, deadline: "2027-01-01T00:00:00Z" },
  proposal: { capability: "research", amount: { asset: "USDC", amount: 2 } } });
const expectPaused = async (res: Response, scope: string) => {
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("60");
  expect(await res.json()).toMatchObject({ error: "SYSTEM_PAUSED", scope, reason: "incident 2026-10-06: suspected key leak" });
};

describe("the pause route is operator-only", () => {
  it("fails closed without a configured token, and refuses a wrong one", async () => {
    delete process.env.MITRA_OPERATOR_TOKEN;
    expect((await postPause(operator({ paused: true, reason: "x".repeat(5) }))).status).toBe(503);
    process.env.MITRA_OPERATOR_TOKEN = TOKEN;
    expect((await postPause(operator({ paused: true, reason: "xxxxx" }, null))).status).toBe(401);
    expect((await postPause(operator({ paused: true, reason: "xxxxx" }, `${TOKEN}!`))).status).toBe(401);
    expect((await getPause(operator(undefined, null))).status).toBe(401);
    expect((await getPauseState()).paused, "nothing was paused by the refused calls").toBe(false);
  });

  it("refuses an unknown scope or a missing reason", async () => {
    expect((await postPause(operator({ paused: true, scopes: ["withdrawals"], reason: "xxxxx" }))).status).toBe(400);
    expect((await postPause(operator({ paused: true }))).status).toBe(400);
  });
});

describe("a full pause stops every value movement", () => {
  it("opening, funding, reserving, executing, settling and x402 all answer 503 SYSTEM_PAUSED", async () => {
    // Set up before the incident: an OPEN agreement and a live reservation.
    expect((await postAgreement(req(draft("ag_cb")))).status).toBe(201);
    const r = (await json(await createReservation(req({ ...goodProposal, ttlMinutes: 60 })))).data;

    const state = await pause();
    expect(state).toMatchObject({ paused: true, scopes: ["agreements", "authority", "execution", "funding"], version: 1 });

    await expectPaused(await postAgreement(req(draft("ag_cb_2"))), "agreements");
    await expectPaused(await postAgreement(req(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "ag_cb" }))), "funding");
    await expectPaused(await createReservation(req({ ...goodProposal, ttlMinutes: 60 })), "funding");
    await expectPaused(await execute(req({ reservationId: r.reservationId, amount: r.amount, asset: r.asset, chain: r.chain, actionDigest: r.actionDigest, now: NOW })), "execution");
    await expectPaused(await settle(req({ op: "settle", agreementId: "ag_cb", reservationId: r.reservationId })), "execution");
    await expectPaused(await settle(req({ op: "settleResidual", epochId: "epoch_x", transferIndex: 0, reservationId: r.reservationId })), "execution");
    await expectPaused(await x402(req({ reservationId: r.reservationId, url: "https://api.example.com/paid" })), "execution");

    // Nothing moved: the agreement is still OPEN and the reservation still unexecuted.
    expect((await json(await listAgreements(new Request("http://x/api/v1/agreements?agreementId=ag_cb")))).data.status).toBe("OPEN");

    // Resume, and the same instruction goes through the guard as normal.
    expect((await resume()).status).toBe(200);
    const after = await execute(req({ reservationId: r.reservationId, amount: r.amount, asset: r.asset, chain: r.chain, actionDigest: r.actionDigest, now: NOW }));
    expect(after.status).toBe(200);
    expect((await json(after)).data.status).toBe("COMMITTED");
    expect(await getPauseState()).toMatchObject({ paused: false, scopes: [], version: 2 });
  });
});

describe("what a pause leaves running", () => {
  it("reads, authorizations, intents, and the recovery path (reject, refund) all keep working", async () => {
    // Before the incident: one agreement SUBMITTED, one FUNDED.
    const post = (b: unknown) => postAgreement(req(b));
    for (const id of ["ag_sub", "ag_fun"]) {
      expect((await post(draft(id))).status).toBe(201);
      expect((await post(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: id }))).status).toBe(200);
    }
    expect((await post(await signedTransition("agent_data_03", "FUNDED", { op: "startExecution", agreementId: "ag_sub" }))).status).toBe(200);
    expect((await post(await signedTransition("agent_data_03", "EXECUTING", { op: "submitDeliverable", agreementId: "ag_sub", contentHash: "sha256:z", artifactRefs: ["a"] }))).status).toBe(200);

    await pause();

    expect((await listAgreements(new Request("http://x/api/v1/agreements"))).status).toBe(200);
    expect((await obligations()).status).toBe(200);
    expect((await events(new Request("http://x/api/v1/events?runId=run_ag_sub"))).status).toBe(200);
    const auth = await authorize(req({ mandateId: "mandate_research_public_v7", vaultId: "vault_sol_primary", amount: 5, asset: "USDC",
      chain: "solana", counterparty: "virtuals:research-agent-18", capability: "market_research" }));
    expect(auth.status, "an ALLOW moves nothing, so deciding is not paused").toBe(201);
    expect((await createIntent(req({ runId: "r", principal: "p", initiatingAgentId: "a", mandateId: "m", objective: "o",
      budget: { asset: "USDC", amount: 1 }, constraints: [], expiresAt: "2099-01-01T00:00:00Z" }))).status).toBe(201);

    const rejected = await post(await signedTransition("agent_eval_02", "SUBMITTED", { op: "rejectDeliverable", agreementId: "ag_sub", failureReason: "WRONG" }));
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    const refunded = await post(await signedTransition("agent_buyer_07", "FUNDED", { op: "refund", agreementId: "ag_fun" }));
    expect(refunded.status, await refunded.clone().text()).toBe(200);
    expect((await json(refunded)).data.agreement.status).toBe("REFUNDED");

    // Confirming a payment already made records the truth; it is not paused.
    const confirm = await settle(req({ op: "confirm", settlementId: "set_missing" }));
    expect((await json(confirm)).error).not.toBe("SYSTEM_PAUSED");
  });

  it("the live event stream stays open and carries the pause itself", async () => {
    await pause();
    const ac = new AbortController();
    const res = await stream(new Request("http://x/api/v1/events/stream?runId=system&pollMs=200", { signal: ac.signal }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes("Value movement paused") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    // `authority` (F100) is in the list because creating a Mandate now answers 503 under a pause.
    expect(text).toContain("Value movement paused (agreements, authority, execution, funding)");
  });

  it("pause and resume are on the record, as system.warning and system.info for webhook subscribers", async () => {
    await pause(["execution"]);
    await resume();
    const evs = (await json(await events(new Request("http://x/api/v1/events?runId=system")))).data as Array<Parameters<typeof webhookEventType>[0] & { title: string }>;
    const titles = evs.map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(["Value movement paused (execution)", "Value movement resumed"]));
    expect(evs.map(webhookEventType)).toEqual(expect.arrayContaining(["system.warning", "system.info"]));
  });
});

describe("fail closed", () => {
  it("if the pause state cannot be read, value routes refuse rather than assume they may move value", async () => {
    const r = (await json(await createReservation(req({ ...goodProposal, ttlMinutes: 60 })))).data;
    globalThis.__mitraIncidentStore = Promise.resolve({ store: {
      get: async () => { throw new Error("connection refused"); },
      set: async () => { throw new Error("connection refused"); },
    } });
    const res = await execute(req({ reservationId: r.reservationId, amount: r.amount, asset: r.asset, chain: r.chain, actionDigest: r.actionDigest, now: NOW }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "SYSTEM_PAUSE_STATE_UNAVAILABLE", scope: "execution" });
    expect((await listAgreements(new Request("http://x/api/v1/agreements"))).status, "reads are unaffected").toBe(200);
  });
});

describe("a scoped pause stops only its scope", () => {
  it("an execution-only pause lets agreements open and fund, and stops the guard", async () => {
    const r = (await json(await createReservation(req({ ...goodProposal, ttlMinutes: 60 })))).data;
    await pause(["execution"]);
    expect((await postAgreement(req(draft("ag_scoped")))).status).toBe(201);
    expect((await postAgreement(req(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "ag_scoped" })))).status).toBe(200);
    expect((await createReservation(req({ ...goodProposal, ttlMinutes: 60 }))).status).toBe(201);
    await expectPaused(await execute(req({ reservationId: r.reservationId, amount: r.amount, asset: r.asset, chain: r.chain, actionDigest: r.actionDigest, now: NOW })), "execution");
  });

  it("an agreements-only pause stops opening and nothing else", async () => {
    expect((await postAgreement(req(draft("ag_before")))).status).toBe(201);
    await pause(["agreements"]);
    await expectPaused(await postAgreement(req(draft("ag_after"))), "agreements");
    expect((await postAgreement(req(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "ag_before" })))).status).toBe(200);
  });
});

/**
 * Structural: every route that changes state is either guarded or exempt for a
 * stated reason. A new value route added without deciding fails here, instead of
 * shipping unpausable.
 */
describe("no state-changing route is unclassified", () => {
  const GUARDED = new Set(["agreements", "mandates", "reservations", "reservations/execute", "settlements", "x402"]);
  const EXEMPT: Record<string, string> = {
    "agents": "registration moves no value",
    "authorizations": "an ALLOW is not permission to move value",
    "clearing": "netting and epochs; residual payment is a settlement, which is guarded",
    "failure-lab": "simulation; returns a fixed verdict",
    "intents": "a statement, not an authorization",
    "runs": "bookkeeping",
    "spaces": "containment rules, no capital",
    "webhooks": "operator-only, outbound notifications",
    "admin/pause": "the control itself",
  };
  const root = join(process.cwd(), "app/api/v1");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === "route.ts" ? [p] : [];
  });

  it("each mutating route is guarded by refuseIfPaused or listed as exempt with a reason", () => {
    const mutating = walk(root).filter((f) => /export async function (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(f, "utf8")));
    for (const file of mutating) {
      const name = file.slice(root.length + 1).replace(/\/route\.ts$/, "");
      const guarded = readFileSync(file, "utf8").includes("refuseIfPaused(");
      if (GUARDED.has(name)) expect(guarded, `${name} must call refuseIfPaused`).toBe(true);
      else expect(EXEMPT[name], `${name} changes state but is neither guarded nor exempt`).toBeDefined();
    }
    expect(mutating.length).toBeGreaterThanOrEqual(GUARDED.size + Object.keys(EXEMPT).length - 1);
  });
});
