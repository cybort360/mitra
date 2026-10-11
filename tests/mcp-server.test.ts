/**
 * Sprint item 4: the live MCP server, driven through the real protocol.
 *
 * An MCP SDK `Client` talks to `createMitraMcpServer` over the SDK's in-memory
 * transport, and the server's `MitraApi` dispatches into the real route handlers
 * in-process: tool call → route → kernel → store, with no network. The stdio entry
 * point is smoke-tested separately by spawning it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMitraMcpServer, MCP_TOOL_STATUS, servedToolNames, type MitraApi } from "@/lib/mcp/server";
import { mcpTools, prohibitedDirectTools } from "@/lib/mcp/surface";
import { TEST_PARTIES, bindTestParties, prepareStore, signedTransition } from "./fixtures";
import { mitraRequestTypedData, registrationRequest } from "@/lib/identity/signed-request";
import { privateKeyToAccount } from "viem/accounts";
import * as agreements from "@/app/api/v1/agreements/route";
import * as authorizations from "@/app/api/v1/authorizations/route";
import * as obligations from "@/app/api/v1/obligations/route";
import * as sagas from "@/app/api/v1/sagas/route";
import * as settlements from "@/app/api/v1/settlements/route";
import * as evidence from "@/app/api/v1/settlements/evidence/route";
import * as receipts from "@/app/api/v1/receipts/route";
import * as accounting from "@/app/api/v1/accounting/route";
import * as clearing from "@/app/api/v1/clearing/route";
import * as events from "@/app/api/v1/events/route";
import * as agents from "@/app/api/v1/agents/route";
import * as intents from "@/app/api/v1/intents/route";
import * as intentById from "@/app/api/v1/intents/[id]/route";

type Handler = { GET?: (r: Request) => Promise<Response>; POST?: (r: Request) => Promise<Response> };
const ROUTES: Record<string, Handler> = {
  "/api/v1/agreements": agreements, "/api/v1/authorizations": authorizations, "/api/v1/obligations": obligations as Handler,
  "/api/v1/sagas": sagas, "/api/v1/settlements": settlements, "/api/v1/settlements/evidence": evidence,
  "/api/v1/receipts": receipts, "/api/v1/accounting": accounting, "/api/v1/clearing": clearing, "/api/v1/events": events, "/api/v1/agents": agents,
  "/api/v1/intents": intents,
};
/** Dynamic routes, matched by prefix: `/api/v1/intents/{id}`. */
const BY_ID: Record<string, { GET: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }> = {
  "/api/v1/intents/": intentById,
};

/** Every request the server made, so tests can assert what reached the API. */
let seen: Array<{ method: string; path: string; body?: unknown }>;
const inProcessApi: MitraApi = async ({ method, path, body }) => {
  seen.push({ method, path, body });
  const pathname = path.split("?")[0];
  const prefix = Object.keys(BY_ID).find((p) => pathname.startsWith(p) && pathname.length > p.length);
  if (prefix && method === "GET") {
    const res = await BY_ID[prefix].GET(new Request(`http://localhost${path}`), { params: Promise.resolve({ id: decodeURIComponent(pathname.slice(prefix.length)) }) });
    return { status: res.status, body: await res.json() };
  }
  const handler = ROUTES[pathname]?.[method];
  if (!handler) return { status: 404, body: { error: "NO_ROUTE", path } };
  const res = await (handler as (r: Request) => Promise<Response>)(new Request(`http://localhost${path}`, {
    method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  }));
  return { status: res.status, body: await res.json() };
};

async function connect() {
  const server = createMitraMcpServer(inProcessApi);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
  seen = [];
});

