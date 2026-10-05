import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { validateGovernance } from "@/lib/kernel/space-governance";
export const dynamic = "force-dynamic";

/**
 * A single Space, with its live commercial state (PRD §13.1, PK1).
 *
 * Reports committed vs budget rather than budget alone. A Space's budget is a
 * static declaration; what a caller actually needs is how much headroom is left,
 * because that is the number that decides whether another agreement can be
 * opened at all.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { repo, backend } = await getStore();

  // Optional on the interface: a backend that has not implemented it must say
  // so explicitly rather than 404 and be mistaken for "no such Space".
  if (!repo.getSpace) {
    return NextResponse.json({ error: "BACKEND_MISSING_GET_SPACE" }, { status: 501 });
  }
  const space = await repo.getSpace(id);
  if (!space) return NextResponse.json({ error: "SPACE_NOT_FOUND" }, { status: 404 });

  const governance = validateGovernance(space.governance);
  const agreements = await repo.listAgreements(id);
  const headroom = space.budget.amount - space.committed.amount;

  return NextResponse.json({
    data: {
      ...space,
      governanceValid: governance.ok,
      ...(governance.ok ? {} : { governanceReason: governance.reason }),
      agreements,
      committed: space.committed,
      availableHeadroom: { asset: space.budget.asset, amount: headroom },
      /** Same asset, so this cannot be a silent cross-asset subtraction. */
      budgetAssetMatchesCommitted: space.budget.asset === space.committed.asset,
    },
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
