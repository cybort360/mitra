import { NextResponse } from "next/server";
import { refuseIfPaused } from "@/lib/admin/incident";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import { getRails } from "@/lib/settlement/rails";
import { confirmSettlement, settleAgreement, settleCrossChainAgreement, settleResidual } from "@/lib/settlement/settle-agreement";
import { getClearingReader } from "@/lib/settlement/clearing-reader";
import { receiptSignerFromEnv } from "@/lib/settlement/receipt-signer";
import { LiFiPayoutRelayer, SimulatedPayoutRelayer, isExternalChain, type CrossChainPayoutRelayer } from "@/lib/adapters/cross-chain-payout";

/**
 * The relayer for this process.
 *
 * Live when `LIFI_API_KEY` **and** a broadcaster are both present; otherwise the
 * **simulator**, which tags every result `isSimulated: true` / `LOCAL_PASS`.
 *
 * The two-condition rule is deliberate. A live relayer that can quote but cannot broadcast
 * would pass the quote, pass the fee and slippage guards, settle the canonical leg, and
 * then fail — leaving funds in the relayer account on every single attempt. The ordering
 * makes that failure recoverable rather than fatal, which is the right property to have, but
 * "recoverable, every time" is not the same as working. So a live path is only taken when
 * it can actually complete end to end.
 *
 * There is deliberately no third option: never silently fall back to the canonical path for
 * an external payee, because that would pay a BNB Chain address from a Base vault — a
 * transfer to an address on the wrong chain, not a settlement.
 */
function payoutRelayerFromEnv(): CrossChainPayoutRelayer {
  const integrator = process.env.MITRA_CROSS_CHAIN_RELAYER_ADDRESS;
  const broadcast = process.env.MITRA_CROSS_CHAIN_BROADCAST;
  if (process.env.LIFI_API_KEY && integrator && broadcast) {
    return new LiFiPayoutRelayer({
      apiKey: process.env.LIFI_API_KEY,
      integrator,
      testnet: process.env.NODE_ENV !== "production",
      onBroadcast: async (tx) => broadcastBridgeTransaction(tx, broadcast),
    });
  }
  return new SimulatedPayoutRelayer({ fee: { asset: "USDC", amount: 0.05 } });
}

/**
 * Broadcast a bridge transaction and return its hash.
 *
 * Stubbed to refuse rather than guess. `MITRA_CROSS_CHAIN_BROADCAST` names a signer this
 * repository does not yet hold, and a bridge that reported a hash nobody broadcast would be
 * the single worst thing this module could do — a settlement record citing a transaction
 * that does not exist. Refusing here is the correct state until a real signer is wired.
 */
async function broadcastBridgeTransaction(
  _tx: { to: string; data: string; value: bigint },
  _signerRef: string,
): Promise<string> {
  throw new Error("UNCONFIGURED_RELAYER: no bridge broadcaster is wired; refusing to report an unbroadcast transaction");
}

/** Where the canonical leg pays. Refuses rather than defaulting to a placeholder. */
function relayerAddressFromEnv(): string {
  const addr = process.env.MITRA_CROSS_CHAIN_RELAYER_ADDRESS;
  if (!addr) {
    throw new Error("UNCONFIGURED_RELAYER: MITRA_CROSS_CHAIN_RELAYER_ADDRESS is not set");
  }
  return addr;
}

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
    // Phase 7: residual `transferIndex` of a FINALIZED epoch. The payee, amount
    // and chain come from the epoch and the registry, and MitraClearing must agree.
    op: z.literal("settleResidual"),
    epochId: z.string().min(1),
    transferIndex: z.number().int().min(0),
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
  // Incident controls (PP-4): paying is stopped; `confirm` is not, because it
  // records a payment that has already happened on chain.
  if (body.op !== "confirm") {
    const paused = await refuseIfPaused("execution");
    if (paused) return paused;
  }
  const { repo, backend } = await getStore();
  const now = body.now ? new Date(body.now) : new Date();

  const rails = await getRails();
  const receiptSigner = receiptSignerFromEnv();

  // ── LP-7: an external payee takes the cross-chain path ───────────────────────
  // Dispatched on the AGREEMENT's `payTo`, read from the store and never from the
  // request: letting a caller name the destination chain would let them choose the path
  // a settlement takes, which is the routing authority this dispatch exists to withhold.
  //
  // An unconfigured relayer refuses with `UNCONFIGURED_RELAYER` rather than falling back
  // to the canonical path — a fallback would pay a BNB address from a Base vault, which
  // is a transfer to an address on the wrong chain, not a settlement.
  if (body.op === "settle") {
    const agreement = repo.getAgreement ? await repo.getAgreement(body.agreementId) : null;
    if (agreement?.payTo && isExternalChain(agreement.payTo.chain)) {
      let relayer: CrossChainPayoutRelayer;
      try {
        relayer = payoutRelayerFromEnv();
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message, backend }, { status: 503 });
      }
      const outcome = await settleCrossChainAgreement(repo, rails, {
        agreementId: body.agreementId, reservationId: body.reservationId, now,
        relayer, relayerAddress: relayerAddressFromEnv(), testnet: process.env.NODE_ENV !== "production",
      });
      if (!outcome.ok) {
        return NextResponse.json(
          { error: outcome.reason, detail: outcome.detail ?? null, backend },
          { status: outcome.httpStatus },
        );
      }
      return NextResponse.json(
        {
          data: { settlement: outcome.settlement, receipt: outcome.receipt },
          backend,
          evidenceLevel: outcome.receipt.evidenceLevel,
        },
        { status: outcome.httpStatus },
      );
    }
  }

  const outcome = body.op === "settle"
    ? await settleAgreement(repo, rails, { agreementId: body.agreementId, reservationId: body.reservationId, now, receiptSigner })
    : body.op === "settleResidual"
      ? await settleResidual(repo, rails, getClearingReader(), {
        epochId: body.epochId, transferIndex: body.transferIndex, reservationId: body.reservationId, now, receiptSigner,
      })
      : await confirmSettlement(repo, rails, { settlementId: body.settlementId, now, receiptSigner });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason, settlement: outcome.settlement ?? null, backend },
      { status: outcome.httpStatus },
    );
  }
  return NextResponse.json(
    { data: { settlement: outcome.settlement, agreement: outcome.agreement ?? null, epoch: outcome.epoch ?? null }, backend, evidenceLevel: outcome.settlement.evidenceLevel },
    { status: outcome.httpStatus },
  );
}