describe("what the MCP server exposes", () => {
  it("lists exactly the served tools — every surface tool, and never a capital-moving one", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...servedToolNames()].sort());
    // Withheld until F55; served now that each carries the agent's own signature
    // and the API verifies it (decision ctx_d236086bde9601ee).
    for (const signed of ["mitra_fund_agreement", "mitra_accept_deliverable", "mitra_reject_deliverable", "mitra_register_agent"]) {
      expect(names, `${signed} is served behind a signed request`).toContain(signed);
    }
    // Unbacked until LP-1 gave intents a store and routes (PP-1).
    expect(names).toContain("mitra_create_intent");
    expect(names).toContain("mitra_get_intent");
    expect(names, "no surface tool is left unbacked or withheld").toEqual([...mcpTools].sort());
    for (const verb of prohibitedDirectTools) expect(names).not.toContain(verb);
  });

  it("registers and lists the 5 cognitive role skills as MCP prompts", async () => {
    const client = await connect();
    const prompts = (await client.listPrompts()).prompts;
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      "mitra-buyer",
      "mitra-core",
      "mitra-evaluator",
      "mitra-provider",
      "mitra-treasury",
    ]);
    const corePrompt = await client.getPrompt({ name: "mitra-core" });
    expect(corePrompt.messages.length).toBeGreaterThan(0);
    expect(corePrompt.messages[0].content.type).toBe("text");
    expect((corePrompt.messages[0].content as { text: string }).text).toContain("Mitra core");
  });

  it("every surface tool has a status, and every non-served one a reason the agent is told", async () => {
    for (const name of mcpTools) expect(MCP_TOOL_STATUS[name]).toBeDefined();
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    for (const name of mcpTools.filter((n) => MCP_TOOL_STATUS[n].status !== "served")) {
      expect(instructions).toContain(name);
    }
  });

  it("calling a tool that is not served is refused by the protocol, and nothing reaches the API", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "raw_arbitrary_transfer", arguments: { to: "0xdead", amount: 1 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not found/i);
    expect(seen).toEqual([]);
  });
});

