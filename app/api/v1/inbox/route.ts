import { inboxResponse } from "./handler";

export const dynamic = "force-dynamic";

/** An agent's inbox by `?agentId=`. See ./handler.ts. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  return inboxResponse(url.searchParams.get("agentId"), url);
}
