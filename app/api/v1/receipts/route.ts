import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { verifyReceiptChain } from "@/lib/kernel/receipts";

/**
 * Receipts (PRD §17), read-only. By `receiptId`, or a run's whole chain by `runId`
 * with the chain's own verdict, so a reader checks every link rather than trusting
 * one receipt.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const receiptId = url.searchParams.get("receiptId");
  const runId = url.searchParams.get("runId");
  const { repo, backend } = await getStore();

  if (receiptId) {
    const receipt = await repo.getReceipt(receiptId);
    if (!receipt) return NextResponse.json({ error: "RECEIPT_NOT_FOUND", receiptId, backend }, { status: 404 });
    return NextResponse.json({ data: receipt, backend });
  }
  if (runId) {
    const receipts = await repo.listReceipts(runId);
    return NextResponse.json({ data: receipts, count: receipts.length, chain: verifyReceiptChain(receipts), backend });
  }
  return NextResponse.json({ error: "RECEIPT_ID_OR_RUN_ID_REQUIRED" }, { status: 400 });
}
