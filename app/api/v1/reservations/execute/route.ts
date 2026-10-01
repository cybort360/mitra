import { NextResponse } from "next/server";
import { z } from "zod";
import { validateExecutionBinding } from "@/lib/kernel/authorization";
import { getStore } from "@/lib/store/provider";

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
  return NextResponse.json(
    { data: committed, backend, evidenceLevel: "LOCAL_PASS", note: "Local simulation only. No chain transaction and no value movement occurred." },
    { status: 200 },
  );
}
