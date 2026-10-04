import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateProposal } from "@/lib/kernel/authorization";
import { getStore } from "@/lib/store/provider";
import { actionDigestFor, newId } from "@/lib/store/ids";
import { AGREEMENT_PAYMENT_CAPABILITY } from "@/lib/kernel/settlement";
import { recordEvent } from "@/lib/store/events";
import type { Reservation } from "@/lib/domain/types";

/**
 * Reservations are the capital-commitment step. Creating one is NOT executing
 * it: the execution guard lives in /api/v1/reservations/execute and re-checks
 * the exact action digest, amount, asset, chain, expiry and nonce, which is
 * what makes "an ALLOW is not permission" true rather than aspirational.
 */

export const createReservationSchema = z.object({
  mandateId: z.string().min(1),
  vaultId: z.string().min(1),
  amount: z.number().positive(),
  asset: z.string().min(1),
  chain: z.string().min(1),
  counterparty: z.string().min(1),
  capability: z.string().min(1),
  intentId: z.string().min(1),
  runId: z.string().min(1),
  /** Minutes until the reservation lapses. */
  ttlMinutes: z.number().int().min(1).max(1440).default(30),
  /**
   * The agreement this reservation will pay. Bound into the action digest, so the
   * reservation can settle that agreement and no other (`lib/kernel/settlement.ts`).
   */
  agreementId: z.string().min(1).optional(),
  now: z.string().datetime().optional(),
});

export async function GET(req: Request) {
  const vaultId = new URL(req.url).searchParams.get("vaultId") ?? undefined;
  const { repo, backend } = await getStore();
  const data = await repo.listReservations(vaultId);
  return NextResponse.json({ data, count: data.length, backend });
}

export async function POST(req: Request) {
  const parsed = createReservationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const { repo, backend } = await getStore();

  const mandate = await repo.getMandate(body.mandateId);
  if (!mandate) return NextResponse.json({ error: "MANDATE_NOT_FOUND", mandateId: body.mandateId }, { status: 404 });

  const vault = await repo.getVault(body.vaultId);
  if (!vault) return NextResponse.json({ error: "VAULT_NOT_FOUND", vaultId: body.vaultId }, { status: 404 });
  if (mandate.vaultId !== vault.vaultId) {
    return NextResponse.json({ error: "MANDATE_VAULT_MISMATCH", mandateVaultId: mandate.vaultId }, { status: 409 });
  }

  // A reservation for an agreement must carry exactly the terms the settlement will
  // re-derive. Settlement would refuse a mismatch anyway (ACTION_DIGEST_MISMATCH);
  // checking here means the capital is never reserved for a payment that cannot
  // happen, and the caller learns which term is wrong.
  if (body.agreementId) {
    const agreement = repo.getAgreement ? await repo.getAgreement(body.agreementId) : null;
    if (!agreement) return NextResponse.json({ error: "AGREEMENT_NOT_FOUND", agreementId: body.agreementId }, { status: 404 });
    const mismatch =
      body.counterparty !== agreement.provider ? "counterparty"
      : body.amount !== agreement.price.amount ? "amount"
      : body.asset !== agreement.price.asset ? "asset"
      : body.chain !== agreement.payTo?.chain ? "chain"
      : body.capability !== AGREEMENT_PAYMENT_CAPABILITY ? "capability"
      : mandate.agentId !== agreement.client ? "mandate"
      : null;
    if (mismatch) {
      return NextResponse.json(
        { error: "RESERVATION_TERMS_DO_NOT_MATCH_AGREEMENT", term: mismatch, note: "No capital was reserved." },
        { status: 409 },
      );
    }
  }

  const now = body.now ? new Date(body.now) : new Date();
  const actionDigest = actionDigestFor({
    vaultId: vault.vaultId, mandateId: mandate.mandateId, mandateVersion: mandate.version,
    amount: body.amount, asset: body.asset, chain: body.chain,
    counterparty: body.counterparty, capability: body.capability,
    ...(body.agreementId ? { agreementId: body.agreementId } : {}),
  });

  // Policy runs before any capital moves. A DENY must leave nothing behind.
  const policy = evaluateProposal(mandate, vault, {
    amount: body.amount, asset: body.asset, chain: body.chain,
    counterparty: body.counterparty, capability: body.capability, actionDigest, now,
  }, { recentSpend: await repo.recentSpend(vault.vaultId, mandate.mandateId, now, mandate.velocityLimit?.windowMinutes ?? 60) });

  if (policy.decision !== "ALLOW") {
    await recordEvent(repo, {
      runId: body.runId, kind: "AUTHORITY", title: "Reservation denied by policy", status: "WARNING",
      description: `${policy.reasonCodes.join(", ")}. No capital was reserved.`, objectRef: mandate.mandateId,
      metadata: { amount: body.amount, asset: body.asset, counterparty: body.counterparty, decision: policy.decision },
    });
    return NextResponse.json(
      { error: "POLICY_DENIED", reasonCodes: policy.reasonCodes, note: "No capital was reserved." },
      { status: 403 },
    );
  }

  // The evaluated terms go in with the reservation, in one atomic write. The
  // store allocates the nonce and moves the capital; the route holds the terms
  // that were actually checked. Splitting those into a reserve-then-patch left
  // the store briefly holding a reservation with no `mandateId` and no digest,
  // which Postgres rejects outright — and which, on any store that tolerated it,
  // is a reservation that can never be executed.
  const reserved = await repo.reserveCapital({
    vaultId: vault.vaultId,
    amount: body.amount,
    reservationId: newId("res"),
    runId: body.runId,
    intentId: body.intentId,
    mandateId: mandate.mandateId,
    mandateVersion: mandate.version,
    asset: body.asset as Reservation["asset"],
    chain: body.chain as Reservation["chain"],
    actionDigest,
    expiresAt: new Date(now.getTime() + body.ttlMinutes * 60_000).toISOString(),
    ...(body.agreementId ? { agreementId: body.agreementId } : {}),
  });
  if (!reserved.ok) {
    return NextResponse.json({ error: reserved.reason, backend }, { status: 409 });
  }
  await recordEvent(repo, {
    runId: body.runId, kind: "VAULT", title: "Capital reserved", status: "SUCCESS",
    description: `${body.amount} ${body.asset} reserved on ${vault.vaultId} for ${body.counterparty}. Reserved, not moved.`,
    objectRef: reserved.reservation.reservationId,
    metadata: { amount: body.amount, asset: body.asset, vaultId: vault.vaultId, ...(body.agreementId ? { agreementId: body.agreementId } : {}) },
  });

  return NextResponse.json(
    { data: reserved.reservation, vault: reserved.vault, backend, evidenceLevel: "LOCAL_PASS", note: "Capital is reserved, not moved. Execution requires the exact action digest." },
    { status: 201 },
  );
}
