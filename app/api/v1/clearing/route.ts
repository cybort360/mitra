import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import {
  netObligations,
  openEpoch,
  freezeEpoch,
  calculateEpoch,
  resolveChallenges,
} from "@/lib/kernel/clearing";
import { transition } from "@/lib/kernel/machines";
import type { AssetSymbol, Chain, ClearingEpoch, Obligation } from "@/lib/domain/types";

/**
 * Netting preview.
 *
 * Reads obligations through the store and calculates net positions.
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const obligations = await repo.listObligations();
  const netting = netObligations(obligations);
  return NextResponse.json({
    data: netting,
    compressionRatio:
      netting.grossVolume > 0
        ? Number(((netting.grossVolume - netting.residualVolume) / netting.grossVolume).toFixed(4))
        : 0,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}

const ObligationSchema = z.object({
  obligationId: z.string().min(1),
  debtor: z.string().min(1),
  creditor: z.string().min(1),
  amount: z.object({
    asset: z.string().min(1),
    amount: z.number().positive(),
  }),
  status: z.enum([
    "PROPOSED",
    "ACCEPTED",
    "ACCRUING",
    "DUE",
    "DISPUTED",
    "DEFAULTED",
    "CLEARED",
    "SETTLING",
    "SETTLED",
  ]),
  createdAt: z.string().optional(),
  dueAt: z.string().optional(),
});

const ClearingPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("net"),
    obligations: z.array(ObligationSchema).optional(),
  }),
  z.object({
    action: z.literal("open_epoch"),
    epochId: z.string().min(1),
    asset: z.string().min(1),
    settlementDomain: z.string().min(1),
    obligations: z.array(ObligationSchema).optional(),
    openedAt: z.string().optional(),
  }),
  z.object({
    action: z.literal("calculate_epoch"),
    epoch: z.any(),
    obligations: z.array(ObligationSchema).optional(),
  }),
  z.object({
    action: z.literal("challenge"),
    epoch: z.any(),
    challenges: z.array(
      z.object({
        obligationId: z.string().min(1),
        challenger: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
  }),
  z.object({
    action: z.literal("finalize_epoch"),
    epoch: z.any(),
  }),
]);

/**
 * Drive Clearing & Netting and Epoch Lifecycle.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = ClearingPostSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const { repo, backend } = await getStore();
  const storeObligations = await repo.listObligations();

  if (body.action === "net") {
    const inputObligations = (body.obligations as Obligation[] | undefined) ?? storeObligations;
    const result = netObligations(inputObligations);
    const compressionRatio =
      result.grossVolume > 0
        ? Number(((result.grossVolume - result.residualVolume) / result.grossVolume).toFixed(4))
        : 0;

    return NextResponse.json({
      data: {
        ...result,
        compressionRatio,
        conservationVerified:
          Math.abs(result.netPositions.reduce((s, p) => s + p.amount, 0)) < 1e-6,
      },
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  if (body.action === "open_epoch") {
    const inputObligations = (body.obligations as Obligation[] | undefined) ?? storeObligations;
    const epochResult = openEpoch({
      epochId: body.epochId,
      asset: body.asset as AssetSymbol,
      settlementDomain: body.settlementDomain as Chain,
      obligations: inputObligations,
      openedAt: body.openedAt ?? new Date().toISOString(),
    });

    if (!epochResult.ok) {
      return NextResponse.json({ error: epochResult.reason, backend }, { status: 400 });
    }

    return NextResponse.json(
      {
        data: epochResult.value,
        backend,
        evidenceLevel: "LOCAL_PASS",
      },
      { status: 201 },
    );
  }

  if (body.action === "calculate_epoch") {
    const epoch = body.epoch as ClearingEpoch;
    const inputObligations = (body.obligations as Obligation[] | undefined) ?? storeObligations;

    // Advance through FROZEN -> CALCULATING -> CHALLENGE
    let currentEpoch = epoch;
    if (currentEpoch.status === "OPEN") {
      const freezeResult = freezeEpoch(currentEpoch, inputObligations);
      if (!freezeResult.ok) {
        return NextResponse.json({ error: freezeResult.reason, backend }, { status: 400 });
      }
      currentEpoch = freezeResult.value;
    }

    const calcResult = calculateEpoch(currentEpoch, inputObligations);
    if (!calcResult.ok) {
      return NextResponse.json({ error: calcResult.reason, backend }, { status: 400 });
    }

    return NextResponse.json({
      data: calcResult.value,
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  if (body.action === "challenge") {
    const epoch = body.epoch as ClearingEpoch;
    const resolved = resolveChallenges(epoch, body.challenges);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.reason, backend }, { status: 400 });
    }
    return NextResponse.json({
      data: resolved.value,
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  if (body.action === "finalize_epoch") {
    const epoch = body.epoch as ClearingEpoch;
    if (epoch.status !== "CHALLENGE") {
      return NextResponse.json(
        { error: "EPOCH_NOT_IN_CHALLENGE", status: epoch.status, backend },
        { status: 400 },
      );
    }

    const finalized = transition("clearingEpoch", {
      ...epoch,
      finalizedAt: new Date().toISOString(),
    }, "FINALIZED");

    return NextResponse.json({
      data: finalized,
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
}
