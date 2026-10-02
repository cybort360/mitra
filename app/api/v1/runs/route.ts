import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";

const schema = z.object({
  agentId: z.string().min(1),
  mandateId: z.string().min(1),
  objective: z.string().min(3),
  budget: z.object({ asset: z.literal("USDC"), amount: z.number().positive() }),
});

/** Runs, read through the store rather than from `seed.ts` (F36). */
export async function GET() {
  const { repo, backend } = await getStore();
  const runs = await repo.listRuns();
  return NextResponse.json({ data: runs, count: runs.length, backend, evidenceLevel: "LOCAL_PASS" });
}

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const suffix = Date.now().toString(36);
  return NextResponse.json(
    {
      id: `intent_${suffix}`,
      runId: `run_${suffix}`,
      state: "PROPOSED",
      receipt: `receipt_${suffix}`,
      note: "Local API contract only. No capital is moved until authorization + reservation + execution guard.",
    },
    { status: 201 },
  );
}
