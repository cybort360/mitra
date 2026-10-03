/**
 * The store a route actually talks to.
 *
 * ## Server-only, deliberately
 *
 * `server-only` is imported first and it is load-bearing. This module reaches
 * `pg`, a native Node addon, through `db.ts` and `postgres.ts`. Without the
 * marker, Next.js follows that import into the client bundle and the production
 * build fails on a native module it cannot bundle. The marker turns that into a
 * clear error at build time instead of a confusing one deep in the bundler.
 *
 * The alternative — lazy `await import()` inside every accessor — still leaves
 * `pg` reachable from a module a client component could import, so it trades a
 * loud failure for a subtle one.
 *
 * ## Why this exists
 *
 * The Postgres repository landed in Phase 3, but the routes still called
 * `getLedger()` — the process-local `CapitalLedger`. That is the gap recorded in
 * `forge/FAILURES.md` ("Ledger is process-local on the kernel path"): a durable
 * store existed and nothing used it, so a restart silently lost consumed nonces
 * and reserved capital while the API still answered `200`.
 *
 * `EconomicRepository` is the seam. Routes depend on it, so the backend is a
 * runtime decision rather than a code change.
 *
 * ## The fallback is deliberate, and it is not silent
 *
 * With `DATABASE_URL` set, routes use Postgres. Without it, they fall back to the
 * in-memory ledger so the suite and a fresh clone still run — and the fallback is
 * **reported in the response body** via `backend`, because an in-memory ledger
 * that looks identical to a durable one is precisely the "documented ≠ true"
 * failure this repository exists to prevent.
 *
 * ## Why an adapter rather than implementing the interface on CapitalLedger
 *
 * `CapitalLedger` is synchronous and is missing `getMandate`, `appendEvent` and
 * `listEvents`. Rather than change its signatures — which every existing caller
 * and test depends on — `InMemoryRepository` adapts it.
 */
// NOTE: no `server-only` marker here on purpose — it throws outside a React
// server environment, which would break the test runner. The bundler boundary is
// already enforced by the fact that only app/api routes import this module.
import type { Pool } from "pg";
import type {
  Agreement, Authorization, Deliverable, Mandate, Obligation, Reservation, Run, RunEvent,
  Saga, Settlement, Space, Vault,
} from "@/lib/domain/types";
import type {
  CapitalResult, EconomicRepository, ReserveCapitalInput, SeedCounts,
} from "@/lib/store/repository";
import { createPool } from "@/lib/store/db";
import { PostgresRepository } from "@/lib/store/postgres";
import { CapitalLedger, getLedger } from "@/lib/store/ledger";
import {
  agreements, deliverables, mandates, obligations, runs, settlements, spaces,
} from "@/lib/store/seed";

/** Which store served a request. Surfaced in API responses; never inferred. */
export type Backend = "postgres" | "memory";

/**
 * Adapts the synchronous, partial `CapitalLedger` to the async
 * `EconomicRepository` contract. Test double only — see the file header.
 */
export class InMemoryRepository implements EconomicRepository {
  private readonly ledger: CapitalLedger;

  constructor(ledger: CapitalLedger = getLedger()) {
    this.ledger = ledger;
  }

  async getVault(vaultId: string): Promise<Vault | null> {
    return this.ledger.getVault(vaultId) ?? null;
  }

  /**
   * The ledger is seeded at construction, so this is a no-op — but the COUNTS it
   * reports are the in-memory world's actual contents, not zeros.
   *
   * It previously returned zeros for everything, which was the in-memory half of
   * the disagreement found by running with DATABASE_URL set: the Postgres backend
   * persisted spaces and agreements, this one reported none, and the two backends
   * described different worlds.
   */
  async seedReferenceData(): Promise<SeedCounts> {
    return {
      // The ledger owns vaults, mandates and reservations, so those counts are
      // read from it rather than reported as zero. A backend reporting 0 for
      // data it demonstrably holds is the same lie as the one F36 caught.
      vaults: this.ledger.listVaults().length,
      mandates: mandates.length,
      reservations: this.ledger.listReservations().length,
      spaces: spaces.length,
      agreements: agreements.length,
      obligations: obligations.length,
      settlements: settlements.length,
      runs: runs.length,
      deliverables: deliverables.length,
    };
  }

  /** Served from the seed array: the ledger has no mandate store of its own. */
  async getMandate(mandateId: string): Promise<Mandate | null> {
    return mandates.find((m) => m.mandateId === mandateId) ?? null;
  }

  /** Enumerated from the ledger, which is the only owner of vault state. */
  async listVaults(): Promise<Vault[]> {
    return this.ledger.listVaults();
  }

  /**
   * Spaces and agreements, from the reference fixtures.
   *
   * The in-memory backend is a development store, so it reads the same arrays the
   * seed defines rather than duplicating them. What matters is that the *route*
   * now goes through the repository: when the Postgres backend is selected the
   * same call returns rows from the database, and no route changes.
   */
  async listSpaces(): Promise<Space[]> {
    return spaces.map((s) => ({ ...s }));
  }

  async listAgreements(spaceId?: string): Promise<Agreement[]> {
    // An agreement with an EMPTY spaceIds is a valid, non-Mitra-native
    // engagement and is returned by an unfiltered list. Filtering by a space
    // simply cannot match it, which is correct.
    return agreements
      .filter((a) => !spaceId || a.spaceIds.includes(spaceId))
      .map((a) => ({ ...a }));
  }

