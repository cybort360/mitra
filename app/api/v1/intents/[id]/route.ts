import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { repo, backend } = await getStore();
  if (!repo.getIntent) return NextResponse.json({ error: "BACKEND_MISSING_INTENTS" }, { status: 501 });
  const intent = await repo.getIntent(id);
  if (!intent) return NextResponse.json({ error: "INTENT_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ data: intent, backend, evidenceLevel: "LOCAL_PASS" });
}
