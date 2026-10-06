/**
 * LP-1 — intent persistence across both backends.
 *
 * Runs against whichever store the routes actually use: in-memory without
 * DATABASE_URL, Postgres with it (via `prepareStore`, same as every other API
 * suite). That means this file proves CRUD *behaviour*, not a backend — the
 * backend-parity suite pins the read/write equivalence separately.
 *
 * One deliberate omission: intents are never updated in place. An intent is a
 * versioned commercial statement; changing it is a new version (or a new
 * intent), not a row mutation. There is no PUT here on purpose.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GET as listIntents, POST as createIntent } from "@/app/api/v1/intents/route";
import { GET as getIntent } from "@/app/api/v1/intents/[id]/route";
import { prepareStore, req } from "./fixtures";

beforeEach(async () => { await prepareStore(); });

const body = {
  intentId: "intent_pk1_1",
  runId: "run_501",
  principal: "Mitra Labs",
  initiatingAgentId: "agent_buyer_07",
  mandateId: "mandate_1",
  objective: "Research 100 unique projects",
  budget: { asset: "USDC", amount: 100 },
  constraints: ["bounded route only"],
  expiresAt: "2027-01-01T00:00:00Z",
};

describe("intent lifecycle", () => {
  it("creates, reads back, and lists", async () => {
    const created = await createIntent(req(body));
    expect(created.status).toBe(201);
    const cb = await created.json();
    expect(cb.data.intentId).toBe("intent_pk1_1");
    expect(cb.data.version).toBe(1);

    const got = await getIntent(new Request("http://x"), { params: Promise.resolve({ id: "intent_pk1_1" }) });
    expect(got.status).toBe(200);
    expect((await got.json()).data.objective).toBe(body.objective);

    const list = await listIntents(new Request("http://x"));
    const ids = (await list.json()).data.map((i: { intentId: string }) => i.intentId);
    expect(ids).toContain("intent_pk1_1");
  });

  it("filters the list by principal", async () => {
    await createIntent(req(body));
    const list = await listIntents(new Request("http://x?principal=Someone+Else"));
    expect((await list.json()).data.map((i: { intentId: string }) => i.intentId)).not.toContain("intent_pk1_1");
  });

  it("404s an intent that does not exist", async () => {
    const res = await getIntent(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("refuses a zero budget and a past expiry", async () => {
    expect((await createIntent(req({ ...body, intentId: "i0", budget: { asset: "USDC", amount: 0 } }))).status).toBe(400);
    expect((await createIntent(req({ ...body, intentId: "i1", expiresAt: "2020-01-01T00:00:00Z" }))).status).toBe(400);
  });

  it("is idempotent on intentId", async () => {
    expect((await createIntent(req(body))).status).toBe(201);
    expect((await createIntent(req(body))).status).toBe(201);
    const list = await listIntents(new Request("http://x?principal=Mitra+Labs"));
    const matches = (await list.json()).data.filter((i: { intentId: string }) => i.intentId === "intent_pk1_1");
    expect(matches).toHaveLength(1);
  });
});
