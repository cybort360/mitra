import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import {
  netObligations,
  openEpoch,
  freezeEpoch,
  calculateEpoch,
  resolveChallenges,
  finalizeEpochOnce,
} from "@/lib/kernel/clearing";
import { transition } from "@/lib/kernel/machines";
import type { AssetSymbol, Chain, ClearingEpoch, Obligation } from "@/lib/domain/types";

/**
 * Netting preview.
 *
 * Reads obligations through the store and calculates net positions.
 */
// `req` is optional so existing callers of the plain netting preview keep working.
export async function GET(req?: Request) {
  const url = new URL(req?.url ?? "http://localhost/api/v1/clearing");
  const epochId = url.searchParams.get("epochId");
  const { repo, backend } = await getStore();
  // Stored epochs (backlog #5): one by id, or all with ?view=epochs.
  if (epochId) {
    const epoch = await repo.getEpoch(epochId);
    if (!epoch) return NextResponse.json({ error: "EPOCH_NOT_FOUND", epochId, backend }, { status: 404 });
    return NextResponse.json({ data: epoch, backend });
  }
  if (url.searchParams.get("view") === "epochs") {
    const data = await repo.listEpochs();
    return NextResponse.json({ data, count: data.length, backend });
  }
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
    // Opened once, and stored: later actions on this id work on the stored epoch.
    if (!await repo.insertEpoch(epochResult.value)) {
      return NextResponse.json({ error: "EPOCH_EXISTS", epochId: body.epochId, backend }, { status: 409 });
    }

    return NextResponse.json(
      {
        data: epochResult.value,
        persisted: true,
        backend,
        evidenceLevel: "LOCAL_PASS",
      },
      { status: 201 },
    );
  }

  if (body.action === "calculate_epoch") {
    // The STORED epoch when this server opened it; a client-supplied one is only
    // computed over, never stored (F58).
    const stored = await repo.getEpoch((body.epoch as ClearingEpoch)?.epochId ?? "");
    const epoch = stored ?? (body.epoch as ClearingEpoch);
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
    if (stored) await repo.saveEpoch(calcResult.value);

    return NextResponse.json({
      data: calcResult.value,
      persisted: Boolean(stored),
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  if (body.action === "challenge") {
    const stored = await repo.getEpoch((body.epoch as ClearingEpoch)?.epochId ?? "");
    const epoch = stored ?? (body.epoch as ClearingEpoch);
    const resolved = resolveChallenges(epoch, body.challenges);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.reason, backend }, { status: 400 });
    }
    if (stored) await repo.saveEpoch(resolved.value);
    return NextResponse.json({
      data: resolved.value,
      persisted: Boolean(stored),
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  if (body.action === "finalize_epoch") {
    // F58: this used to finalize the epoch object the CLIENT sent, after checking only
    // its status — so forged net positions or transfers could be "finalized". It now
    // seals only an epoch this server opened and calculated, from its STORED result,
    // and applies the single-epoch rule (an obligation in at most one finalized
    // epoch, SECURITY.md) against the stored finalized epochs.
    const stored = await repo.getEpoch((body.epoch as ClearingEpoch)?.epochId ?? "");
    if (!stored) {
      return NextResponse.json(
        { error: "EPOCH_NOT_FOUND", note: "Only an epoch opened through this server can be finalized.", backend },
        { status: 409 },
      );
    }
    if (stored.status !== "CHALLENGE") {
      return NextResponse.json({ error: "EPOCH_NOT_IN_CHALLENGE", status: stored.status, backend }, { status: 400 });
    }
    const finalizedEpochs = (await repo.listEpochs()).filter((e) => e.status === "FINALIZED" && e.epochId !== stored.epochId);
    const sealed = finalizeEpochOnce(stored, {
      grossVolume: stored.grossVolume,
      residualVolume: stored.netResidual,
      netPositions: stored.netPositions,
      residualTransfers: stored.residualTransfers,
      excluded: stored.excludedObligations,
    }, finalizedEpochs);
    if (!sealed.ok) return NextResponse.json({ error: sealed.reason, backend }, { status: 409 });
    const finalized = { ...sealed.value, finalizedAt: new Date().toISOString() };
    await repo.saveEpoch(finalized);

    return NextResponse.json({
      data: finalized,
      persisted: true,
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
}
