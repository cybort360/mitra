import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";

/**
 * The event log (sprint item 5): one run's timeline (`?runId=`), or every event
 * after a log position (`?after=`), each with its `seq`. Read-only.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const { repo, backend } = await getStore();
  if (runId) {
    const data = await repo.listEvents(runId);
    return NextResponse.json({ data, count: data.length, runId, backend });
  }
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const data = await repo.listEventsSince(after);
  return NextResponse.json({ data, count: data.length, after, backend });
}