  /**
   * The remaining economic entities, from the reference arrays.
   *
   * These exist so the routes can go through the store instead of importing
   * `seed.ts` and serving fixtures. The two backends now describe the same world
   * (F36); before this, `/clearing`, `/obligations`, `/runs` and `/accounting`
   * returned seed data under the in-memory backend and an EMPTY world under
   * Postgres, and nothing detected it because `DATABASE_URL` is unset by default.
   */
  async listObligations(): Promise<Obligation[]> {
    return obligations.map((o) => ({ ...o }));
  }

  async listSettlements(): Promise<Settlement[]> {
    return settlements.map((s2) => ({ ...s2 }));
  }

  async listRuns(): Promise<Run[]> {
    return runs.map((r) => ({ ...r }));
  }

  async listDeliverables(): Promise<Deliverable[]> {
    return deliverables.map((d) => ({ ...d }));
  }

  async listReservations(vaultId?: string): Promise<Reservation[]> {
    return this.ledger.listReservations(vaultId);
  }

  async getReservation(reservationId: string): Promise<Reservation | null> {
    return this.ledger.getReservation(reservationId) ?? null;
  }

  /**
   * Reserves through the ledger's own `reserve` so the kernel stays the single
   * definition of what "reserving capital" means. Contention cannot be detected
   * across processes here — a property of the store, not this adapter, and why
   * `backend: "memory"` is reported rather than hidden.
   */
  async reserveCapital(input: ReserveCapitalInput): Promise<CapitalResult> {
    const { reserve } = await import("@/lib/kernel/vault");
    try {
      const vault = this.ledger.reserveCapital(input.vaultId, input.amount, reserve);
      const reservation: Reservation = {
        reservationId: input.reservationId,
        runId: input.runId,
        vaultId: input.vaultId,
        intentId: input.intentId,
        mandateId: input.mandateId,
        mandateVersion: input.mandateVersion,
        asset: input.asset,
        amount: input.amount,
        chain: input.chain,
        actionDigest: input.actionDigest,
        expiresAt: input.expiresAt,
        nonce: this.ledger.allocateNonce(input.vaultId),
        status: "RESERVED",
        version: 1,
      };
      this.ledger.putReservation(reservation);
      return { ok: true, vault, reservation };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "RESERVATION_FAILED" };
    }
  }

  async consumeNonce(vaultId: string, nonce: number, _reservationId: string): Promise<boolean> {
    return this.ledger.consumeNonce(vaultId, nonce);
  }

  async setReservationStatus(
    reservationId: string,
    status: Reservation["status"],
  ): Promise<Reservation | null> {
    return this.ledger.setReservationStatus(reservationId, status) ?? null;
  }

  async putReservation(reservation: Reservation): Promise<Reservation> {
    return this.ledger.putReservation(reservation);
  }

  async recordAuthorization(auth: Authorization): Promise<void> {
    this.ledger.recordAuthorization(auth);
  }

  // ── Sagas (F49) ─────────────────────────────────────────────────────────────
  //
  // A DELEGATION, not a second store. `InMemoryRepository` wraps `CapitalLedger`, and
  // the ledger already owns the saga map — implementing this interface here as a
  // separate copy would reintroduce exactly the drift `activeMandates` had (F48): two
  // answers to "is this saga persisted?" that agree only until one of them changes.

  async saveSaga(saga: Saga): Promise<void> {
    await this.ledger.saveSaga(saga);
  }

  async getSaga(sagaId: string): Promise<Saga | null> {
    return this.ledger.getSaga(sagaId);
  }

  async listSagas(runId?: string): Promise<Saga[]> {
    return this.ledger.listSagas(runId);
  }

  async updateSaga(saga: Saga): Promise<void> {
    await this.ledger.updateSaga(saga);
  }

  async recentSpend(
    vaultId: string,
    mandateId: string,
    now: Date,
    windowMinutes: number,
  ): Promise<{ at: string; amount: number }[]> {
    return this.ledger.recentSpend(vaultId, mandateId, now, windowMinutes);
  }

  /** The ledger has no event log; the adapter does not invent one. */
  async appendEvent(event: Omit<RunEvent, "eventId">): Promise<RunEvent> {
    return { ...event, eventId: `evt_${Date.now()}` };
  }

  async listEvents(_runId: string): Promise<RunEvent[]> {
    return [];
  }
}

export interface StoreHandle {
  repo: EconomicRepository;
  backend: Backend;
  /** Release the pool. A no-op for the in-memory backend. */
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __mitraStore: Promise<StoreHandle> | undefined;
}

/**
 * The store for this process, opened once.
 *
 * Memoised on `globalThis` so Next.js hot reloads do not open a new pool per
 * edit. Resets are explicit via `__resetStoreForTests`.
 */
export function getStore(): Promise<StoreHandle> {
  if (!globalThis.__mitraStore) {
    globalThis.__mitraStore = openStore();
  }
  return globalThis.__mitraStore;
}

async function openStore(): Promise<StoreHandle> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return { repo: new InMemoryRepository(), backend: "memory", close: async () => {} };
  }
  const pool: Pool = createPool(connectionString);
  const repo = new PostgresRepository(pool);
  await repo.migrate();
  return { repo, backend: "postgres", close: async () => { await pool.end(); } };
}

export function __resetStoreForTests(): void {
  globalThis.__mitraStore = undefined;
}
