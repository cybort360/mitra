/**
 * The live MCP server (PRD Phase 5; sprint item 4) — the participation surface in
 * `surface.ts`, served over the Model Context Protocol.
 *
 * ## A thin client, on purpose
 *
 * Every served tool is one call to the Mitra HTTP API. The MCP process holds no
 * store, no keys and no kernel: authority stays in the routes and the kernel, so
 * MCP "remains the control surface and cannot bypass authority" (FR-INT-002) by
 * construction rather than by review. `MitraApi` is the only thing a tool can do.
 *
 * ## Not every surface tool is served — and each one says why
 *
 * `MCP_TOOL_STATUS` gives every name in `mcpTools` exactly one status, and the
 * `Record<McpToolName, …>` type makes a missing name a compile error:
 *
 * - **served** — backed by a real route and safe to hand to an external agent today.
 * - **withheld** — backed, but NOT safe yet. None today. Fund, accept, reject and
 *   register were withheld until F55 gave the API caller identity; they are served
 *   now because each carries the agent's own EIP-712 signature, which the API checks
 *   against the agent's registered wallets and its role (decision ctx_d236086bde9601ee).
 * - **unbacked** — no subsystem exists to serve it. None today: the intent tools
 *   were unbacked until LP-1 gave intents a store and routes. Serving a stub would
 *   be a fake success path.
 *
 * `assertServedMatchesStatus` runs at module load: a served status without a
 * definition, or a definition for a tool not marked served, throws on import.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNoCapitalVerb, mcpTools, type McpToolName } from "./surface";

export interface ApiRequest {
  method: "GET" | "POST";
  /** Path under the API root, starting `/api/v1/`. */
  path: string;
  body?: unknown;
}
export interface ApiResponse { status: number; body: unknown }
/** The only capability a served tool has. */
export type MitraApi = (req: ApiRequest) => Promise<ApiResponse>;

export type ToolStatus =
  | { status: "served" }
  | { status: "withheld"; reason: string }
  | { status: "unbacked"; reason: string };

export const MCP_TOOL_STATUS: Record<McpToolName, ToolStatus> = {
  mitra_get_obligations: { status: "served" },
  mitra_get_recovery: { status: "served" },
  mitra_get_settlement: { status: "served" },
  mitra_get_receipt: { status: "served" },
  mitra_get_exposure: { status: "served" },
  mitra_request_authorization: { status: "served" },
  mitra_create_agreement: { status: "served" },
  mitra_submit_deliverable: { status: "served" },
  mitra_request_clearing: { status: "served" },
  // F55: these carry the agent's own EIP-712 signature, which the API verifies
  // against the role and the agent's registered wallets. The server holds no keys.
  mitra_fund_agreement: { status: "served" },
  mitra_start_execution: { status: "served" },
  mitra_accept_deliverable: { status: "served" },
  mitra_reject_deliverable: { status: "served" },
  mitra_register_agent: { status: "served" },
  mitra_get_agent: { status: "served" },
  mitra_find_agents: { status: "served" },
  mitra_create_intent: { status: "served" },
  mitra_get_intent: { status: "served" },
  mitra_get_timeline: { status: "served" },
  mitra_get_inbox: { status: "served" },
  mitra_get_mandate: { status: "served" },
  mitra_list_mandates: { status: "served" },
};

interface ServedTool {
  description: string;
  inputSchema: z.ZodRawShape;
  toRequest(args: Record<string, unknown>): ApiRequest;
}

const qs = (params: Record<string, unknown>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : "";
};

const Money = z.object({ asset: z.string().min(1), amount: z.number().positive() });

/**
 * The agent's signature over the exact request (F55), passed through unchanged.
 * Build it with lib/identity/signed-request: sign `mitraRequestTypedData` for
 * { op, agreementId, fromStatus, actor, bodyHash: requestBodyHash(body), expiresAt }.
 */
const Auth = z.object({
  actor: z.string().min(1).describe("The agent id acting; it must hold a role this op allows."),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("A wallet registered to the actor on this chain."),
  chainId: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]*$/),
  expiresAt: z.number().int().positive().describe("Unix seconds."),
});

/** A signed agreement transition: the body the agent signed, plus its signature. */
const transition = (op: string) => (a: Record<string, unknown>): ApiRequest =>
  ({ method: "POST", path: "/api/v1/agreements", body: { ...a, op } });