describe("signed tools (F55): the agent's signature passes through, and the API decides", () => {
  /** Open, fund, start and submit through the API, each signed by its role-holder. */
  async function submitted(id: string) {
    const post = (b: unknown) => agreements.POST(new Request("http://localhost/api/v1/agreements", { method: "POST", body: JSON.stringify(b) }));
    expect((await post({ op: "open", spaceId: "space_research_1",
      draft: { agreementId: id, runId: `run_${id}`, intentId: `intent_${id}`, client: "agent_buyer_07", provider: "agent_data_03",
        evaluator: "agent_eval_02", price: { asset: "USDC", amount: 5 }, deadline: "2027-01-01T00:00:00Z" },
      proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } } })).status).toBe(201);
    expect((await post(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: id }))).status).toBe(200);
    expect((await post(await signedTransition("agent_data_03", "FUNDED", { op: "startExecution", agreementId: id }))).status).toBe(200);
  }

  it("mitra_submit_deliverable and mitra_accept_deliverable apply only for the party that signed", async () => {
    await submitted("ag_mcp_signed");
    const client = await connect();
    const { auth: submitAuth } = await signedTransition("agent_data_03", "EXECUTING", {
      op: "submitDeliverable", agreementId: "ag_mcp_signed", contentHash: "sha256:x", artifactRefs: ["ipfs://r"],
    });
    const submit = await client.callTool({ name: "mitra_submit_deliverable", arguments: {
      agreementId: "ag_mcp_signed", contentHash: "sha256:x", artifactRefs: ["ipfs://r"], auth: submitAuth } });
    expect(submit.isError, JSON.stringify(submit.content)).toBe(false);

    // The provider signs validly as itself, but may not accept its own work.
    const { auth: providerAuth } = await signedTransition("agent_data_03", "SUBMITTED", { op: "acceptDeliverable", agreementId: "ag_mcp_signed" });
    const selfAccept = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: "ag_mcp_signed", auth: providerAuth } });
    expect(selfAccept.isError).toBe(true);
    expect(textOf(selfAccept).error).toBe("ACTOR_NOT_PERMITTED");

    const { auth } = await signedTransition("agent_eval_02", "SUBMITTED", { op: "acceptDeliverable", agreementId: "ag_mcp_signed" });
    const accept = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: "ag_mcp_signed", auth } });
    expect(accept.isError, JSON.stringify(accept.content)).toBe(false);
    expect(textOf(accept).data.agreement.status).toBe("ACCEPTED");
    expect(seen.at(-1)?.body, "the signature reaches the API unchanged").toMatchObject({ op: "acceptDeliverable", auth });
  });

  it("mitra_fund_agreement and mitra_reject_deliverable forward their signatures", async () => {
    const post = (b: unknown) => agreements.POST(new Request("http://localhost/api/v1/agreements", { method: "POST", body: JSON.stringify(b) }));
    expect((await post({ op: "open", spaceId: "space_research_1",
      draft: { agreementId: "ag_mcp_fr", runId: "run_fr", intentId: "intent_fr", client: "agent_buyer_07", provider: "agent_data_03",
        evaluator: "agent_eval_02", price: { asset: "USDC", amount: 5 }, deadline: "2027-01-01T00:00:00Z" },
      proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } } })).status).toBe(201);
    const client = await connect();
    const fundBody = { op: "fund", agreementId: "ag_mcp_fr", capability: "research", amount: { asset: "USDC", amount: 5 } };
    const { auth: fundAuth } = await signedTransition("agent_buyer_07", "OPEN", fundBody);
    const fund = await client.callTool({ name: "mitra_fund_agreement", arguments: {
      agreementId: "ag_mcp_fr", capability: "research", amount: { asset: "USDC", amount: 5 }, auth: fundAuth } });
    expect(fund.isError, JSON.stringify(fund.content)).toBe(false);
    expect(textOf(fund).data.agreement.status).toBe("FUNDED");

    expect((await post(await signedTransition("agent_data_03", "FUNDED", { op: "startExecution", agreementId: "ag_mcp_fr" }))).status).toBe(200);
    expect((await post(await signedTransition("agent_data_03", "EXECUTING", { op: "submitDeliverable", agreementId: "ag_mcp_fr", contentHash: "sha256:y", artifactRefs: ["a"] }))).status).toBe(200);
    const { auth: rejectAuth } = await signedTransition("agent_eval_02", "SUBMITTED", { op: "rejectDeliverable", agreementId: "ag_mcp_fr", failureReason: "WRONG_OUTPUT" });
    const reject = await client.callTool({ name: "mitra_reject_deliverable", arguments: { agreementId: "ag_mcp_fr", failureReason: "WRONG_OUTPUT", auth: rejectAuth } });
    expect(reject.isError, JSON.stringify(reject.content)).toBe(false);
    expect(textOf(reject).data.agreement.status).toBe("REJECTED");
  });

  it("mitra_register_agent registers an agent whose wallets signed", async () => {
    const key = privateKeyToAccount(`0x${"f6".repeat(32)}`);
    const agent = { agentId: "agent_mcp_new", name: "MCP Agent", owner: "Mitra Labs", wallets: [{ chain: "base", address: key.address }], capabilities: ["research"], protocols: ["mcp"] };
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const signature = await key.signTypedData(mitraRequestTypedData(registrationRequest(agent, expiresAt), 84532));
    const client = await connect();
    const r = await client.callTool({ name: "mitra_register_agent", arguments: { agent, expiresAt, proofs: [{ signer: key.address, chainId: 84532, signature }] } });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    expect(textOf(r).data.status).toBe("REGISTERED");
  });

  it("a signed tool called without a signature is refused before it reaches the API", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: "agreement_77" } })
      .catch((e: Error) => ({ isError: true, content: e.message }));
    expect(r.isError).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe("served tools go through the real routes", () => {
  it("mitra_create_agreement opens an agreement the store then holds", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "mitra_create_agreement",
      arguments: {
        spaceId: "space_research_1",
        draft: {
          agreementId: "ag_mcp_1", runId: "run_mcp", intentId: "intent_mcp", client: "agent_buyer_07",
          provider: "mech-research-backup-04", evaluator: "agent_eval_02", price: { asset: "USDC", amount: 5 },
          deadline: "2027-01-01T00:00:00Z",
        },
        proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } },
      },
    });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    expect(textOf(r).data.agreement.status).toBe("OPEN");
    const back = await agreements.GET(new Request("http://localhost/api/v1/agreements?agreementId=ag_mcp_1"));
    expect((await back.json()).data.status).toBe("OPEN");
  });

  it("mitra_create_agreement keeps the marketplace's external job refs (PRD §8.4)", async () => {
    const client = await connect();
    const refs = ["virtuals-acp:84532:0x8Db6B1c839Fc8f6bd35777E194677B67b4D51928:offering:0x67768f90d188992AfE2FD8705d4855d454b22cB9:x", "virtuals-acp:quote:sha256:ab"];
    const r = await client.callTool({ name: "mitra_create_agreement", arguments: {
      spaceId: "space_research_1",
      draft: { agreementId: "ag_mcp_refs", runId: "run_refs", intentId: "intent_refs", client: "agent_buyer_07", provider: "p", evaluator: "e",
        price: { asset: "USDC", amount: 1 }, deadline: "2027-01-01T00:00:00Z", externalJobRefs: refs },
      proposal: { capability: "research", amount: { asset: "USDC", amount: 1 } },
    } });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    const back = await agreements.GET(new Request("http://localhost/api/v1/agreements?agreementId=ag_mcp_refs"));
    expect((await back.json()).data.externalJobRefs).toEqual(refs);
  });

  it("an API refusal comes back as a tool error carrying the API's own reason", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "mitra_create_agreement",
      arguments: {
        spaceId: "space_does_not_exist",
        draft: {
          agreementId: "ag_x", runId: "r", intentId: "i", client: "agent_buyer_07", provider: "p", evaluator: "e",
          price: { asset: "USDC", amount: 5 }, deadline: "2027-01-01T00:00:00Z",
        },
        proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } },
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r).error).toBe("SPACE_NOT_FOUND");
  });

  it("mitra_request_authorization says ALLOW or DENY and reserves nothing", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "mitra_request_authorization",
      arguments: {
        mandateId: "mandate_research_public_v7", vaultId: "vault_sol_primary", amount: 5, asset: "USDC", chain: "solana",
        counterparty: "virtuals:research-agent-18", capability: "market_research",
      },
    });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    expect(["ALLOW", "DENY", "REVIEW"]).toContain(textOf(r).data.decision);
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/authorizations"]);
  });

  it("mitra_request_clearing can only ever ask for a netting preview", async () => {
    const client = await connect();
    // Even an agent that tries to smuggle an epoch action in gets the preview.
    const r = await client.callTool({ name: "mitra_request_clearing", arguments: { action: "finalize_epoch" } as never });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    expect((seen[0].body as { action: string }).action).toBe("net");
  });

  it("the clearing tool's action is fixed in toRequest itself, not only by schema stripping", async () => {
    const { SERVED_TOOLS } = await import("@/lib/mcp/server");
    const req = SERVED_TOOLS.mitra_request_clearing!.toRequest({ action: "finalize_epoch", epoch: {} });
    expect(req.body).toEqual({ action: "net" });
  });

  it("mitra_create_intent records an intent under a Mitra-assigned id, and mitra_get_intent reads it back", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "mitra_create_intent", arguments: {
      runId: "run_mcp_intent", principal: "Mitra Labs", initiatingAgentId: "agent_buyer_07", mandateId: "mandate_research_public_v7",
      objective: "Find three data vendors", budget: { asset: "USDC", amount: 25 }, constraints: ["no PII"], expiresAt: "2027-01-01T00:00:00Z",
    } });
    expect(r.isError, JSON.stringify(r.content)).toBe(false);
    const { intentId } = textOf(r).data;
    expect(intentId).toMatch(/^intent_/);
    const got = await client.callTool({ name: "mitra_get_intent", arguments: { intentId } });
    expect(got.isError, JSON.stringify(got.content)).toBe(false);
    expect(textOf(got).data).toMatchObject({ intentId, objective: "Find three data vendors", budget: { asset: "USDC", amount: 25 } });
  });

  it("mitra_create_intent never forwards a caller-chosen intentId (F65: the route upserts on it)", async () => {
    const client = await connect();
    const args = { runId: "run_victim", principal: "Mitra Labs", initiatingAgentId: "agent_buyer_07", mandateId: "m",
      objective: "original", budget: { asset: "USDC", amount: 10 }, constraints: [], expiresAt: "2027-01-01T00:00:00Z" };
    const first = textOf(await client.callTool({ name: "mitra_create_intent", arguments: args })).data.intentId;
    // An agent that names the victim's id gets its own new intent; the victim's is untouched.
    const second = await client.callTool({ name: "mitra_create_intent", arguments: { ...args, intentId: first, objective: "hijacked" } as never });
    expect(second.isError, JSON.stringify(second.content)).toBe(false);
    expect(textOf(second).data.intentId).not.toBe(first);
    expect((seen.at(-1)?.body as Record<string, unknown>).intentId).toBeUndefined();
    const { SERVED_TOOLS } = await import("@/lib/mcp/server");
    expect((SERVED_TOOLS.mitra_create_intent!.toRequest({ ...args, intentId: first }).body as Record<string, unknown>).intentId).toBeUndefined();
    const victim = await client.callTool({ name: "mitra_get_intent", arguments: { intentId: first } });
    expect(textOf(victim).data.objective).toBe("original");
  });

  it("mitra_get_intent on an unknown id is a tool error with the API's reason", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "mitra_get_intent", arguments: { intentId: "intent_nope/../x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r).error).toBe("INTENT_NOT_FOUND");
    expect(seen.at(-1)?.path).toBe("/api/v1/intents/intent_nope%2F..%2Fx");
  });

  it("an intent the API refuses (past expiry) comes back as a tool error", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "mitra_create_intent", arguments: {
      runId: "r", principal: "p", initiatingAgentId: "a", mandateId: "m", objective: "o",
      budget: { asset: "USDC", amount: 1 }, constraints: [], expiresAt: "2020-01-01T00:00:00Z",
    } });
    expect(r.isError).toBe(true);
    expect(textOf(r).reason).toBe("EXPIRES_AT_IN_PAST");
  });

  it("read tools reach their routes", async () => {
    const client = await connect();
    for (const [name, args, path] of [
      ["mitra_get_obligations", {}, "/api/v1/obligations"],
      ["mitra_get_recovery", { runId: "run_501" }, "/api/v1/sagas?runId=run_501"],
      ["mitra_get_settlement", { agreementId: "ag_1" }, "/api/v1/settlements?agreementId=ag_1"],
      ["mitra_get_settlement", { settlementId: "set_x" }, "/api/v1/settlements/evidence?settlementId=set_x"],
      ["mitra_get_receipt", { runId: "run_501" }, "/api/v1/receipts?runId=run_501"],
      ["mitra_get_exposure", {}, "/api/v1/accounting"],
      ["mitra_get_timeline", { runId: "run_501" }, "/api/v1/events?runId=run_501"],
      ["mitra_get_agent", { agentId: "agent_buyer_07" }, "/api/v1/agents?agentId=agent_buyer_07"],
      ["mitra_find_agents", { capability: "market_research", chain: "solana" }, "/api/v1/agents?capability=market_research&chain=solana"],
      ["mitra_get_intent", { intentId: "intent_1" }, "/api/v1/intents/intent_1"],
      ["mitra_get_inbox", { agentId: "agent_data_03" }, "/api/v1/inbox/agent_data_03"],
      ["mitra_get_inbox", { agentId: "a/b", kinds: ["WORK_REQUIRED", "SETTLEMENT_RECEIPT"] }, "/api/v1/inbox/a%2Fb?kind=WORK_REQUIRED%2CSETTLEMENT_RECEIPT"],
    ] as const) {
      seen = [];
      await client.callTool({ name, arguments: args });
      expect(seen[0]?.path, name).toBe(path);
    }
  });
});

