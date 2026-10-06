import { NextResponse } from "next/server";
import { refuseIfPaused } from "@/lib/admin/incident";
import { z } from "zod";
import { validateExecutionBinding } from "@/lib/kernel/authorization";
import { getStore } from "@/lib/store/provider";
import { recordEvent } from "@/lib/store/events";

/**
 * The execution guard.
 *
 * An authorization decision is not itself permission to move value. This route
 * is the only place a reservation becomes executable, and it re-derives the
 * binding independently of whatever the policy said earlier: exact action
 * digest, amount within the reservation, asset, chain, expiry, and a nonce that
 * can only be spent once.
 *
 * The consumed-nonce list comes from the store, never from the request — if the
 * caller supplied it, the idempotency boundary would be self-asserted.
 */
const executeSchema = z.object({
  reservationId: z.string().min(1),
  amount: z.number().positive(),
  asset: z.string().min(1),
  chain: z.string().min(1),
  actionDigest: z.string().min(1),
  now: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const parsed = executeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  // Incident controls (PP-4): the guard refuses everything under an `execution` pause.
  const paused = await refuseIfPaused("execution");
  if (paused) return paused;
  const { repo, backend } = await getStore();

  const reservation = await repo.getReservation(body.reservationId);
  if (!reservation) {
    return NextResponse.json({ error: "RESERVATION_NOT_FOUND", reservationId: body.reservationId, backend }, { status: 404 });
  }

  const now = body.now ? new Date(body.now) : new Date();
  // Consumed nonces come from the store, never from the request. Derived from
  // committed/settled reservations so the feed cannot be forged by the caller.
  const consumedNonces = (await repo.listReservations(reservation.vaultId))
    .filter((r) => r.status === "COMMITTED" || r.status === "SETTLED")
    .map((r) => r.nonce);

  const binding = validateExecutionBinding(
    reservation, body.actionDigest, body.amount, body.asset, body.chain, now,
    { consumedNonces },
  );

  if (!binding.ok) {
    await recordEvent(repo, {
      runId: reservation.runId, kind: "VAULT", title: "Execution refused by the guard", status: "WARNING",
      description: `${binding.reason}: this instruction does not match what was authorized.`, objectRef: reservation.reservationId,
      metadata: { reason: binding.reason },
    });
    return NextResponse.json(
      { error: "EXECUTION_REJECTED", reason: binding.reason, reservationId: reservation.reservationId, backend },
      { status: 409 },
    );
  }

  // The nonce is spent only after the guard passes, and only once. A replay of
  // an otherwise identical instruction is refused on the second attempt.
  if (!await repo.consumeNonce(reservation.vaultId, reservation.nonce, reservation.reservationId)) {
    return NextResponse.json(
      { error: "EXECUTION_REJECTED", reason: "NONCE_ALREADY_CONSUMED", reservationId: reservation.reservationId, backend },
      { status: 409 },
    );
  }

  const committed = await repo.setReservationStatus(reservation.reservationId, "COMMITTED");
  await recordEvent(repo, {
    runId: reservation.runId, kind: "VAULT", title: "Reservation committed", status: "INFO",
    description: "The execution guard passed and the nonce was spent. Local simulation: no value moved.",
    objectRef: reservation.reservationId, metadata: { amount: reservation.amount, asset: reservation.asset },
  });
  return NextResponse.json(
    { data: committed, backend, evidenceLevel: "LOCAL_PASS", note: "Local simulation only. No chain transaction and no value movement occurred." },
    { status: 200 },
  );
}
