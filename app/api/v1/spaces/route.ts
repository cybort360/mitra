import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";

/**
 * List Spaces (PRD §13.1) — the bounded commercial contexts.
 *
 * New surface: the Space type did not exist until Phase 4, and it is the
 * containment boundary every agreement is scoped to. It is read-only here — the
 * write path is the pure kernel in `lib/kernel/commerce.ts`, so a transition is
 * computed and validated before anything is persisted.
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const spaces = await repo.listSpaces();
  return NextResponse.json({
    data: spaces.map((s) => ({
      ...s,
      // Derived, not stored: what the Space can still admit right now.
      headroom: {
        asset: s.budget.asset,
        amount: s.budget.amount - s.committed.amount,
      },
      participants: s.participants.length,
    })),
    count: spaces.length,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
