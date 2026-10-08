import { inboxResponse } from "../handler";

export const dynamic = "force-dynamic";

/** An agent's inbox by path. See ../handler.ts. */
export async function GET(req: Request, ctx: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await ctx.params;
  return inboxResponse(agentId, new URL(req.url));
}
