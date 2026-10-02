import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { buildAccountingReport } from "@/lib/kernel/accounting";

/**
 * The operator's view (PRD Phase 10): "a pilot organization can operate the
 * system without reading protocol logs."
 *
 * Returns one number per question an operator is actually asked, plus the
 * **findings** — which is the part that matters. An accounting view that only
 * ever agrees with itself is decoration: it would look identical whether or not
 * anything were wrong.
 *
 * `blockers` is HTTP 409 rather than 200 when a BLOCKING finding exists, so a
 * monitoring system notices without anyone reading the body. Returning a broken
 * book with a cheerful 200 is how a reconciliation failure becomes a quarter-end
 * surprise.
 */
export async function GET(req: Request) {
  const asOf = new URL(req.url).searchParams.get("asOf") ?? new Date().toISOString();
  // Everything comes through the store. This route previously imported six arrays
  // from `seed.ts`, so under the in-memory backend it reported a fixed world and
  // under Postgres it reported an empty one — a reconciliation view that looks
  // authoritative either way. (F36)
  const { repo, backend } = await getStore();
  const [vaults, obligations, settlements, runs, agreements, deliverables, spaces] = await Promise.all([
    repo.listVaults(),
    repo.listObligations(),
    repo.listSettlements(),
    repo.listRuns(),
    repo.listAgreements(),
    repo.listDeliverables(),
    repo.listSpaces(),
  ]);

  const report = buildAccountingReport({ vaults, obligations, settlements, asOf });

  const blocking = report.findings.filter((f) => f.severity === "BLOCKING");
  return NextResponse.json(
    {
      data: report,
      summary: {
        capitalTotal: report.capital,
        owed: report.grossObligations,
        settled: report.settled,
        residual: report.reconciliationDelta,
        blocking: blocking.length,
      },
      context: {
        spaces: spaces.length,
        agreements: agreements.length,
        deliverables: deliverables.length,
        runs: runs.length,
      },
      backend,
      evidenceLevel: "LOCAL_PASS",
    },
    { status: blocking.length ? 409 : 200 },
  );
}
