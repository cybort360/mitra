import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import {
  openAgreement,
  availableAgreementOps,
  type AgreementOp,
} from "@/lib/kernel/commerce";
import { applyAgreementOpWithSaga } from "@/lib/kernel/commerce-recovery";
import { recordEvent } from "@/lib/store/events";
import type { Agreement, Money, Space } from "@/lib/domain/types";

/**
 * List agreements, optionally filtered to one Space or by agreementId.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const spaceId = url.searchParams.get("spaceId") ?? undefined;
  const agreementId = url.searchParams.get("agreementId") ?? undefined;
  const { repo, backend } = await getStore();

  if (agreementId) {
    const agreement = repo.getAgreement
      ? await repo.getAgreement(agreementId)
      : (await repo.listAgreements()).find((a) => a.agreementId === agreementId) ?? null;

    if (!agreement) {
      return NextResponse.json(
        { error: "AGREEMENT_NOT_FOUND", agreementId, backend },
        { status: 404 },
      );
    }

    return NextResponse.json({
      data: {
        ...agreement,
        availableOps: availableAgreementOps(agreement.status),
      },
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

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

const MoneySchema = z.object({
  asset: z.string().min(1),
  amount: z.number().positive(),
});

const OpenAgreementSchema = z.object({
  op: z.literal("open"),
  spaceId: z.string().min(1),
  draft: z.object({
    agreementId: z.string().min(1),
    runId: z.string().min(1),
    intentId: z.string().min(1),
    client: z.string().min(1),
    provider: z.string().min(1),
    evaluator: z.string().min(1),
    externalJobRefs: z.array(z.string()).default([]),
    price: MoneySchema,
    deadline: z.string().min(1),
    acceptanceCriteria: z.array(z.string()).default([]),
    failurePolicy: z.string().optional(),
    /** Where the provider is paid. A term, fixed here; settlement never takes a payee from its caller. */
    payTo: z.object({
      chain: z.enum(["solana", "base", "tempo"]),
      address: z.string().min(1),
    }).optional(),
  }),
  proposal: z.object({
    capability: z.string().min(1),
    amount: MoneySchema,
  }),
});

const OnChainEscrowSchema = z.object({
  chain: z.string().min(1),
  contractAddress: z.string().min(1),
  jobId: z.string().min(1),
  timeout: z.number().optional(),
});

const TransitionAgreementSchema = z.object({
  op: z.enum([
    "fund",
    "startExecution",
    "submitDeliverable",
    "acceptDeliverable",
    "rejectDeliverable",
    "refund",
  ]),
  agreementId: z.string().min(1),
  spaceId: z.string().optional(),
  capability: z.string().optional(),
  amount: MoneySchema.optional(),
  artifactRefs: z.array(z.string()).optional(),
  contentHash: z.string().optional(),
  failureReason: z.string().optional(),
  onChainEscrow: OnChainEscrowSchema.optional(),
});

const AgreementPostSchema = z.discriminatedUnion("op", [
  OpenAgreementSchema,
  TransitionAgreementSchema,
]);

