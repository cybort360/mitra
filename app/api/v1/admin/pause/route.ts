import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOperator, operatorRefusal } from "@/lib/admin/operator-auth";
import { PAUSE_SCOPES, getPauseState, setPauseState } from "@/lib/admin/incident";
import { getStore } from "@/lib/store/provider";
import { recordEvent } from "@/lib/store/events";
export const dynamic = "force-dynamic";

/**
 * Incident controls (PP-4): pause or resume value movement. Operator-only.
 * The scopes and what each stops are in lib/admin/incident.ts. Every change is
 * written to the event log, so the SSE stream and webhook subscribers see it.
 */
const body = z.object({
  paused: z.boolean(),
  /** Defaults to every scope when pausing. Ignored when resuming. */
  scopes: z.array(z.enum(PAUSE_SCOPES)).min(1).optional(),
  reason: z.string().min(3).max(500),
});

export async function GET(req: Request) {
  const auth = checkOperator(req);
  if (!auth.ok) return operatorRefusal(auth);
  return NextResponse.json({ data: await getPauseState() });
}

export async function POST(req: Request) {
  const auth = checkOperator(req);
  if (!auth.ok) return operatorRefusal(auth);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_PAUSE", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  const state = await setPauseState({ paused: b.paused, scopes: b.scopes ?? [...PAUSE_SCOPES], reason: b.reason });

  const { repo } = await getStore();
  await recordEvent(repo, {
    runId: "system", kind: "SYSTEM", objectRef: "incident_controls",
    title: state.paused ? `Value movement paused (${state.scopes.join(", ")})` : "Value movement resumed",
    description: b.reason, status: state.paused ? "WARNING" : "INFO",
    metadata: { paused: state.paused, scopes: state.scopes.join(","), version: state.version },
  });
  return NextResponse.json({ data: state });
}
