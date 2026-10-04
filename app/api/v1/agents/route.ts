import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";

/**
 * Agents (backlog #5), read-only: one by `?agentId=`, or the list filtered by
 * `?capability=` and/or `?chain=` (an agent with a wallet on that chain).
 *
 * There is no registration here on purpose: the API cannot yet tell who is calling
 * (F55), so a registration route would let anyone create an agent under any name or
 * wallet. Identity claims from outside registries are never accepted as proof either
 * (ERC-8004 is projected outward only).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const capability = url.searchParams.get("capability");
  const chain = url.searchParams.get("chain");
  const { repo, backend } = await getStore();
  if (agentId) {
    const agent = await repo.getAgent(agentId);
    if (!agent) return NextResponse.json({ error: "AGENT_NOT_FOUND", agentId, backend }, { status: 404 });
    return NextResponse.json({ data: agent, backend });
  }
  const data = (await repo.listAgents())
    .filter((a) => !capability || a.capabilities.includes(capability))
    .filter((a) => !chain || a.wallets.some((w) => w.chain === chain));
  return NextResponse.json({ data, count: data.length, backend });
}
