/**
 * Repository interface for durable economic state.
 *
 * Routes depend on this, never on `lib/store/seed` directly. That is the whole
 * point of Phase 3: the seed array is a fixture, and a production route that
 * imports one cannot be told apart from a demo.
 *
 * ## The in-memory ledger does NOT implement this interface
 *
 * An earlier version of this file claimed `CapitalLedger` "satisfies this
 * interface, which is what allows the two to be swapped without touching a
 * route". That was false, and load-bearing enough to be worth stating plainly.
 * It is pinned as false by `tests/repository-contract.test.ts`, which asserts
 * the incompatibility rather than the compatibility.
 *
 * Two concrete reasons it cannot:
 *
 * 1. **Shape.** The ledger is missing `getMandate`, `appendEvent` and
 *    `listEvents` entirely.
 * 2. **Timing.** Every ledger method is synchronous; every method here returns a
 *    `Promise`. A sync method cannot satisfy an async signature.
 *
 * So the swap is not free, and `lib/store/provider.ts` does the adapting — with
 * the in-memory ledger reachable only when no `DATABASE_URL` is configured, and
 * reporting which backend served the request so state is never ambiguous.
 */
import type {
  Agreement, Authorization, Deliverable, Mandate, Obligation, Reservation, Run, RunEvent,
  Settlement, Space, Vault,
} from "@/lib/domain/types";

/** Counts reported by seeding. Widened when spaces and agreements were added. */
export interface SeedCounts {
  vaults: number; mandates: number; reservations: number;
  spaces: number; agreements: number;
}

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
  /**
   * The evaluated terms, written with the reservation.
   *
   * Deliberately required rather than defaulted. An earlier version reserved
   * capital first and let the route patch the row afterwards, which meant the
   * store briefly held a reservation with an empty `mandateId` and `actionDigest`
   * — a row the schema rejects outright on Postgres, and on any store that
   * tolerated it, a reservation that could never be executed. One atomic write
   * with complete terms removes the intermediate state entirely.
   */
  mandateId: string;
  mandateVersion: number;
  asset: Reservation["asset"];
  chain: Reservation["chain"];
  actionDigest: string;
  expiresAt: string;
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

  /**
   * Every vault. Added because `/api/v1/vaults` was reading the seed array
   * directly and returning fixtures with a live reconciliation attached —
   * indistinguishable from real state over HTTP. The store held the vaults; it
   * just could not enumerate them.
   */
  listVaults(): Promise<Vault[]>;

  getMandate(mandateId: string): Promise<Mandate | null>;

  /**
   * Spaces (PRD §13.1) and the agreements inside them.
   *
   * Both are read-only here: the write path is `lib/kernel/commerce.ts`, which is
   * pure and has no store dependency, so the routes apply a transition and then
   * persist the result. Keeping the kernel store-free is what lets the same
   * lifecycle be exercised in a unit test and, later, against Solana.
   */
  listSpaces(): Promise<Space[]>;
  listAgreements(spaceId?: string): Promise<Agreement[]>;

  /**
   * The remaining economic entities.
   *
   * Added because four routes were importing `seed.ts` directly and serving
   * FIXTURES — the same defect `/api/v1/vaults` had. With `DATABASE_URL` unset
   * they looked correct, and with it set they returned an empty world, so the
   * two backends disagreed (F36). A store that cannot enumerate what it holds
   * invites its callers to go around it.
   */
  listObligations(): Promise<Obligation[]>;
  listSettlements(): Promise<Settlement[]>;
  listRuns(): Promise<Run[]>;
  listDeliverables(): Promise<Deliverable[]>;

  /**
   * Load the reference fixtures into this store.
   *
   * Explicit and never called on boot: a process that silently inserted fixtures
   * would be indistinguishable from one holding real data. Production rows come
   * from the PRD Phase 2 vault controller, which does not exist yet.
   */
  seedReferenceData(): Promise<SeedCounts>;
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

  /**
   * Insert or replace a whole reservation row.
   *
   * Exists because a reservation is created from two sources at once: the store
   * allocates the nonce and the capital position, while the route holds the terms
   * that were actually evaluated. Neither half is complete alone, so the row is
   * written whole rather than patched.
   */
  putReservation(reservation: Reservation): Promise<Reservation>;

  recordAuthorization(auth: Authorization): Promise<void>;
  recentSpend(vaultId: string, mandateId: string, now: Date, windowMinutes: number): Promise<{ at: string; amount: number }[]>;

  /** Append to the durable, replayable event log. */
  appendEvent(event: Omit<RunEvent, "eventId">): Promise<RunEvent>;
  listEvents(runId: string): Promise<RunEvent[]>;
}
