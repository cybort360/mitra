/**
 * A `fetch` that serves the sandbox's API from the real route modules, in-process.
 *
 * The same route code `next start` runs: requests are parsed, signature-checked and
 * applied by the handlers under app/api/v1. Static imports rather than a glob, so the
 * CLI runs under plain `tsx`. Only the routes a commerce loop touches are listed; any
 * other path answers 404 `NO_ROUTE` rather than pretending.
 */
import * as agents from "@/app/api/v1/agents/route";
import * as agreements from "@/app/api/v1/agreements/route";
import * as authorizations from "@/app/api/v1/authorizations/route";
import * as clearing from "@/app/api/v1/clearing/route";
import * as events from "@/app/api/v1/events/route";
import * as inbox from "@/app/api/v1/inbox/route";
import * as inboxByAgent from "@/app/api/v1/inbox/[agentId]/route";
import * as intents from "@/app/api/v1/intents/route";
import * as intentById from "@/app/api/v1/intents/[id]/route";
import * as receipts from "@/app/api/v1/receipts/route";
import * as sagas from "@/app/api/v1/sagas/route";
import * as settlements from "@/app/api/v1/settlements/route";
import * as spaces from "@/app/api/v1/spaces/route";
import * as spaceById from "@/app/api/v1/spaces/[id]/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT", Handler>>;

const ROUTES: Array<[string, RouteModule]> = [
  ["agents", agents], ["agreements", agreements], ["authorizations", authorizations],
  ["clearing", clearing], ["events", events], ["inbox", inbox], ["inbox/[agentId]", inboxByAgent],
  ["intents", intents], ["intents/[id]", intentById], ["receipts", receipts], ["sagas", sagas],
  ["settlements", settlements], ["spaces", spaces], ["spaces/[id]", spaceById],
] as unknown as Array<[string, RouteModule]>;

export const SANDBOX_BASE_URL = "http://mitra.sandbox";

export const sandboxFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") return Response.json({ error: "NO_ROUTE" }, { status: 404 });
  const rest = parts.slice(2);
  for (const [pattern, mod] of ROUTES) {
    const segs = pattern.split("/");
    if (segs.length !== rest.length) continue;
    const params: Record<string, string> = {};
    const hit = segs.every((s, i) => {
      if (s.startsWith("[")) { params[s.slice(1, -1)] = decodeURIComponent(rest[i]); return true; }
      return s === rest[i];
    });
    if (!hit) continue;
    const handler = mod[request.method as "GET" | "POST" | "PUT"];
    if (!handler) return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    return handler(request, { params: Promise.resolve(params) });
  }
  return Response.json({ error: "NO_ROUTE" }, { status: 404 });
};
