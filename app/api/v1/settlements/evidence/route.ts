import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { getRails } from "@/lib/settlement/rails";
import { bundleToJson, verifyEvidenceBundle } from "@/lib/evm/evidence";
import { verifyReceiptChain } from "@/lib/kernel/receipts";

/**
 * Settlement evidence (PRD §21.4, sprint item 2).
 *
 * The bundle is built by the rail's adapter from what the chain reports at
 * request time — never from the settlement record's own `CONFIRMED` — and then
 * checked with the same `verifyEvidenceBundle` a third party would run. The run's
 * receipt chain is returned with its own verdict, so a counterparty can check the
 * receipt the bundle names and every link before it.
 *
 * - 200: observed and consistent; `verdict` is the verifier's answer.
 * - 404 `EVIDENCE_NOT_OBSERVED`: the chain shows nothing yet. Not a verdict.
 * - 409 `EVIDENCE_CONTRADICTED:<field>` / `EVIDENCE_RECORD_INCONSISTENT`: the chain
 *   or the record disagrees with itself. Reported, never smoothed into a 404.
 *
 * `typed.amountAtomic` is a decimal string in this JSON; `bundleFromJson` restores
 * the bigint before verification.
 */
export async function GET(req: Request) {
  const settlementId = new URL(req.url).searchParams.get("settlementId");
  if (!settlementId) return NextResponse.json({ error: "SETTLEMENT_ID_REQUIRED" }, { status: 400 });
  const { repo, backend } = await getStore();

  const settlement = await repo.getSettlement(settlementId);
  if (!settlement) return NextResponse.json({ error: "SETTLEMENT_NOT_FOUND", settlementId, backend }, { status: 404 });
  const rail = (await getRails())[settlement.chain];
  if (!rail) return NextResponse.json({ error: "SETTLEMENT_RAIL_NOT_CONFIGURED", backend }, { status: 503 });

  let bundle;
  try {
    bundle = await rail.adapter.getEvidence({ settlement, observedAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), settlementId, backend }, { status: 409 });
  }
  if (!bundle) return NextResponse.json({ error: "EVIDENCE_NOT_OBSERVED", settlementId, backend }, { status: 404 });

  const receipts = settlement.runId ? await repo.listReceipts(settlement.runId) : [];
  return NextResponse.json({
    data: {
      bundle: bundleToJson(bundle),
      verdict: verifyEvidenceBundle(bundle),
      receipt: receipts.find((r) => r.receiptId === bundle.receiptId) ?? null,
      receiptChain: { receipts, verdict: verifyReceiptChain(receipts) },
    },
    backend,
  });
}
