import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { availableAgreementOps } from "@/lib/kernel/commerce";

/**
 * List agreements, optionally filtered to one Space.
 *
 * `?spaceId=` is the containment query. The Space id is a **filter the server
 * applies**, not a client assertion about which Space an agreement belongs to —
 * the `space_id` foreign key holds the link, and this read respects it.
 *
 * Each row carries `availableOps`, derived from the state machine, so a client
 * can render affordances without reimplementing the transition table and
 * drifting from it. That is the same table `applyAgreementOp` enforces, so the
 * UI cannot offer an action the kernel would refuse.
 */
export async function GET(req: Request) {
  const spaceId = new URL(req.url).searchParams.get("spaceId") ?? undefined;
  const { repo, backend } = await getStore();
  const agreements = await repo.listAgreements(spaceId);
  return NextResponse.json({
    data: agreements.map((a) => ({
      ...a,
      availableOps: availableAgreementOps(a.status),
    })),
    count: agreements.length,
    spaceId: spaceId ?? null,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
