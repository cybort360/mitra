/**
 * PP-1 (Phase 5 exit condition): "An external agent can participate without
 * becoming Mitra-native."
 *
 * Unlike tests/mcp-server.test.ts, nothing here is in-process. Both hops are real
 * sockets:
 *
 *   external MCP client ──(Streamable HTTP | stdio)──▶ Mitra MCP server
 *        ──(HTTP, httpApi)──▶ Mitra API (the real route handlers) ──▶ kernel ──▶ store
 *
 * The API is served by a plain node:http server that dispatches to the route
 * modules under app/api/v1, so this needs no `next build`; the route code is the
 * same code `next start` runs. The stdio wire spawns scripts/mitra-mcp.ts, pointed
 * at that server by MITRA_API_URL, exactly as an operator would run it.
 *
 * Three parties, three MCP sessions, and each holds ONLY a wallet key generated
 * here: a client, a provider and an evaluator, none of which Mitra has seen
 * before. Each registers itself over MCP. The one step outside MCP is the
 * operator creating the Space they trade in, over plain HTTP, because opening a
 * Space is a principal's act and not an agent verb. No party holds a Mitra key,
 * a store handle, or a capital verb. Every transition is signed by the party
 * that makes it, and the API, not the MCP server, decides.
 *
 * Because nothing depends on seeded test keys, the same test runs against a
 * running Mitra:
 *
 *   MITRA_E2E_API_URL=http://localhost:3017 npx vitest run tests/external-agent-e2e.test.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { MCP_TOOL_STATUS, httpApi } from "@/lib/mcp/server";
import { startMcpHttpServer, type McpHttpServer } from "@/lib/mcp/http";
import { mcpTools, prohibitedDirectTools } from "@/lib/mcp/surface";
import { mitraRequestTypedData, registrationRequest } from "@/lib/identity/signed-request";
import { prepareStore, signAs } from "./fixtures";

// ── The Mitra API over real HTTP ─────────────────────────────────────────────

type RouteModule = Partial<Record<"GET" | "POST", (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>>;

/** Every route module under app/api/v1, keyed by its URL pattern. */
const routeModules = import.meta.glob("../app/api/v1/**/route.ts") as Record<string, () => Promise<RouteModule>>;
const ROUTES = Object.entries(routeModules).map(([file, load]) => {
  const segments = file.replace("../app", "").replace(/\/route\.ts$/, "").split("/").filter(Boolean);
  return { segments, load };
});

function match(pathname: string): { load: () => Promise<RouteModule>; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  // Static segments win over dynamic ones, as in Next.
  const ranked = [...ROUTES].sort((a, b) => a.segments.filter((s) => s.startsWith("[")).length - b.segments.filter((s) => s.startsWith("[")).length);
  for (const r of ranked) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.segments.every((s, i) => {
      if (s.startsWith("[") && s.endsWith("]")) { params[s.slice(1, -1)] = decodeURIComponent(parts[i]); return true; }
      return s === parts[i];
    })) return { load: r.load, params };
  }
  return null;
}