describe("the stdio entry point", () => {
  it("starts, speaks MCP on stdio, and lists the served tools", async () => {
    const transport = new StdioClientTransport({
      command: "npx", args: ["tsx", "scripts/mitra-mcp.ts"],
      env: { ...process.env, MITRA_API_URL: "http://127.0.0.1:9" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...servedToolNames()].sort());
    } finally {
      await client.close();
    }
  }, 60_000);
});

/**
 * Over real HTTP, against a running Mitra (`next start`): the stdio server is
 * spawned with MITRA_API_URL and drives the API exactly as an external agent's
 * MCP client would.
 *
 *   MITRA_API_URL=http://localhost:3017 npx vitest run tests/mcp-server.test.ts -t "over HTTP"
 */
describe.skipIf(!process.env.MITRA_API_URL)("over HTTP against a running Mitra (MITRA_API_URL)", () => {
  it("an external MCP client opens an agreement, reads it back through the API, and cannot accept it unsigned", async () => {
    const transport = new StdioClientTransport({
      command: "npx", args: ["tsx", "scripts/mitra-mcp.ts"],
      env: { ...process.env } as Record<string, string>, stderr: "pipe",
    });
    const client = new Client({ name: "external-agent", version: "0" });
    await client.connect(transport);
    try {
      const id = `ag_mcp_http_${Date.now()}`;
      const opened = await client.callTool({
        name: "mitra_create_agreement",
        arguments: {
          spaceId: "space_research_1",
          draft: {
            agreementId: id, runId: `run_${id}`, intentId: `intent_${id}`, client: "agent_buyer_07",
            provider: "mech-research-backup-04", evaluator: "agent_eval_02", price: { asset: "USDC", amount: 1 },
            deadline: "2027-01-01T00:00:00Z",
          },
          proposal: { capability: "research", amount: { asset: "USDC", amount: 1 } },
        },
      });
      expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
      const back = await (await fetch(`${process.env.MITRA_API_URL}/api/v1/agreements?agreementId=${id}`)).json();
      console.log(`mcp over http: opened ${id}, API reads back status ${back.data?.status} (backend ${back.backend})`);
      expect(back.data.status).toBe("OPEN");

      const exposure = await client.callTool({ name: "mitra_get_exposure", arguments: {} });
      expect(exposure.isError).toBe(false);

      const accept = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: id } });
      expect(accept.isError, "an unsigned accept is refused (F55)").toBe(true);
    } finally {
      await client.close();
    }
  }, 90_000);

  it("over the network: bound to 0.0.0.0 with a token, remote clients on both wire formats open agreements the API holds", async () => {
    const { spawn: spawnChild } = await import("node:child_process");
    const { SSEClientTransport: Sse } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport: Streamable } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const token = `tok_${"z".repeat(40)}`;
    const child = spawnChild("npx", ["tsx", "scripts/mitra-mcp.ts", "--transport", "sse", "--port", "0", "--host", "0.0.0.0"],
      { detached: true, env: { ...process.env, MITRA_MCP_TOKEN: token } });
    try {
      const port = await new Promise<string>((ok, fail) => {
        let err = "";
        child.stderr.on("data", (c) => { err += c; const m = /tools at http:\/\/0\.0\.0\.0:(\d+)\/sse/.exec(err); if (m) ok(m[1]); });
        child.on("exit", (code) => fail(new Error(`exited ${code}: ${err}`)));
      });
      const url = `http://127.0.0.1:${port}`;
      const headers = { authorization: `Bearer ${token}` };
      const unauth = await fetch(`${url}/healthz`);
      expect(unauth.status, "no token, no entry").toBe(401);
      const wires = {
        sse: () => new Sse(new URL(`${url}/sse`), { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } }),
        streamable: () => new Streamable(new URL(`${url}/mcp`), { requestInit: { headers } }),
      };
      for (const [wire, make] of Object.entries(wires)) {
        const client = new Client({ name: `remote-${wire}`, version: "0" });
        await client.connect(make());
        try {
          const id = `ag_mcp_${wire}_${Date.now()}`;
          const opened = await client.callTool({ name: "mitra_create_agreement", arguments: {
            spaceId: "space_research_1",
            draft: { agreementId: id, runId: `run_${id}`, intentId: `intent_${id}`, client: "agent_buyer_07", provider: "mech-research-backup-04",
              evaluator: "agent_eval_02", price: { asset: "USDC", amount: 1 }, deadline: "2027-01-01T00:00:00Z" },
            proposal: { capability: "research", amount: { asset: "USDC", amount: 1 } },
          } });
          expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
          const back = await (await fetch(`${process.env.MITRA_API_URL}/api/v1/agreements?agreementId=${id}`)).json();
          console.log(`mcp over ${wire} (0.0.0.0:${port}, bearer): opened ${id}, API reads back ${back.data?.status} (backend ${back.backend})`);
          expect(back.data.status).toBe("OPEN");
          const accept = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: id } });
          expect(accept.isError, "an unsigned accept is refused over the network too (F55)").toBe(true);
        } finally {
          await client.close();
        }
      }
    } finally {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    }
  }, 120_000);
});

