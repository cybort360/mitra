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

/**
 * A fresh intent body per call, with a per-process nonce.
 *
 * Two distinct problems, both invisible in memory:
 *
 * 1. `prepareStore()` in `beforeEach` resets the IN-MEMORY store between tests. Against a
 *    real Postgres it resets nothing, so a shared `intentId` made the second test's create
 *    an idempotent REPLAY (200) instead of a fresh create (201).
 * 2. Even within one run, a FIXED `intentId` collides with the previous run's rows, because
 *    `mitra.intents` has a PRIMARY KEY and nothing is cleaned up. Worse, the F65 case —
 *    "refuses to overwrite an existing intent with a different body" — then compared
 *    against an intent left over from a previous run, so the refusal was not being
 *    exercised at all while the test still passed in memory.
 *
 * Same divergence class as F78; fixed here rather than only recorded.
 */
const NONCE = Math.random().toString(36).slice(2, 8);
let seq = 0;

const bodyBase = {
  runId: `run_501_${NONCE}`,
  principal: "Mitra Labs",
  initiatingAgentId: "agent_buyer_07",
  mandateId: "mandate_1",
  objective: "Research 100 unique projects",
  budget: { asset: "USDC", amount: 100 },
  constraints: ["bounded route only"],
  expiresAt: "2027-01-01T00:00:00Z",
};

const body = () => ({ ...bodyBase, intentId: `intent_pk1_${NONCE}_${++seq}` });

describe("intent lifecycle", () => {
  it("creates, reads back, and lists", async () => {
    const b = body();
    const created = await createIntent(req(b));
    expect(created.status).toBe(201);
    const cb = await created.json();
    expect(cb.data.intentId).toBe(b.intentId);
    expect(cb.data.version).toBe(1);

    const got = await getIntent(new Request("http://x"), { params: Promise.resolve({ id: b.intentId }) });
    expect(got.status).toBe(200);
    expect((await got.json()).data.objective).toBe(b.objective);

    const list = await listIntents(new Request("http://x"));
    const ids = (await list.json()).data.map((i: { intentId: string }) => i.intentId);
    expect(ids).toContain(b.intentId);
  });

  it("filters the list by principal", async () => {
    const b = body();
    await createIntent(req(b));
    const list = await listIntents(new Request("http://x?principal=Someone+Else"));
    expect((await list.json()).data.map((i: { intentId: string }) => i.intentId)).not.toContain(b.intentId);
  });

  it("404s an intent that does not exist", async () => {
    const res = await getIntent(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("refuses a zero budget and a past expiry", async () => {
    expect((await createIntent(req({ ...body(), budget: { asset: "USDC", amount: 0 } }))).status).toBe(400);
    expect((await createIntent(req({ ...body(), expiresAt: "2020-01-01T00:00:00Z" }))).status).toBe(400);
  });

  it("is idempotent on intentId for identical body", async () => {
    // ONE body for both creates — that is what "identical body" means. Generating a fresh
    // id for the replay would make this test assert that a different intent is refused.
    const b = body();
    expect((await createIntent(req(b))).status).toBe(201);
    const replay = await createIntent(req(b));
    expect(replay.status).toBe(200);
    const list = await listIntents(new Request("http://x?principal=Mitra+Labs"));
    const matches = (await list.json()).data.filter((i: { intentId: string }) => i.intentId === b.intentId);
    expect(matches).toHaveLength(1);
  });

  it("refuses to overwrite an existing intent with a different body (F65)", async () => {
    const b = body();
    expect((await createIntent(req(b))).status).toBe(201);
    const overwriting = await createIntent(
      req({ ...b, objective: "A completely different objective that must not overwrite" }),
    );
    expect(overwriting.status).toBe(409);
    expect((await overwriting.json()).error).toBe("INTENT_EXISTS");

    // The original intent survives untouched
    const got = await getIntent(new Request("http://x"), { params: Promise.resolve({ id: b.intentId }) });
    expect(got.status).toBe(200);
    expect((await got.json()).data.objective).toBe(b.objective);
  });
});