/** What reached the API, in order: the MCP server's traffic as the API saw it. */
let apiLog: Array<{ method: string; path: string; status: number }> = [];

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const route = match(url.pathname);
  const method = (req.method ?? "GET") as "GET" | "POST";
  const handler = route ? (await route.load())[method] : undefined;
  let status = 404;
  let body = JSON.stringify({ error: "NO_ROUTE", path: url.pathname });
  if (route && handler) {
    const request = new Request(url, {
      method, headers: req.headers as Record<string, string>,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handler(request, { params: Promise.resolve(route.params) });
    status = response.status;
    body = await response.text();
  }
  apiLog.push({ method, path: url.pathname + url.search, status });
  res.writeHead(status, { "content-type": "application/json" }).end(body);
}

/** Set to drive a running Mitra (`next start`) instead of the in-test API server. */
const EXTERNAL_API = process.env.MITRA_E2E_API_URL?.replace(/\/+$/, "");
let api: Server | undefined;
let apiUrl: string;
let mcpHttp: McpHttpServer;

beforeAll(async () => {
  if (EXTERNAL_API) {
    apiUrl = EXTERNAL_API;
  } else {
    const server = createServer((req, res) => {
      handle(req, res).catch((e) => res.writeHead(500).end(JSON.stringify({ error: String(e) })));
    });
    api = server;
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  mcpHttp = await startMcpHttpServer({ api: httpApi(apiUrl), port: 0 });
});

afterAll(async () => {
  await mcpHttp?.close();
  if (api) await new Promise((ok) => api!.close(ok));
});

beforeEach(async () => {
  if (!EXTERNAL_API) await prepareStore();
  apiLog = [];
});

// ── The external agent's side ────────────────────────────────────────────────

const WIRES = {
  streamable: () => new StreamableHTTPClientTransport(new URL(`${mcpHttp.url}/mcp`)),
  stdio: () => new StdioClientTransport({
    command: "npx", args: ["tsx", "scripts/mitra-mcp.ts"],
    env: { ...process.env, MITRA_API_URL: apiUrl } as Record<string, string>, stderr: "pipe",
  }),
} as const;
type Wire = keyof typeof WIRES;

/** One party: an MCP session plus the only secret it holds, its own wallet key. */
interface Party { client: Client; agentId: string; key: PrivateKeyAccount }

async function party(wire: Wire, agentId: string): Promise<Party> {
  const client = new Client({ name: `${agentId}@${wire}`, version: "0" });
  await client.connect(WIRES[wire]());
  return { client, agentId, key: privateKeyToAccount(generatePrivateKey()) };
}

/** The registration a party sends; `prover` signs the proof for its wallet. */
async function registration(p: Party, capabilities: string[], prover: PrivateKeyAccount = p.key) {
  const agent = { agentId: p.agentId, name: p.agentId, owner: "Elsewhere Inc",
    wallets: [{ chain: "base" as const, address: p.key.address }], capabilities, protocols: ["mcp"] };
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const signature = await prover.signTypedData(mitraRequestTypedData(registrationRequest(agent, expiresAt), 84532));
  return { agent, expiresAt, proofs: [{ signer: p.key.address, chainId: 84532, signature }] };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
async function call(p: Party, name: string, args: Record<string, unknown>) {
  const r = (await p.client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: Boolean(r.isError), body: JSON.parse(r.content[0].text) };
}

/**
 * Sign a transition as the party and call its tool. The party signs the same
 * body the MCP server will forward: the tool's arguments plus `op`.
 */
async function signed(p: Party, tool: string, op: string, fromStatus: string, args: { agreementId: string } & Record<string, unknown>, signer: PrivateKeyAccount = p.key) {
  const { op: _op, ...withAuth } = await signAs(signer, p.agentId, fromStatus, { op, ...args });
  return call(p, tool, withAuth);
}

// ── The lifecycle ────────────────────────────────────────────────────────────

describe.each(["streamable", "stdio"] as const)("an external agent over %s", (wire) => {
  it("registers, records an intent, binds an agreement, and is paid only on the evaluator's signed acceptance", async () => {
    const stamp = `${wire}_${Date.now()}`;
    const buyer = await party(wire, `ext_client_${stamp}`);
    const provider = await party(wire, `ext_provider_${stamp}`);
    const evaluator = await party(wire, `ext_evaluator_${stamp}`);
    const providerKey = provider.key;
    try {
      // 0. What the agent is handed: every surface tool, all of them backed, and no capital verb.
      const names = (await provider.client.listTools()).tools.map((t) => t.name).sort();
      expect(names, "every surface tool is served: none unbacked, none withheld").toEqual([...mcpTools].sort());
      expect(Object.values(MCP_TOOL_STATUS).every((s) => s.status === "served")).toBe(true);
      for (const verb of prohibitedDirectTools) expect(names).not.toContain(verb);
      expect(provider.client.getInstructions()).not.toMatch(/Not available/);

      // 1. Each party registers itself; its wallet must sign the registration.
      const forged = await call(provider, "mitra_register_agent", await registration(provider, ["research"], privateKeyToAccount(generatePrivateKey())));
      expect(forged.isError, "a wallet the registrant cannot sign for is refused").toBe(true);
      for (const [p, caps] of [[buyer, ["payment"]], [provider, ["research"]], [evaluator, ["deliverable_evaluation"]]] as const) {
        const registered = await call(p, "mitra_register_agent", await registration(p, [...caps]));
        expect(registered.isError, JSON.stringify(registered.body)).toBe(false);
        expect(registered.body.data.status).toBe("REGISTERED");
      }
      const readBack = await call(buyer, "mitra_get_agent", { agentId: provider.agentId });
      expect(readBack.body.data.wallets).toEqual([expect.objectContaining({ address: providerKey.address })]);

      // The operator opens the Space the client trades in: over HTTP, not MCP.
      const spaceId = `space_e2e_${stamp}`;
      const space = await fetch(`${apiUrl}/api/v1/spaces`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId, owner: buyer.agentId, participants: [buyer.agentId, provider.agentId, evaluator.agentId],
          // Every op without its own capability is admitted as "payment" (applyAgreementOp).
          allowedCapabilities: ["research", "payment"], budget: { asset: "USDC", amount: 50 } }) });
      expect(space.status, await space.clone().text()).toBe(201);

      // 2. The client records its principal's intent. Mitra assigns the id.
      const runId = `run_e2e_${stamp}`;
      const intent = await call(buyer, "mitra_create_intent", {
        runId, principal: "Mitra Labs", initiatingAgentId: buyer.agentId, mandateId: "mandate_research_public_v7",
        objective: "Survey 20 research data vendors", budget: { asset: "USDC", amount: 5 }, constraints: ["public sources only"],
        expiresAt: "2027-01-01T00:00:00Z",
      });
      expect(intent.isError, JSON.stringify(intent.body)).toBe(false);
      const { intentId } = intent.body.data;

      // 3. The client binds an agreement to that intent, naming the external provider.
      const agreementId = `ag_e2e_${stamp}`;
      const opened = await call(buyer, "mitra_create_agreement", {
        spaceId,
        draft: { agreementId, runId, intentId, client: buyer.agentId, provider: provider.agentId, evaluator: evaluator.agentId,
          price: { asset: "USDC", amount: 5 }, deadline: "2027-01-01T00:00:00Z", acceptanceCriteria: ["20 vendors, sourced"] },
        proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } },
      });
      expect(opened.isError, JSON.stringify(opened.body)).toBe(false);
      expect(opened.body.data.agreement).toMatchObject({ status: "OPEN", intentId });

      // 4. Funding: only the client, only with its own key.
      const fundArgs = { agreementId, capability: "research", amount: { asset: "USDC", amount: 5 } };
      const providerFunds = await signed(provider, "mitra_fund_agreement", "fund", "OPEN", fundArgs);
      expect(providerFunds.body.error, "the provider may not fund").toBe("ACTOR_NOT_PERMITTED");
      const impostor = await signed(buyer, "mitra_fund_agreement", "fund", "OPEN", fundArgs, privateKeyToAccount(generatePrivateKey()));
      expect(impostor.isError, "claiming the client's id without its key is refused").toBe(true);
      expect(impostor.body.error).not.toBe("ACTOR_NOT_PERMITTED");
      const funded = await signed(buyer, "mitra_fund_agreement", "fund", "OPEN", fundArgs);
      expect(funded.isError, JSON.stringify(funded.body)).toBe(false);
      expect(funded.body.data.agreement.status).toBe("FUNDED");
      const replay = await signed(buyer, "mitra_fund_agreement", "fund", "OPEN", fundArgs);
      expect(replay.isError, "a signature over OPEN does not apply to a FUNDED agreement").toBe(true);

      // 5. Execution starts on the provider's word, not the client's.
      const clientStarts = await signed(buyer, "mitra_start_execution", "startExecution", "FUNDED", { agreementId });
      expect(clientStarts.body.error).toBe("ACTOR_NOT_PERMITTED");
      const started = await signed(provider, "mitra_start_execution", "startExecution", "FUNDED", { agreementId });
      expect(started.isError, JSON.stringify(started.body)).toBe(false);
      expect(started.body.data.agreement.status).toBe("EXECUTING");

      // 6. The provider submits. A signature over different content is not accepted for this content.
      const deliverable = { agreementId, contentHash: "sha256:vendors-v1", artifactRefs: ["ipfs://bafy-vendors"] };
      const { op: _o, auth: otherAuth } = await signAs(providerKey, provider.agentId, "EXECUTING", { op: "submitDeliverable", ...deliverable, contentHash: "sha256:other" });
      const swapped = await call(provider, "mitra_submit_deliverable", { ...deliverable, auth: otherAuth });
      expect(swapped.isError, "the signed body hash binds the submitted content").toBe(true);
      const submitted = await signed(provider, "mitra_submit_deliverable", "submitDeliverable", "EXECUTING", deliverable);
      expect(submitted.isError, JSON.stringify(submitted.body)).toBe(false);
      expect(submitted.body.data.agreement.status).toBe("SUBMITTED");

      // 7. The provider never accepts its own work; the evaluator does.
      const selfAccept = await signed(provider, "mitra_accept_deliverable", "acceptDeliverable", "SUBMITTED", { agreementId });
      expect(selfAccept.body.error).toBe("ACTOR_NOT_PERMITTED");
      const accepted = await signed(evaluator, "mitra_accept_deliverable", "acceptDeliverable", "SUBMITTED", { agreementId });
      expect(accepted.isError, JSON.stringify(accepted.body)).toBe(false);
      expect(accepted.body.data.agreement.status).toBe("ACCEPTED");

      // 8. The record, read back through the same surface.
      const gotIntent = await call(provider, "mitra_get_intent", { intentId });
      expect(gotIntent.body.data).toMatchObject({ intentId, runId, objective: "Survey 20 research data vendors" });
      const timeline = await call(provider, "mitra_get_timeline", { runId });
      expect(timeline.isError, JSON.stringify(timeline.body)).toBe(false);
      const titles: string[] = timeline.body.data.map((e: { title: string }) => e.title);
      const order = ["OPEN → FUNDED", "FUNDED → EXECUTING", "EXECUTING → SUBMITTED", "SUBMITTED → ACCEPTED"]
        .map((t) => titles.findIndex((x) => x.includes(t)));
      expect(order.every((i) => i >= 0), titles.join(" | ")).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // The six authority refusals above (wrong role, wrong key, stale or swapped
      // signature) are answered to the caller but NOT written to the run's timeline:
      // the route logs only refusals that reach the kernel. Pinned so a change is
      // deliberate either way: logging an unauthenticated attempt lets anyone write
      // to any run's log (open question, shared context).
      expect(titles.filter((t) => /refused/.test(t))).toEqual([]);

      // Everything above reached the API over HTTP; nothing went around it.
      if (EXTERNAL_API) {
        console.log(`external agent e2e over ${wire} against ${EXTERNAL_API}: ${agreementId} ACCEPTED, intent ${intentId}, backend ${accepted.body.backend}`);
        return;
      }
      expect(apiLog.filter((l) => l.path === "/api/v1/agreements" && l.method === "POST").length).toBe(11);
      expect(apiLog.some((l) => l.path === `/api/v1/intents/${intentId}`)).toBe(true);
    } finally {
      await Promise.all([buyer, provider, evaluator].map((p) => p.client.close()));
    }
  }, 120_000);
});
