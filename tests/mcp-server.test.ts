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
import { prepareStore } from "./fixtures";
import * as agreements from "@/app/api/v1/agreements/route";
import * as authorizations from "@/app/api/v1/authorizations/route";
import * as obligations from "@/app/api/v1/obligations/route";
import * as sagas from "@/app/api/v1/sagas/route";
import * as settlements from "@/app/api/v1/settlements/route";
import * as evidence from "@/app/api/v1/settlements/evidence/route";
import * as receipts from "@/app/api/v1/receipts/route";
import * as accounting from "@/app/api/v1/accounting/route";
import * as clearing from "@/app/api/v1/clearing/route";

type Handler = { GET?: (r: Request) => Promise<Response>; POST?: (r: Request) => Promise<Response> };
const ROUTES: Record<string, Handler> = {
  "/api/v1/agreements": agreements, "/api/v1/authorizations": authorizations, "/api/v1/obligations": obligations as Handler,
  "/api/v1/sagas": sagas, "/api/v1/settlements": settlements, "/api/v1/settlements/evidence": evidence,
  "/api/v1/receipts": receipts, "/api/v1/accounting": accounting, "/api/v1/clearing": clearing,
};

/** Every request the server made, so tests can assert what reached the API. */
let seen: Array<{ method: string; path: string; body?: unknown }>;
const inProcessApi: MitraApi = async ({ method, path, body }) => {
  seen.push({ method, path, body });
  const pathname = path.split("?")[0];
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
  seen = [];
});

describe("what the MCP server exposes", () => {
  it("lists exactly the served tools — never a withheld, unbacked or capital-moving one", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...servedToolNames()].sort());
    for (const withheld of ["mitra_fund_agreement", "mitra_accept_deliverable", "mitra_reject_deliverable"]) {
      expect(names, `${withheld} must stay off the surface until the API identifies callers`).not.toContain(withheld);
    }
    for (const verb of prohibitedDirectTools) expect(names).not.toContain(verb);
  });

  it("every surface tool has a status, and every non-served one a reason the agent is told", async () => {
    for (const name of mcpTools) expect(MCP_TOOL_STATUS[name]).toBeDefined();
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    for (const name of mcpTools.filter((n) => MCP_TOOL_STATUS[n].status !== "served")) {
      expect(instructions).toContain(name);
    }
  });

  it("calling a withheld tool is refused by the protocol, and nothing reaches the API", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "mitra_accept_deliverable", arguments: { agreementId: "agreement_77" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not found/i);
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

  it("read tools reach their routes", async () => {
    const client = await connect();
    for (const [name, args, path] of [
      ["mitra_get_obligations", {}, "/api/v1/obligations"],
      ["mitra_get_recovery", { runId: "run_501" }, "/api/v1/sagas?runId=run_501"],
      ["mitra_get_settlement", { agreementId: "ag_1" }, "/api/v1/settlements?agreementId=ag_1"],
      ["mitra_get_settlement", { settlementId: "set_x" }, "/api/v1/settlements/evidence?settlementId=set_x"],
      ["mitra_get_receipt", { runId: "run_501" }, "/api/v1/receipts?runId=run_501"],
      ["mitra_get_exposure", {}, "/api/v1/accounting"],
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
  it("an external MCP client opens an agreement, reads it back through the API, and cannot accept it", async () => {
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
      expect(accept.isError, "accept is withheld from the MCP surface").toBe(true);
    } finally {
      await client.close();
    }
  }, 90_000);
});