/**
 * Drive commercial agreement lifecycle.
 *
 * All operations are bound to TALOS recovery sagas via `applyAgreementOpWithSaga`.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = AgreementPostSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const { repo, backend } = await getStore();

  // These writes used to be skipped with `if (repo.saveAgreement)`, so a store
  // without them answered 2xx and persisted nothing (the Postgres repository had
  // none until sprint item 1). Refuse instead: a 2xx must mean it was written.
  if (!repo.getAgreement || !repo.saveAgreement || !repo.updateAgreement || !repo.getSpace || !repo.updateSpace) {
    return NextResponse.json({ error: "STORE_CANNOT_PERSIST_AGREEMENTS", backend }, { status: 501 });
  }

  if (body.op === "open") {
    const space = repo.getSpace
      ? await repo.getSpace(body.spaceId)
      : (await repo.listSpaces()).find((s) => s.spaceId === body.spaceId) ?? null;

    if (!space) {
      return NextResponse.json(
        { error: "SPACE_NOT_FOUND", spaceId: body.spaceId, backend },
        { status: 404 },
      );
    }

    const openResult = openAgreement(
      space,
      body.draft as unknown as Omit<Agreement, "status" | "version" | "spaceIds">,
      body.proposal as unknown as { capability: string; amount: Money },
    );

    if (!openResult.ok) {
      await recordEvent(repo, {
        runId: body.draft.runId, kind: "COMMERCE", title: "Agreement refused at open", status: "WARNING",
        description: `The Space refused the agreement: ${openResult.reason}.`, objectRef: body.draft.agreementId,
        metadata: { reason: openResult.reason, spaceId: body.spaceId },
      });
      return NextResponse.json(
        { error: openResult.reason, backend },
        { status: 400 },
      );
    }

    await repo.saveAgreement(openResult.value.agreement);
    await repo.updateSpace(openResult.value.space);
    await recordEvent(repo, {
      runId: openResult.value.agreement.runId, kind: "COMMERCE", title: "Agreement opened", status: "SUCCESS",
      description: `${openResult.value.agreement.client} → ${openResult.value.agreement.provider}, ${openResult.value.agreement.price.amount} ${openResult.value.agreement.price.asset}.`,
      objectRef: openResult.value.agreement.agreementId,
      metadata: { spaceId: body.spaceId, amount: openResult.value.agreement.price.amount, asset: openResult.value.agreement.price.asset },
    });

    return NextResponse.json(
      {
        data: {
          agreement: {
            ...openResult.value.agreement,
            availableOps: availableAgreementOps(openResult.value.agreement.status),
          },
          space: openResult.value.space,
        },
        backend,
        evidenceLevel: "LOCAL_PASS",
      },
      { status: 201 },
    );
  }

  // Lifecycle transition operations:
  const agreement = repo.getAgreement
    ? await repo.getAgreement(body.agreementId)
    : (await repo.listAgreements()).find((a) => a.agreementId === body.agreementId) ?? null;

  if (!agreement) {
    return NextResponse.json(
      { error: "AGREEMENT_NOT_FOUND", agreementId: body.agreementId, backend },
      { status: 404 },
    );
  }

  const spaceId = body.spaceId ?? agreement.spaceIds?.[0];
  if (!spaceId) {
    return NextResponse.json(
      { error: "SPACE_ID_REQUIRED", agreementId: body.agreementId, backend },
      { status: 400 },
    );
  }

  const space = repo.getSpace
    ? await repo.getSpace(spaceId)
    : (await repo.listSpaces()).find((s) => s.spaceId === spaceId) ?? null;

  if (!space) {
    return NextResponse.json(
      { error: "SPACE_NOT_FOUND", spaceId, backend },
      { status: 404 },
    );
  }

  const opResult = await applyAgreementOpWithSaga(
    repo,
    space,
    agreement,
    body.op as AgreementOp,
    {
      capability: body.capability,
      amount: body.amount as unknown as { asset: Agreement["price"]["asset"]; amount: number } | undefined,
      artifactRefs: body.artifactRefs,
      contentHash: body.contentHash,
      failureReason: body.failureReason,
      onChainEscrow: body.onChainEscrow,
    },
  );

  if (!opResult.ok) {
    await recordEvent(repo, {
      runId: agreement.runId, kind: "COMMERCE", title: `Agreement ${body.op} refused`, status: "WARNING",
      description: `${body.op} was refused: ${opResult.reason}.`, objectRef: agreement.agreementId,
      metadata: { op: body.op, reason: opResult.reason, from: agreement.status },
    });
    return NextResponse.json(
      { error: opResult.reason, backend },
      { status: 400 },
    );
  }

  await repo.updateAgreement(opResult.value.agreement);
  await repo.updateSpace(opResult.value.space);
  await recordEvent(repo, {
    runId: agreement.runId, kind: "COMMERCE", title: `Agreement ${agreement.status} → ${opResult.value.agreement.status}`,
    status: opResult.value.agreement.status === "REJECTED" ? "WARNING" : "SUCCESS",
    description: `${body.op} applied.`, objectRef: agreement.agreementId,
    metadata: { op: body.op, from: agreement.status, to: opResult.value.agreement.status },
  });

  return NextResponse.json({
    data: {
      ...opResult.value,
      agreement: {
        ...opResult.value.agreement,
        availableOps: availableAgreementOps(opResult.value.agreement.status),
      },
    },
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