// ── The network transport (Phase 5): legacy SSE and Streamable HTTP ──────────

import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { afterEach as afterEachHttp } from "vitest";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpOptions, type McpHttpServer } from "@/lib/mcp/http";

const TOKEN = "t".repeat(40);
let running: McpHttpServer[] = [];
afterEachHttp(async () => { await Promise.all(running.map((s) => s.close())); running = []; });

async function serve(over: Partial<McpHttpOptions> = {}) {
  const s = await startMcpHttpServer({ api: inProcessApi, port: 0, ...over });
  running.push(s);
  return s;
}

const WIRES = {
  sse: (url: string, headers?: Record<string, string>) => new SSEClientTransport(new URL(`${url}/sse`), { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } }),
  streamable: (url: string, headers?: Record<string, string>) => new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }),
} as const;

async function connectOver(wire: keyof typeof WIRES, url: string, headers?: Record<string, string>) {
  const client = new Client({ name: `remote-agent-${wire}`, version: "0" });
  await client.connect(WIRES[wire](url, headers));
  return client;
}

/** A raw request, so Host and Origin can be set to whatever an attacker would send. */
function raw(url: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const u = new URL(url);
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; if (res.headers["content-type"]?.includes("event-stream")) res.destroy(); });
      res.on("end", () => ok({ status: res.statusCode!, body }));
      res.on("close", () => ok({ status: res.statusCode!, body }));
    });
    r.on("error", fail);
    r.end(opts.body);
  });
}

