import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import {
  openAgreement,
  availableAgreementOps,
  type AgreementOp,
} from "@/lib/kernel/commerce";
import { applyAgreementOpWithSaga } from "@/lib/kernel/commerce-recovery";
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
  }),
  proposal: z.object({
    capability: z.string().min(1),
    amount: MoneySchema,
  }),
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
      return NextResponse.json(
        { error: openResult.reason, backend },
        { status: 400 },
      );
    }

    if (repo.saveAgreement) {
      await repo.saveAgreement(openResult.value.agreement);
    }
    if (repo.updateSpace) {
      await repo.updateSpace(openResult.value.space);
    }

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
    },
  );

  if (!opResult.ok) {
    return NextResponse.json(
      { error: opResult.reason, backend },
      { status: 400 },
    );
  }

  if (repo.updateAgreement) {
    await repo.updateAgreement(opResult.value.agreement);
  }
  if (repo.updateSpace) {
    await repo.updateSpace(opResult.value.space);
  }

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
