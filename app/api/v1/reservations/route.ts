import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateProposal } from "@/lib/kernel/authorization";
import { reserve as reserveCapital } from "@/lib/kernel/vault";
import { mandates } from "@/lib/store/seed";
import { actionDigestFor, getLedger, newId } from "@/lib/store/ledger";
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
  now: z.string().datetime().optional(),
});

export async function GET(req: Request) {
  const vaultId = new URL(req.url).searchParams.get("vaultId") ?? undefined;
  const data = getLedger().listReservations(vaultId);
  return NextResponse.json({ data, count: data.length });
}

export async function POST(req: Request) {
  const parsed = createReservationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const ledger = getLedger();

  const mandate = mandates.find((m) => m.mandateId === body.mandateId);
  if (!mandate) return NextResponse.json({ error: "MANDATE_NOT_FOUND", mandateId: body.mandateId }, { status: 404 });

  const vault = ledger.getVault(body.vaultId);
  if (!vault) return NextResponse.json({ error: "VAULT_NOT_FOUND", vaultId: body.vaultId }, { status: 404 });
  if (mandate.vaultId !== vault.vaultId) {
    return NextResponse.json({ error: "MANDATE_VAULT_MISMATCH", mandateVaultId: mandate.vaultId }, { status: 409 });
  }

  const now = body.now ? new Date(body.now) : new Date();
  const actionDigest = actionDigestFor({
    vaultId: vault.vaultId, mandateId: mandate.mandateId, mandateVersion: mandate.version,
    amount: body.amount, asset: body.asset, chain: body.chain,
    counterparty: body.counterparty, capability: body.capability,
  });

  // Policy runs before any capital moves. A DENY must leave nothing behind.
  const policy = evaluateProposal(mandate, vault, {
    amount: body.amount, asset: body.asset, chain: body.chain,
    counterparty: body.counterparty, capability: body.capability, actionDigest, now,
  }, { recentSpend: ledger.recentSpend(vault.vaultId, mandate.mandateId, now, mandate.velocityLimit?.windowMinutes ?? 60) });

  if (policy.decision !== "ALLOW") {
    return NextResponse.json(
      { error: "POLICY_DENIED", reasonCodes: policy.reasonCodes, note: "No capital was reserved." },
      { status: 403 },
    );
  }

  let updated: ReturnType<typeof ledger.reserveCapital>;
  try {
    updated = ledger.reserveCapital(vault.vaultId, body.amount, reserveCapital);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "RESERVATION_FAILED" }, { status: 409 });
  }

  const reservation: Reservation = {
    reservationId: newId("res"),
    runId: body.runId, vaultId: vault.vaultId, intentId: body.intentId,
    mandateId: mandate.mandateId, mandateVersion: mandate.version,
    asset: body.asset as Reservation["asset"], amount: body.amount,
    chain: body.chain as Reservation["chain"],
    actionDigest,
    expiresAt: new Date(now.getTime() + body.ttlMinutes * 60_000).toISOString(),
    // Allocated by the ledger, never invented here: a fixed nonce would collide
    // with an already-spent one and cause valid later instructions to be
    // refused as replays.
    nonce: ledger.allocateNonce(vault.vaultId),
    status: "RESERVED",
    version: 1,
  };
  ledger.putReservation(reservation);

  return NextResponse.json(
    { data: reservation, vault: updated, evidenceLevel: "LOCAL_PASS", note: "Capital is reserved, not moved. Execution requires the exact action digest." },
    { status: 201 },
  );
}