for (const wire of ["sse", "streamable"] as const) {
  describe(`over the network (${wire})`, () => {
    it("lists exactly the served tools, opens an agreement the store holds, and refuses an unsigned accept without reaching the API", async () => {
      const s = await serve();
      const client = await connectOver(wire, s.url);
      try {
        expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...servedToolNames()].sort());
        const id = `ag_mcp_${wire}`;
        const opened = await client.callTool({ name: "mitra_create_agreement", arguments: {
          spaceId: "space_research_1",
          draft: { agreementId: id, runId: `run_${id}`, intentId: `intent_${id}`, client: "agent_buyer_07", provider: "mech-research-backup-04",
            evaluator: "agent_eval_02", price: { asset: "USDC", amount: 1 }, deadline: "2027-01-01T00:00:00Z" },
          proposal: { capability: "research", amount: { asset: "USDC", amount: 1 } },
        } });
        expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
        const back = await (agreements.GET as (r: Request) => Promise<Response>)(new Request(`http://localhost/api/v1/agreements?agreementId=${id}`));
        expect((await back.json()).data.status).toBe("OPEN");

        const before = seen.length;
        const accept = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: id } }).catch((e: Error) => ({ isError: true, content: e.message }));
        expect(accept.isError, "an unsigned accept is refused (F55)").toBe(true);
        expect(seen.length, "an unsigned call reaches no route").toBe(before);
      } finally {
        await client.close();
      }
    }, 30_000);

    it("with a token: no token and a wrong token are refused; the right one connects", async () => {
      const s = await serve({ token: TOKEN });
      await expect(connectOver(wire, s.url)).rejects.toThrow();
      await expect(connectOver(wire, s.url, { authorization: `Bearer ${"x".repeat(40)}` })).rejects.toThrow();
      const client = await connectOver(wire, s.url, { authorization: `Bearer ${TOKEN}` });
      try {
        expect((await client.listTools()).tools.length).toBe(servedToolNames().length);
      } finally {
        await client.close();
      }
    }, 30_000);
  });
}

