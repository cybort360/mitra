/**
 * `/api/v1/mandates` — the root of the authority tree, now readable and (operator-plane)
 * creatable over HTTP.
 *
 * Through the real routes via the SDK, because the F100 guards live in the route and a
 * kernel-level test would never reach them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MitraClient } from "@/lib/sdk";
import { getStore } from "@/lib/store/provider";
import { ROUTE_BASE_URL, routeFetch } from "./route-fetch";
import { bindTestParties, prepareStore, TEST_PARTIES, type TestParty } from "./fixtures";

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

const as = (agentId: TestParty) =>
  new MitraClient({ baseUrl: ROUTE_BASE_URL, signer: TEST_PARTIES[agentId], chainId: 84532, agentId, fetch: routeFetch });

const NONCE = () => Math.random().toString(36).slice(2, 8);

const post = (body: unknown) =>
  routeFetch(`${ROUTE_BASE_URL}/api/v1/mandates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (qs: string) => routeFetch(`${ROUTE_BASE_URL}/api/v1/mandates${qs}`);

const valid = (over: Record<string, unknown> = {}) => ({
  name: "Test trading mandate",
  principal: "Mitra Labs",
  agentId: "agent_data_03",
  vaultId: "vault_sol_primary",
  asset: "USDC",
  budget: 1000,
  maxTransaction: 100,
  approvedChains: ["solana"],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...over,
});

describe("GET /api/v1/mandates", () => {
  it("lists the seeded mandates", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("filters by agentId", async () => {
    const res = await get("?agentId=agent_buyer_07");
    const body = await res.json();
    for (const m of body.data) expect(m.agentId).toBe("agent_buyer_07");
  });

  it("filters by principal and by vaultId", async () => {
    const byPrincipal = await (await get("?principal=Mitra%20Labs")).json();
    for (const m of byPrincipal.data) expect(m.principal).toBe("Mitra Labs");
    const byVault = await (await get("?vaultId=vault_sol_primary")).json();
    for (const m of byVault.data) expect(m.vaultId).toBe("vault_sol_primary");
  });

  it("fetches one by id, and 404s an unknown one", async () => {
    const created = await (await post(valid({ mandateId: `mandate_get_${NONCE()}` }))).json();
    const res = await get(`?mandateId=${created.data.mandateId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.mandateId).toBe(created.data.mandateId);

    const missing = await get("?mandateId=mandate_does_not_exist");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("MANDATE_NOT_FOUND");
  });
});

describe("POST /api/v1/mandates — schema guards", () => {
  it("creates a valid mandate", async () => {
    const id = `mandate_new_${NONCE()}`;
    const res = await post(valid({ mandateId: id }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ mandateId: id, status: "ACTIVE", version: 1, nonce: 0, budget: 1000 });
  });

  it("assigns an id when none is given", async () => {
    const res = await post(valid());
    expect(res.status).toBe(201);
    expect((await res.json()).data.mandateId).toMatch(/^mandate_/);
  });

  it("REFUSES an expiry in the past", async () => {
    const res = await post(valid({ expiresAt: "2020-01-01T00:00:00Z" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("EXPIRES_AT_IN_PAST");
  });

  it("REFUSES a per-transaction ceiling above the whole budget", async () => {
    // Not a tighter limit — a contradictory one. Every transaction up to maxTransaction
    // would be refused, so the mandate looks real and can never be used.
    const res = await post(valid({ budget: 100, maxTransaction: 500 }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("MAX_TRANSACTION_EXCEEDS_BUDGET");
  });

  it("REFUSES a velocity window above the budget", async () => {
    const res = await post(valid({ budget: 100, maxTransaction: 50, velocityLimit: { amount: 500, windowMinutes: 60 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("VELOCITY_EXCEEDS_BUDGET");
  });

  it("REFUSES a non-positive budget or ceiling", async () => {
    expect((await post(valid({ budget: 0 }))).status).toBe(400);
    expect((await post(valid({ budget: 10, maxTransaction: -1 }))).status).toBe(400);
  });

  it("REFUSES an unknown asset or chain rather than storing it", async () => {
    // A typo'd chain would otherwise be stored and read by the settlement binding check,
    // where an unrecognised value must fail loudly rather than silently widen.
    expect((await post(valid({ asset: "DOGE" }))).status).toBe(400);
    expect((await post(valid({ approvedChains: ["ethereum"] }))).status).toBe(400);
  });
});

describe("POST /api/v1/mandates — the F100 guards", () => {
  it("is first-write-wins: an existing id is 409 MANDATE_EXISTS, never replaced", async () => {
    const id = `mandate_dup_${NONCE()}`;
    expect((await post(valid({ mandateId: id, budget: 1000 }))).status).toBe(201);
    const again = await post(valid({ mandateId: id, budget: 999_999, maxTransaction: 999_999 }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("MANDATE_EXISTS");

    // The original ceiling survives — raising one silently is the whole hazard.
    const stored = await (await get(`?mandateId=${id}`)).json();
    expect(stored.data.budget).toBe(1000);
  });

  it("REFUSES a mandate over a vault that does not exist", async () => {
    // Authority over nothing is a record nobody can enforce.
    const res = await post(valid({ vaultId: "vault_does_not_exist" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("VAULT_NOT_FOUND");
  });

  it("REFUSES a mandate to an agent that is not registered", async () => {
    const res = await post(valid({ agentId: "agent_never_registered" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("AGENT_NOT_REGISTERED");
  });

  it("REFUSES a mandate that does not approve the chain of its own vault", async () => {
    const res = await post(valid({ approvedChains: ["base"], vaultId: "vault_sol_primary" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("VAULT_CHAIN_NOT_APPROVED");
  });

  it("records an AUTHORITY event, so a ceiling has an audit trail", async () => {
    const id = `mandate_ev_${NONCE()}`;
    await post(valid({ mandateId: id }));
    const { repo } = await getStore();
    const events = await repo.listEvents(`run_${id}`);
    expect(events.some((e) => e.kind === "AUTHORITY")).toBe(true);
  });
});

describe("SDK round-trip", () => {
  it("client.mandates.get and .list read what POST created", async () => {
    const sdk = as("agent_data_03");
    const id = `mandate_sdk_${NONCE()}`;
    await post(valid({ mandateId: id, agentId: "agent_data_03" }));

    const one = await sdk.mandates.get(id);
    expect(one).toMatchObject({ mandateId: id, agentId: "agent_data_03" });

    const listed = await sdk.mandates.list({ agentId: "agent_data_03" });
    expect(listed.map((m) => m.mandateId)).toContain(id);
  });

  it("has NO client.mandates.create — granting authority is not an agent verb (F100)", async () => {
    // The agent-facing client carries no capital-issuing verb. Minting the limit every later
    // authorization is checked against is the opposite of an intent verb.
    const sdk = as("agent_data_03") as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(sdk.mandates).sort()).toEqual(["get", "list"]);
    expect(sdk.mandates.create).toBeUndefined();
  });
});
/**
 * F100 — minting authority is pausable.
 *
 * An Authorization is bounded by a Mandate that already exists, so granting one during an
 * incident is contained. A Mandate is not bounded by anything, so granting one is how an
 * agent acquires a ceiling nobody intended to give it. It has its own pause scope for that
 * reason, and a scope nobody exercises is a scope that does not work.
 */
describe("the authority pause scope stops Mandate creation", () => {
  it("answers 503 while authority is paused, and the mandate is not written", async () => {
    const { setPauseState, __resetIncidentStoreForTests } = await import("@/lib/admin/incident");
    await __resetIncidentStoreForTests();
    const id = `mandate_paused_${NONCE()}`;

    await setPauseState({ paused: true, scopes: ["authority"], reason: "suspected key leak" });
    try {
      const res = await post(valid({ mandateId: id }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("SYSTEM_PAUSED");
    } finally {
      await setPauseState({ paused: false, scopes: [], reason: "" });
      await __resetIncidentStoreForTests();
    }

    // Not merely refused — never written.
    expect((await get(`?mandateId=${id}`)).status).toBe(404);
  });
});
