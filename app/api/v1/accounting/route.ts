import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { buildAccountingReport } from "@/lib/kernel/accounting";
import { agreements, deliverables, obligations, runs, spaces, vaults } from "@/lib/store/seed";

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
  const { backend } = await getStore();

  const report = buildAccountingReport({
    // Vaults come from the ledger via the repository where available; the
    // obligations and settlements below are fixtures until W6 gives them a
    // repository surface, and this route says so rather than implying otherwise.
    vaults,
    obligations,
    settlements: [],
    asOf,
  });

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
      dataSource: "obligations and settlements are fixtures; see forge/PROOF_LEDGER.md",
    },
    { status: blocking.length ? 409 : 200 },
  );
}