describe("network transport — who can connect", () => {
  it("refuses to bind off loopback without a token, and refuses a short token", async () => {
    await expect(startMcpHttpServer({ api: inProcessApi, port: 0, host: "0.0.0.0" })).rejects.toThrow("MCP_TOKEN_REQUIRED_OFF_LOOPBACK");
    await expect(startMcpHttpServer({ api: inProcessApi, port: 0, token: "short" })).rejects.toThrow("MCP_TOKEN_TOO_SHORT");
    const s = await serve({ host: "0.0.0.0", token: TOKEN });
    expect((await raw(s.url.replace("0.0.0.0", "127.0.0.1"), "/healthz")).status).toBe(401);
  });

  it("every endpoint demands the token when one is set", async () => {
    const s = await serve({ token: TOKEN });
    for (const [method, path] of [["GET", "/healthz"], ["GET", "/sse"], ["POST", "/messages?sessionId=x"], ["POST", "/mcp"], ["GET", "/mcp"]]) {
      expect((await raw(s.url, path, { method, body: method === "POST" ? "{}" : undefined })).status, `${method} ${path}`).toBe(401);
    }
    expect((await raw(s.url, "/healthz", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("DNS rebinding: on loopback, a Host header naming another site is refused", async () => {
    const s = await serve();
    const port = new URL(s.url).port;
    expect((await raw(s.url, "/healthz", { headers: { host: `attacker.example:${port}` } })).status).toBe(403);
    expect((await raw(s.url, "/sse", { headers: { host: `attacker.example:${port}` } })).status).toBe(403);
    expect((await raw(s.url, "/healthz", { headers: { host: `localhost:${port}` } })).status).toBe(200);
  });

  it("a browser origin is refused unless allowed", async () => {
    const s = await serve({ allowedOrigins: ["https://console.mitra.test"] });
    expect((await raw(s.url, "/healthz", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw(s.url, "/sse", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw(s.url, "/healthz", { headers: { origin: "https://console.mitra.test" } })).status).toBe(200);
  });
});

describe("network transport — sessions and malformed input", () => {
  it("sessions are separate, counted, capped, and released on close", async () => {
    const s = await serve({ maxSessions: 2 });
    const a = await connectOver("sse", s.url);
    const b = await connectOver("streamable", s.url);
    expect(s.sessionCount()).toBe(2);
    expect((await raw(s.url, "/sse")).status, "over the cap").toBe(503);
    await expect(connectOver("streamable", s.url)).rejects.toThrow();
    await a.close();
    // A well-behaved Streamable HTTP client ends its session with DELETE.
    await (b.transport as StreamableHTTPClientTransport).terminateSession();
    await b.close();
    for (let i = 0; i < 50 && s.sessionCount() > 0; i++) await new Promise((ok) => setTimeout(ok, 20));
    expect(s.sessionCount()).toBe(0);
    const c = await connectOver("sse", s.url);
    expect((await c.listTools()).tools.length).toBe(servedToolNames().length);
    await c.close();
  }, 30_000);

  it("a Streamable HTTP client that walks away without DELETE does not hold its slot forever", async () => {
    const s = await serve({ maxSessions: 1, idleMs: 200 });
    const gone = await connectOver("streamable", s.url);
    await gone.close(); // no terminateSession(): the server is never told
    expect(s.sessionCount()).toBe(1);
    for (let i = 0; i < 50 && s.sessionCount() > 0; i++) await new Promise((ok) => setTimeout(ok, 50));
    expect(s.sessionCount(), "the idle session was reaped").toBe(0);
    const next = await connectOver("streamable", s.url);
    expect((await next.listTools()).tools.length).toBe(servedToolNames().length);
    await next.close();
  }, 30_000);

  it("a session in use is not reaped", async () => {
    const s = await serve({ idleMs: 300 });
    const busy = await connectOver("streamable", s.url);
    for (let i = 0; i < 8; i++) {
      await new Promise((ok) => setTimeout(ok, 120));
      expect((await busy.listTools()).tools.length).toBe(servedToolNames().length);
    }
    expect(s.sessionCount()).toBe(1);
    await busy.close();
  }, 30_000);

  it("a session id from one wire format is unknown on the other", async () => {
    const s = await serve();
    const st = await connectOver("streamable", s.url);
    const sid = (st.transport as StreamableHTTPClientTransport).sessionId!;
    const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await raw(s.url, `/messages?sessionId=${sid}`, { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    await st.close();
  }, 30_000);

  it("unknown sessions, missing sessions, oversized and malformed bodies are refused", async () => {
    const s = await serve({ maxBodyBytes: 1024 });
    const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await raw(s.url, "/messages?sessionId=nope", { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    expect((await raw(s.url, "/mcp", { method: "POST", headers: { ...json, "mcp-session-id": "nope" }, body: "{}" })).status).toBe(404);
    expect((await raw(s.url, "/mcp", { method: "GET" })).status, "no session and not initialize").toBe(400);
    // Refused by us, before any server is built for it — not by the SDK after.
    const notInit = await raw(s.url, "/mcp", { method: "POST", headers: json, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(notInit.status).toBe(400);
    expect(JSON.parse(notInit.body).error).toBe("SESSION_REQUIRED");
    expect((await raw(s.url, "/mcp", { method: "POST", headers: json, body: "x".repeat(2048) })).status).toBe(413);
    expect((await raw(s.url, "/mcp", { method: "POST", headers: json, body: "{not json" })).status).toBe(400);
    expect((await raw(s.url, "/nowhere")).status).toBe(404);
    expect(s.sessionCount()).toBe(0);
  });
});

/**
 * npx → sh → tsx → node: a signal to the npx process does not reach the server, which
 * then outlives the test still listening. Each spawn gets its own process group, and
 * the whole group is stopped.
 */
const killGroup = (pid: number | undefined) => { try { if (pid) process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } };

describe("the network entry point", () => {
  const spawnMcp = (args: string[], env: Record<string, string> = {}) =>
    spawn("npx", ["tsx", "scripts/mitra-mcp.ts", ...args], { detached: true, env: { ...process.env, MITRA_API_URL: "http://127.0.0.1:9", ...env } });

  it("--transport sse --port 0 starts, prints its URL, and serves the tools over SSE", async () => {
    const child = spawnMcp(["--transport", "sse", "--port", "0"]);
    try {
      const url = await new Promise<string>((ok, fail) => {
        let err = "";
        child.stderr.on("data", (c) => { err += c; const m = /tools at (http:\/\/127\.0\.0\.1:\d+)\/sse/.exec(err); if (m) ok(m[1]); });
        child.on("exit", (code) => fail(new Error(`exited ${code}: ${err}`)));
      });
      const client = await connectOver("sse", url);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...servedToolNames()].sort());
      await client.close();
    } finally {
      killGroup(child.pid);
    }
  }, 60_000);

  it("refuses to start off loopback without a token", async () => {
    const child = spawnMcp(["--transport", "sse", "--port", "0", "--host", "0.0.0.0"], { MITRA_MCP_TOKEN: "" });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const code = await new Promise<number | null>((ok) => child.on("exit", ok));
    expect(code).not.toBe(0);
    expect(err).toContain("MCP_TOKEN_REQUIRED_OFF_LOOPBACK");
  }, 60_000);
});
