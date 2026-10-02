import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { netObligations } from "@/lib/kernel/clearing";

/**
 * Netting preview.
 *
 * Reads obligations through the store (F36) and states plainly what this is: a
 * deterministic local calculation over whatever the store holds, not a
 * decentralised clearing process and not an epoch.
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const obligations = await repo.listObligations();
  return NextResponse.json({
    data: netObligations(obligations),
    backend,
    evidenceLevel: "LOCAL_PASS",
    warning: "Local deterministic calculator; not decentralized clearing and not an epoch.",
  });
}
