import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import { getRails } from "@/lib/settlement/rails";
import { confirmSettlement, settleAgreement } from "@/lib/settlement/settle-agreement";

/**
 * Settlements: the route through which an ACCEPTED agreement is actually paid.
 *
 * The caller names an agreement and a reservation. It cannot name an amount, an
 * asset, a chain, a payee or a digest: all of those are re-derived from the
 * agreement's terms and checked by the execution guard
 * (`lib/kernel/settlement.ts`). Acceptance makes the price owed; it is not, on its
 * own, permission to move value.
 *
 * `evidenceLevel` on each settlement is what that settlement has earned —
 * `TESTNET_PASS` only once the transfer was confirmed from the chain.
 */

export async function GET(req: Request) {
  const agreementId = new URL(req.url).searchParams.get("agreementId") ?? undefined;
  const { repo, backend } = await getStore();
  const data = (await repo.listSettlements()).filter((s) => !agreementId || s.agreementId === agreementId);
  return NextResponse.json({ data, count: data.length, backend });
}

const PostSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("settle"),
    agreementId: z.string().min(1),
    reservationId: z.string().min(1),
    now: z.string().datetime().optional(),
  }),
  z.object({
    op: z.literal("confirm"),
    settlementId: z.string().min(1),
    now: z.string().datetime().optional(),
  }),
]);

export async function POST(req: Request) {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const { repo, backend } = await getStore();
  const now = body.now ? new Date(body.now) : new Date();

  const outcome = body.op === "settle"
    ? await settleAgreement(repo, getRails(), { agreementId: body.agreementId, reservationId: body.reservationId, now })
    : await confirmSettlement(repo, getRails(), { settlementId: body.settlementId, now });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason, settlement: outcome.settlement ?? null, backend },
      { status: outcome.httpStatus },
    );
  }
  return NextResponse.json(
    { data: { settlement: outcome.settlement, agreement: outcome.agreement }, backend, evidenceLevel: outcome.settlement.evidenceLevel },
    { status: outcome.httpStatus },
  );
}
