/**
 * Repository interface for durable economic state.
 *
 * Routes depend on this, never on `lib/store/seed` directly. That is the whole
 * point of Phase 3: the seed array is a fixture, and a production route that
 * imports one cannot be told apart from a demo.
 *
 * The in-memory `CapitalLedger` from Phase 1 satisfies this interface, which
 * is what allows the two to be swapped without touching a route — and lets the
 * same test suite run against both.
 */
import type {
  Authorization, Mandate, Obligation, Reservation, RunEvent, Vault,
} from "@/lib/domain/types";

export interface ReservationInput {
  reservationId: string;
  runId: string;
  vaultId: string;
  intentId: string;
  mandateId: string;
  mandateVersion: number;
  asset: Reservation["asset"];
  amount: number;
  chain: Reservation["chain"];
  actionDigest: string;
  expiresAt: string;
}

export interface ReserveCapitalInput {
  vaultId: string;
  amount: number;
  reservationId: string;
  runId: string;
  intentId: string;
}

/**
 * The outcome of a capital reservation.
 *
 * `ok: false` with a `reason` rather than a thrown error, because "insufficient
 * capital" and "concurrent intents cannot consume the same available capital"
 * (SECURITY.md invariant 13) are *expected outcomes of contention*, not
 * programming errors. A caller should map them to a 409 and move on.
 */
export type CapitalResult =
  | { ok: true; vault: Vault; reservation: Reservation }
  | { ok: false; reason: string };

export interface EconomicRepository {
  getVault(vaultId: string): Promise<Vault | null>;
  getMandate(mandateId: string): Promise<Mandate | null>;
  listReservations(vaultId?: string): Promise<Reservation[]>;
  getReservation(reservationId: string): Promise<Reservation | null>;

  /**
   * Reserve capital atomically.
   *
   * Must be safe under concurrency: two intents racing for the same available
   * capital must not both succeed (SECURITY.md invariant 13). Implementations
   * achieve this with a conditional UPDATE or SELECT ... FOR UPDATE, never a
   * read-then-write.
   */
  reserveCapital(input: ReserveCapitalInput): Promise<CapitalResult>;

  /**
   * Consume a reservation's nonce exactly once.
   *
   * Returns false if the nonce was already consumed — this is the idempotency
   * boundary from docs/API.md, and unlike the Phase 1 in-memory version it
   * must survive a process restart.
   */
  consumeNonce(vaultId: string, nonce: number, reservationId: string): Promise<boolean>;

  setReservationStatus(reservationId: string, status: Reservation["status"]): Promise<Reservation | null>;

  recordAuthorization(auth: Authorization): Promise<void>;
  recentSpend(vaultId: string, mandateId: string, now: Date, windowMinutes: number): Promise<{ at: string; amount: number }[]>;

  /** Append to the durable, replayable event log. */
  appendEvent(event: Omit<RunEvent, "eventId">): Promise<RunEvent>;
  listEvents(runId: string): Promise<RunEvent[]>;
}
