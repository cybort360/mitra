import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { buildInbox, INBOX_KINDS, isInboxKind } from "@/lib/inbox";

/**
 * One agent's inbox (PP-6), shared by `GET /api/v1/inbox?agentId=` and
 * `GET /api/v1/inbox/{agentId}`. `?kind=` takes a comma-separated subset.
 *
 * A read, like the agreement and settlement reads it is derived from: it moves
 * nothing and needs no signature. It lists only what those routes already serve.
 */
export async function inboxResponse(agentId: string | null, url: URL): Promise<Response> {
  if (!agentId) return NextResponse.json({ error: "AGENT_ID_REQUIRED" }, { status: 400 });
  const kinds = (url.searchParams.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const unknown = kinds.filter((k) => !isInboxKind(k));
  if (unknown.length) {
    return NextResponse.json({ error: "UNKNOWN_INBOX_KIND", unknown, allowed: INBOX_KINDS }, { status: 400 });
  }

  const { repo, backend } = await getStore();
  const agent = await repo.getAgent(agentId);
  if (!agent) return NextResponse.json({ error: "AGENT_NOT_FOUND", agentId, backend }, { status: 404 });

  const now = new Date();
  const inbox = buildInbox({
    agent,
    agreements: await repo.listAgreements(),
    settlements: await repo.listSettlements(),
    now,
    kinds: kinds.filter(isInboxKind),
  });
  return NextResponse.json({ data: { ...inbox, generatedAt: now.toISOString() }, backend, evidenceLevel: "LOCAL_PASS" });
}