export const SERVED_TOOLS: Partial<Record<McpToolName, ServedTool>> = {
  mitra_get_obligations: {
    description: "List obligations (who owes whom, how much, and their status).",
    inputSchema: {},
    toRequest: () => ({ method: "GET", path: "/api/v1/obligations" }),
  },
  mitra_get_recovery: {
    description: "Recovery sagas: what failed, what was compensated, and the terminal recovery state. Optionally for one run.",
    inputSchema: { runId: z.string().min(1).optional() },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/sagas${qs({ runId: a.runId })}` }),
  },
  mitra_get_settlement: {
    description:
      "Settlements, optionally for one agreement. With settlementId, returns the settlement's evidence bundle " +
      "re-observed from the chain, the verifier's verdict, and its receipt chain — enough to check it yourself.",
    inputSchema: { agreementId: z.string().min(1).optional(), settlementId: z.string().min(1).optional() },
    toRequest: (a) => a.settlementId
      ? { method: "GET", path: `/api/v1/settlements/evidence${qs({ settlementId: a.settlementId })}` }
      : { method: "GET", path: `/api/v1/settlements${qs({ agreementId: a.agreementId })}` },
  },
  mitra_get_receipt: {
    description: "A receipt by receiptId, or a run's whole hash-chained receipt list (with the chain's verdict) by runId.",
    inputSchema: { receiptId: z.string().min(1).optional(), runId: z.string().min(1).optional() },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/receipts${qs({ receiptId: a.receiptId, runId: a.runId })}` }),
  },
  mitra_get_agent: {
    description: "One agent: its owner, status, capabilities, wallets and the mandates it holds.",
    inputSchema: { agentId: z.string().min(1) },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/agents${qs({ agentId: a.agentId })}` }),
  },
  mitra_find_agents: {
    description: "Find agents by capability and/or the chain they hold a wallet on. Reputation is not a filter: it is a claim, not a credential.",
    inputSchema: { capability: z.string().min(1).optional(), chain: z.enum(["solana", "base", "tempo"]).optional() },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/agents${qs({ capability: a.capability, chain: a.chain })}` }),
  },
  mitra_get_timeline: {
    description: "A run's timeline from Mitra's append-only event log: what happened, in order, including refusals.",
    inputSchema: { runId: z.string().min(1) },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/events${qs({ runId: a.runId })}` }),
  },
  mitra_get_mandate: {
    description:
      "One Mandate by id: who may spend it, out of which vault, up to how much per transaction " +
      "and in total, over which chains, until when. This is the ceiling every authorization " +
      "for that agent is evaluated against, so an agent should read it before asking for " +
      "anything.",
    inputSchema: { mandateId: z.string().min(1) },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/mandates${qs({ mandateId: a.mandateId })}` }),
  },
  mitra_list_mandates: {
    description:
      "The Mandates an agent holds, or all of them when none is named. Read-only: this tool " +
      "cannot create a Mandate, because granting authority is not something an agent should " +
      "be able to do to itself.",
    inputSchema: { agentId: z.string().min(1).optional(), principal: z.string().min(1).optional(), vaultId: z.string().min(1).optional() },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/mandates${qs({ agentId: a.agentId, principal: a.principal, vaultId: a.vaultId })}` }),
  },
  mitra_get_inbox: {
    description:
      "An agent's inbox: agreements where it must start or submit work (WORK_REQUIRED), a deliverable it may accept " +
      "or reject (EVALUATION_REQUIRED), OPEN agreements naming it as provider (INBOUND_PROPOSAL), and confirmed " +
      "settlements paying it (SETTLEMENT_RECEIPT). Each item lists the ops this agent may sign next. Most urgent first.",
    inputSchema: {
      agentId: z.string().min(1),
      kinds: z.array(z.enum(["WORK_REQUIRED", "EVALUATION_REQUIRED", "INBOUND_PROPOSAL", "SETTLEMENT_RECEIPT"])).optional(),
    },
    toRequest: (a) => ({
      method: "GET",
      path: `/api/v1/inbox/${encodeURIComponent(String(a.agentId))}${qs({ kind: (a.kinds as string[] | undefined)?.join(",") })}`,
    }),
  },
  mitra_get_exposure: {
    description: "Capital, obligations and settlements reconciled into one accounting report, as of a time.",
    inputSchema: { asOf: z.string().datetime().optional() },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/accounting${qs({ asOf: a.asOf })}` }),
  },
  mitra_create_intent: {
    description:
      "Record a principal's commercial intent: the objective, budget and constraints an agent acts under. " +
      "An intent is a statement, not an authorization: it reserves and pays nothing. Mitra assigns the intentId; " +
      "use it in mitra_create_agreement.",
    // No intentId: the route assigns one. The route upserts on a caller-chosen id,
    // so letting an external agent pick it would let it overwrite another
    // principal's intent (F65).
    inputSchema: {
      runId: z.string().min(1), principal: z.string().min(1), initiatingAgentId: z.string().min(1),
      mandateId: z.string().min(1), objective: z.string().min(1), budget: Money,
      constraints: z.array(z.string()), expiresAt: z.string().datetime(),
    },
    toRequest: (a) => {
      const { intentId: _dropped, ...body } = a;
      return { method: "POST", path: "/api/v1/intents", body };
    },
  },
  mitra_get_intent: {
    description: "One intent by intentId: what was asked, under which mandate, with what budget and expiry.",
    inputSchema: { intentId: z.string().min(1) },
    toRequest: (a) => ({ method: "GET", path: `/api/v1/intents/${encodeURIComponent(String(a.intentId))}` }),
  },
  mitra_request_authorization: {
    description:
      "Ask whether a proposed spend is within a mandate. Returns ALLOW, DENY or REVIEW with reason codes. " +
      "An ALLOW is NOT permission to move value: nothing is reserved or paid by this tool.",
    inputSchema: {
      mandateId: z.string().min(1), vaultId: z.string().min(1), amount: z.number().positive(),
      asset: z.string().min(1), chain: z.string().min(1), counterparty: z.string().min(1),
      capability: z.string().min(1), intentId: z.string().min(1).optional(), runId: z.string().min(1).optional(),
    },
    toRequest: (a) => ({ method: "POST", path: "/api/v1/authorizations", body: a }),
  },
  mitra_create_agreement: {
    description:
      "Open a commercial agreement inside a Space. The Space admits the client, the capability and the price " +
      "before anything exists; payTo (the provider's payout address) is a term fixed here.",
    inputSchema: {
      spaceId: z.string().min(1),
      draft: z.object({
        agreementId: z.string().min(1), runId: z.string().min(1), intentId: z.string().min(1),
        client: z.string().min(1), provider: z.string().min(1), evaluator: z.string().min(1),
        price: Money, deadline: z.string().min(1), acceptanceCriteria: z.array(z.string()).optional(),
        failurePolicy: z.string().optional(),
        payTo: z.object({ chain: z.enum(["solana", "base", "tempo"]), address: z.string().min(1) }).optional(),
        // The marketplace's own identifiers (PRD §8.4: never discard the external
        // job identity), e.g. the refs lib/adapters/virtuals.ts gigToAgreementDraft emits.
        externalJobRefs: z.array(z.string().min(1)).optional(),
      }),
      proposal: z.object({ capability: z.string().min(1), amount: Money }),
    },
    toRequest: (a) => ({ method: "POST", path: "/api/v1/agreements", body: { op: "open", ...a } }),
  },
  mitra_submit_deliverable: {
    description: "Submit a deliverable for an executing agreement: a content hash and the artifact references it covers.",
    inputSchema: {
      agreementId: z.string().min(1),
      contentHash: z.string().min(1),
      artifactRefs: z.array(z.string().min(1)).min(1),
      auth: Auth,
    },
    toRequest: transition("submitDeliverable"),
  },
  mitra_fund_agreement: {
    description: "Fund an OPEN agreement, encumbering its price. Signed by the client.",
    inputSchema: { agreementId: z.string().min(1), capability: z.string().optional(), amount: Money.optional(), auth: Auth },
    toRequest: transition("fund"),
  },
  mitra_start_execution: {
    description: "Start work on a FUNDED agreement, moving it to EXECUTING so a deliverable can be submitted. Signed by the provider.",
    inputSchema: { agreementId: z.string().min(1), auth: Auth },
    toRequest: transition("startExecution"),
  },
  mitra_accept_deliverable: {
    description: "Accept a SUBMITTED deliverable, making the agreement due for settlement. Signed by the client or evaluator; never the provider.",
    inputSchema: { agreementId: z.string().min(1), auth: Auth },
    toRequest: transition("acceptDeliverable"),
  },
  mitra_reject_deliverable: {
    description: "Reject a SUBMITTED deliverable, triggering recovery. Signed by the client or evaluator.",
    inputSchema: { agreementId: z.string().min(1), failureReason: z.string().optional(), auth: Auth },
    toRequest: transition("rejectDeliverable"),
  },
  mitra_register_agent: {
    description:
      "Register an agent. Every EVM wallet listed must sign the registration (proofs); an existing agentId is refused. " +
      "Solana wallets cannot be proven yet.",
    inputSchema: {
      agent: z.object({
        agentId: z.string().min(1), name: z.string().min(1), owner: z.string().min(1),
        wallets: z.array(z.object({ chain: z.enum(["solana", "base", "tempo"]), address: z.string().min(1) })).min(1),
        capabilities: z.array(z.string()).optional(), protocols: z.array(z.string()).optional(),
      }),
      expiresAt: z.number().int().positive(),
      proofs: z.array(z.object({ signer: z.string(), chainId: z.number().int().positive(), signature: z.string() })),
    },
    toRequest: (a) => ({ method: "POST", path: "/api/v1/agents", body: a }),
  },
  mitra_request_clearing: {
    description:
      "Netting PREVIEW: computes net positions for the given obligations (or the stored ones). " +
      "Opening, challenging or finalizing a clearing epoch is not available through MCP.",
    inputSchema: {
      obligations: z.array(z.object({
        obligationId: z.string().min(1), debtor: z.string().min(1), creditor: z.string().min(1),
        amount: Money, status: z.string().min(1),
      })).optional(),
    },
    // The action is fixed here, not taken from the caller: the route also accepts
    // open_epoch / finalize_epoch, and those must not reach an external agent.
    toRequest: (a) => ({ method: "POST", path: "/api/v1/clearing", body: { action: "net", ...(a.obligations ? { obligations: a.obligations } : {}) } }),
  },
};

