import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import type { Intent } from "@/lib/domain/types";
export const dynamic = "force-dynamic";

/**
 * Intent persistence (LP-1, Phase 5 prereq).
 *
 * An Intent is what a principal asked an agent to do — the starting point of
 * every commercial lifecycle. Persisted durably so Purple's MCP tools can read
 * and write without in-memory stubs, and so an intent survives the process
 * that created it. Without this, every mandate/intent boundary is process-local
 * and unrecoverable after a restart.
 */
const createBody = z.object({
  intentId: z.string().min(1).optional(),
  runId: z.string().min(1),
  principal: z.string().min(1),
  initiatingAgentId: z.string().min(1),
  mandateId: z.string().min(1),
  objective: z.string().min(1),
  budget: z.object({ asset: z.string().min(1), amount: z.number().nonnegative() }),
  constraints: z.array(z.string()),
  expiresAt: z.string().min(1),
});

export async function GET(req: Request) {
  const { repo, backend } = await getStore();
  if (!repo.listIntents) return NextResponse.json({ error: "BACKEND_MISSING_INTENTS" }, { status: 501 });
  const url = new URL(req.url);
  const intents = await repo.listIntents({
    ...(url.searchParams.get("principal") ? { principal: url.searchParams.get("principal")! } : {}),
    ...(url.searchParams.get("agentId") ? { agentId: url.searchParams.get("agentId")! } : {}),
  });
  return NextResponse.json({ data: intents, backend, evidenceLevel: "LOCAL_PASS" });
}

export async function POST(req: Request) {
  const { repo, backend } = await getStore();
  if (!repo.createIntent) return NextResponse.json({ error: "BACKEND_MISSING_INTENTS" }, { status: 501 });
  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_INTENT", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;
  // A zero-budget intent authorises nothing; a past expiry is dead on arrival.
  // Both are refused at the boundary rather than persisted and discovered later.
  if (b.budget.amount <= 0) {
    return NextResponse.json({ error: "INVALID_INTENT", reason: "BUDGET_MUST_BE_POSITIVE" }, { status: 400 });
  }
  if (Date.parse(b.expiresAt) <= Date.now()) {
    return NextResponse.json({ error: "INVALID_INTENT", reason: "EXPIRES_AT_IN_PAST" }, { status: 400 });
  }
  if (b.intentId && repo.getIntent) {
    const existing = await repo.getIntent(b.intentId);
    if (existing) {
      const isIdentical =
        existing.runId === b.runId &&
        existing.principal === b.principal &&
        existing.initiatingAgentId === b.initiatingAgentId &&
        existing.mandateId === b.mandateId &&
        existing.objective === b.objective &&
        existing.budget.asset === b.budget.asset &&
        existing.budget.amount === b.budget.amount &&
        JSON.stringify(existing.constraints) === JSON.stringify(b.constraints) &&
        existing.expiresAt === b.expiresAt;
      if (isIdentical) {
        return NextResponse.json({ data: existing, backend, evidenceLevel: "LOCAL_PASS" }, { status: 200 });
      }
      return NextResponse.json(
        { error: "INTENT_EXISTS", reason: "An intent with this id already exists with different parameters" },
        { status: 409 },
      );
    }
  }
  const intent: Intent = {
    intentId: b.intentId ?? `intent_${Math.random().toString(36).slice(2, 10)}`,
    runId: b.runId,
    principal: b.principal,
    initiatingAgentId: b.initiatingAgentId,
    mandateId: b.mandateId,
    objective: b.objective,
    budget: { asset: b.budget.asset as Intent["budget"]["asset"], amount: b.budget.amount },
    constraints: b.constraints,
    createdAt: new Date().toISOString(),
    expiresAt: b.expiresAt,
    version: 1,
  };
  const stored = await repo.createIntent(intent);
  return NextResponse.json({ data: stored, backend, evidenceLevel: "LOCAL_PASS" }, { status: 201 });
}