/** Thrown on import if the status table and the served definitions disagree. */
export function assertServedMatchesStatus(): void {
  for (const name of mcpTools) {
    const served = MCP_TOOL_STATUS[name].status === "served";
    if (served !== Boolean(SERVED_TOOLS[name])) {
      throw new Error(`MCP tool ${name}: status is ${MCP_TOOL_STATUS[name].status} but a definition ${SERVED_TOOLS[name] ? "exists" : "is missing"}`);
    }
  }
  for (const name of Object.keys(SERVED_TOOLS)) {
    if (!(mcpTools as readonly string[]).includes(name)) throw new Error(`MCP tool ${name} is served but not on the surface`);
  }
}
assertServedMatchesStatus();
assertNoCapitalVerb(Object.keys(SERVED_TOOLS));

export const servedToolNames = () => mcpTools.filter((n) => MCP_TOOL_STATUS[n].status === "served");

/** Shown to connecting agents, so a missing tool is explained rather than silent. */
export function serverInstructions(): string {
  const lines = mcpTools
    .filter((n) => MCP_TOOL_STATUS[n].status !== "served")
    .map((n) => `- ${n}: ${(MCP_TOOL_STATUS[n] as { reason: string }).reason}`);
  return [
    "Mitra governs agent commerce: every tool here is a verb on intent, never on capital.",
    "No tool moves value. Authorization is not permission to pay; payment happens only through Mitra's execution guard.",
    ...(lines.length ? ["Not available on this server:", ...lines] : []),
  ].join("\n");
}

export function createMitraMcpServer(api: MitraApi): McpServer {
  const server = new McpServer({ name: "mitra", version: "0.1.0" }, { instructions: serverInstructions() });
  for (const name of servedToolNames()) {
    const tool = SERVED_TOOLS[name]!;
    server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, async (args: Record<string, unknown>) => {
      const res = await api(tool.toRequest(args ?? {}));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res.body) }],
        // A refusal from the API is reported as a tool error carrying the API's own
        // reason code, never smoothed into a success.
        isError: res.status >= 400,
      };
    });
  }
  return server;
}

/** The production `MitraApi`: HTTP to a running Mitra API. */
export function httpApi(baseUrl: string, fetchImpl: typeof fetch = fetch): MitraApi {
  const root = baseUrl.replace(/\/+$/, "");
  return async ({ method, path, body }) => {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body is passed through as text */ }
    return { status: res.status, body: parsed };
  };
}
