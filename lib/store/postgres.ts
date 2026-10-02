import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transition } from "@/lib/kernel/machines";
import type {
  Agreement, Authorization, Deliverable, Mandate, Obligation, Reservation, Run, RunEvent,
  Settlement, Space, Vault,
} from "@/lib/domain/types";
import type { CapitalResult, EconomicRepository, ReserveCapitalInput, SeedCounts } from "./repository";

const num = (v: unknown): number => Number(v);

/** Extra terms the caller must supply that are not about capital itself. */
export type ReserveRequest = ReserveCapitalInput & {
  asset: Reservation["asset"]; chain: Reservation["chain"];
  mandateId: string; mandateVersion: number; actionDigest: string; expiresAt: string;
};

/**
 * PostgreSQL-backed economic state.
 *
 * The important method is `reserveCapital`. SECURITY.md invariant 13 says
 * concurrent intents must not consume the same available capital, and a
 * read-then-write would violate that under contention. This takes a row lock
 * then a single conditional UPDATE, so the database decides the winner and a
 * loser is told why rather than both succeeding.
 */
export class PostgresRepository implements EconomicRepository {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const { MIGRATIONS } = await import("./schema");
    for (const sql of MIGRATIONS) await this.pool.query(sql);
  }

  async getVault(vaultId: string): Promise<Vault | null> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.vaults WHERE vault_id = $1", [vaultId]);
    return rows[0] ? rowToVault(rows[0]) : null;
  }

  async getMandate(mandateId: string): Promise<Mandate | null> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.mandates WHERE mandate_id = $1", [mandateId]);
    return rows[0] ? rowToMandate(rows[0]) : null;
  }

  async getReservation(reservationId: string): Promise<Reservation | null> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.reservations WHERE reservation_id = $1", [reservationId]);
    return rows[0] ? rowToReservation(rows[0]) : null;
  }

  async listReservations(vaultId?: string): Promise<Reservation[]> {
    const { rows } = vaultId
      ? await this.pool.query("SELECT * FROM mitra.reservations WHERE vault_id = $1 ORDER BY created_at DESC", [vaultId])
      : await this.pool.query("SELECT * FROM mitra.reservations ORDER BY created_at DESC");
    return rows.map(rowToReservation);
  }

  /**
   * Vaults with their ACTIVE mandates and reservations attached.
   *
   * Two queries and a join in JS rather than a correlated subquery per row: the
   * derived fields are the same for every reader, and doing it here means
   * `rowToVault` stays a pure mapping with no hidden I/O.
   */
  async listVaults(): Promise<Vault[]> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.vaults ORDER BY vault_id");
    const mandates = await this.pool.query(
      "SELECT vault_id, mandate_id FROM mitra.mandates WHERE status = 'ACTIVE'",
    );
    const reservations = await this.pool.query(
      "SELECT vault_id, reservation_id FROM mitra.reservations WHERE status IN ('RESERVED','COMMITTED')",
    );
    const group = (rows2: Array<Record<string, unknown>>, id: string) => {
      const m = new Map<string, string[]>();
      for (const r of rows2) {
        const k = String(r.vault_id);
        m.set(k, [...(m.get(k) ?? []), String(r[id])]);
      }
      return m;
    };
    const byMandate = group(mandates.rows, "mandate_id");
    const byReservation = group(reservations.rows, "reservation_id");
    return rows.map((r) => {
      const v = rowToVault(r);
      return {
        ...v,
        activeMandates: byMandate.get(v.vaultId) ?? [],
        activeReservations: byReservation.get(v.vaultId) ?? [],
      };
    });
  }

  /**
   * Spaces and agreements.
   *
   * `document` holds the whole entity; the scalar columns exist to be indexed or
   * constrained, and the mapping prefers the document so a shape change does not
   * silently drop a field the column list does not know about.
   */
  async listObligations(): Promise<Obligation[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.obligations ORDER BY created_at DESC");
    return rows.map((r) => r.document as Obligation);
  }

  async listSettlements(): Promise<Settlement[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.settlements ORDER BY created_at DESC");
    return rows.map((r) => r.document as Settlement);
  }

  async listRuns(): Promise<Run[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.runs ORDER BY created_at DESC");
    return rows.map((r) => r.document as Run);
  }

  async listDeliverables(): Promise<Deliverable[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.deliverables ORDER BY created_at DESC");
    return rows.map((r) => r.document as Deliverable);
  }

  async listSpaces(): Promise<Space[]> {
    const { rows } = await this.pool.query(
      "SELECT document FROM mitra.spaces ORDER BY space_id",
    );
    return rows.map((r) => r.document as Space);
  }

  /**
   * Agreements, with their Space membership REHYDRATED from the join table.
   *
   * Membership is stored in `mitra.agreement_spaces` rather than in the
   * agreement row, so an agreement may join no Space (an external, non-Mitra-native
   * engagement), one, or several. The `document` therefore carries a `spaceIds` that
   * the DB does NOT maintain — writing it there would recreate the dual-source
   * problem F33 describes, so it is derived here and overwritten on read.
   */
  async listAgreements(spaceId?: string): Promise<Agreement[]> {
    const base = spaceId
      ? await this.pool.query(
          `SELECT a.document FROM mitra.agreements a
             JOIN mitra.agreement_spaces s ON s.agreement_id = a.agreement_id
            WHERE s.space_id = $1 ORDER BY a.created_at DESC`,
          [spaceId],
        )
      : await this.pool.query("SELECT document FROM mitra.agreements ORDER BY created_at DESC");

    const links = await this.pool.query(
      "SELECT agreement_id, space_id FROM mitra.agreement_spaces ORDER BY agreement_id, space_id",
    );
    const byAgreement = new Map<string, string[]>();
    for (const r of links.rows) {
      const id = String(r.agreement_id);
      byAgreement.set(id, [...(byAgreement.get(id) ?? []), String(r.space_id)]);
    }

    return base.rows.map((r) => ({
      ...(r.document as Agreement),
      spaceIds: byAgreement.get((r.document as Agreement).agreementId) ?? [],
    }));
  }

  /**
   * Reserve capital atomically under a row lock.
   *
   * `SELECT ... FOR UPDATE` serialises racers on this vault; the conditional
   * UPDATE is the final gate. Losing the race is an expected outcome, not an
   * error, so it returns a reason the caller maps to 409.
   */
  async reserveCapital(input: ReserveRequest): Promise<CapitalResult> {
    // Everything happens on ONE pooled connection. An earlier version read the
    // vault, committed, then queried again on a *different* connection, needing
    // 2 connections per racer. Ten concurrent intents exceeded the pool and
    // deadlocked. Holding a single client for the whole transaction keeps the
    // cost at exactly one connection per racer.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // `FOR UPDATE` is defence in depth, NOT the guarantee. Mutation audit
      // removed it and every test still passed, because the guarantee actually
      // comes from the conditional UPDATE below (`WHERE available >= $1`): under
      // READ COMMITTED a losing racer's UPDATE matches zero rows and it
      // rollbacks. The row lock reduces wasted work between racers; it is not what
      // makes SECURITY.md invariant 13 hold, and a comment claiming otherwise
      // would credit it with work it does not do.
      const { rows } = await client.query("SELECT * FROM mitra.vaults WHERE vault_id = $1 FOR UPDATE", [input.vaultId]);
      const vault = rows[0] ? rowToVault(rows[0]) : null;
      if (!vault) { await client.query("ROLLBACK"); return { ok: false, reason: `VAULT_NOT_FOUND: ${input.vaultId}` }; }
      if (vault.emergencyFreeze) { await client.query("ROLLBACK"); return { ok: false, reason: "VAULT_FROZEN" }; }

      const { rowCount } = await client.query(
        `UPDATE mitra.vaults
            SET available = available - $1, reserved = reserved + $1, version = version + 1
          WHERE vault_id = $2 AND available >= $1 AND emergency_freeze = FALSE`,
        [input.amount, input.vaultId],
      );
      if (rowCount !== 1) { await client.query("ROLLBACK"); return { ok: false, reason: "INSUFFICIENT_AVAILABLE_CAPITAL" }; }

      const nonce = await this.nextNonce(client, input.vaultId);
      const { rows: inserted } = await client.query(
        `INSERT INTO mitra.reservations
           (reservation_id, run_id, vault_id, intent_id, mandate_id, mandate_version,
            asset, amount, chain, action_digest, expires_at, nonce, status, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RESERVED',1)
         RETURNING *`,
        [input.reservationId, input.runId, input.vaultId, input.intentId, input.mandateId,
          input.mandateVersion, input.asset, input.amount, input.chain, input.actionDigest,
          input.expiresAt, nonce],
      );
      // Read the updated vault back on the same connection, inside the
      // transaction, so no second connection is needed while holding the lock.
      const { rows: vrows } = await client.query("SELECT * FROM mitra.vaults WHERE vault_id = $1", [input.vaultId]);
      await client.query("COMMIT");
      return { ok: true, vault: rowToVault(vrows[0]), reservation: rowToReservation(inserted[0]) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Lowest nonce on this vault not already reserved or consumed. */
  private async nextNonce(client: PoolClient, vaultId: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(nonce) + 1 FROM mitra.consumed_nonces WHERE vault_id = $1), 1),
         COALESCE((SELECT MAX(nonce) + 1 FROM mitra.reservations   WHERE vault_id = $1), 1)
       ) AS next`,
      [vaultId],
    );
    return num(rows[0]?.next ?? 1);
  }

  /**
   * Consume a nonce exactly once. The UNIQUE (vault_id, nonce) primary key is
   * the real enforcement, so replay protection survives a restart — which the
   * Phase 1 in-memory ledger could not promise.
   */
  async consumeNonce(vaultId: string, nonce: number, reservationId: string): Promise<boolean> {
    try {
      await this.pool.query(
        "INSERT INTO mitra.consumed_nonces (vault_id, nonce, reservation_id) VALUES ($1,$2,$3)",
        [vaultId, nonce, reservationId],
      );
      return true;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") return false;
      throw err;
    }
  }

  async setReservationStatus(reservationId: string, status: Reservation["status"]): Promise<Reservation | null> {
    const current = await this.getReservation(reservationId);
    if (!current) return null;
    // The state machine governs writes; the database is not the only gate.
    const next = { ...transition("reservation", current, status), version: current.version + 1 };
    await this.pool.query(
      "UPDATE mitra.reservations SET status = $1, version = $2 WHERE reservation_id = $3",
      [next.status, next.version, reservationId],
    );
    return next;
  }

  /**
   * Insert or replace a whole reservation row.
   *
   * A reservation is assembled from two sources: `reserveCapital` allocated the
   * nonce and moved the capital, while the route holds the terms that were
   * actually evaluated. The row is therefore written whole. An upsert rather
   * than a plain INSERT, because the in-memory adapter creates a placeholder row
   * before the route has the digest, and both backends must converge to the
   * same shape.
   */
  async putReservation(reservation: Reservation): Promise<Reservation> {
    await this.pool.query(
      `INSERT INTO mitra.reservations
         (reservation_id, run_id, vault_id, intent_id, mandate_id, mandate_version,
          asset, amount, chain, action_digest, expires_at, nonce, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (reservation_id) DO UPDATE SET
         run_id = EXCLUDED.run_id, vault_id = EXCLUDED.vault_id,
         intent_id = EXCLUDED.intent_id, mandate_id = EXCLUDED.mandate_id,
         mandate_version = EXCLUDED.mandate_version, asset = EXCLUDED.asset,
         amount = EXCLUDED.amount, chain = EXCLUDED.chain,
         action_digest = EXCLUDED.action_digest, expires_at = EXCLUDED.expires_at,
         nonce = EXCLUDED.nonce, status = EXCLUDED.status, version = EXCLUDED.version`,
      [reservation.reservationId, reservation.runId, reservation.vaultId, reservation.intentId,
        reservation.mandateId, reservation.mandateVersion, reservation.asset, reservation.amount,
        reservation.chain, reservation.actionDigest, reservation.expiresAt, reservation.nonce,
        reservation.status, reservation.version],
    );
    return reservation;
  }

  async seedReferenceData(): Promise<SeedCounts> {
    const { seedReferenceData } = await import("@/lib/store/seed-reference");
    return seedReferenceData(this.pool);
  }

  async recordAuthorization(auth: Authorization): Promise<void> {
    await this.pool.query(
      `INSERT INTO mitra.authorizations
         (authorization_id, run_id, intent_id, mandate_id, mandate_version, vault_id,
          decision, action_digest, asset, amount_ceiling, chain, expires_at, nonce,
          reason_codes, signer, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [auth.authorizationId, auth.runId, auth.intentId, auth.mandateId, auth.mandateVersion,
        auth.vaultId, auth.decision, auth.actionDigest, auth.asset, auth.amountCeiling,
        auth.chain, auth.expiresAt, auth.nonce, auth.reasonCodes, auth.signer, auth.version],
    );
  }

  /**
   * Spend inside the velocity window, derived from the database.
   *
   * Non-positive amounts are excluded: SECURITY.md invariant 11 treats these as
   * encumbrances, and a negative one would reduce the windowed sum and let a
   * request slip under the limit.
   */
  async recentSpend(vaultId: string, mandateId: string, now: Date, windowMinutes: number): Promise<{ at: string; amount: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT expires_at AS at, amount
         FROM mitra.reservations
        WHERE vault_id = $1 AND mandate_id = $2
          AND status IN ('SETTLED','COMMITTED')
          AND amount > 0
          AND expires_at > $3::timestamptz - ($4 || ' minutes')::interval
        ORDER BY expires_at ASC`,
      [vaultId, mandateId, now.toISOString(), String(windowMinutes)],
    );
    return rows.map((r) => ({ at: new Date(String(r.at)).toISOString(), amount: num(r.amount) }));
  }

  async appendEvent(event: Omit<RunEvent, "eventId">): Promise<RunEvent> {
    const full: RunEvent = { ...event, eventId: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}` };
    await this.pool.query(
      `INSERT INTO mitra.event_log
         (event_id, run_id, at, kind, title, description, status, receipt_id, object_ref, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [full.eventId, full.runId, full.at, full.kind, full.title, full.description,
        full.status, full.receiptId ?? null, full.objectRef ?? null, JSON.stringify(full.metadata)],
    );
    return full;
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.event_log WHERE run_id = $1 ORDER BY seq ASC", [runId]);
    return rows.map(rowToEvent);
  }
}

function rowToVault(r: Record<string, unknown>): Vault {
  return {
    vaultId: String(r.vault_id), name: String(r.name), principal: String(r.principal),
    controllerRef: String(r.controller_ref), chain: String(r.chain) as Vault["chain"],
    asset: String(r.asset) as Vault["asset"], address: String(r.address),
    total: num(r.total), available: num(r.available), reserved: num(r.reserved),
    escrowed: num(r.escrowed), encumbered: num(r.encumbered), settling: num(r.settling),
    frozen: num(r.frozen),
    // These are DERIVED, not stored: the active mandates and reservations for a
    // vault come from the tables that reference it.
    //
    // They were hardcoded to empty arrays, which the in-memory ledger does not
    // do — so a vault read from Postgres was missing two fields the domain type
    // declares, and nothing noticed because every test that inspected a vault read
    // it from whichever backend happened to be selected. Found by the backend
    // parity test, which is the only thing that compares the two.
    activeMandates: Array.isArray(r.active_mandates) ? (r.active_mandates as string[]).map(String) : [],
    activeReservations: Array.isArray(r.active_reservations) ? (r.active_reservations as string[]).map(String) : [],
    emergencyFreeze: Boolean(r.emergency_freeze),
    custodyMode: String(r.custody_mode) as Vault["custodyMode"], version: num(r.version),
  };
}

function rowToMandate(r: Record<string, unknown>): Mandate {
  return {
    mandateId: String(r.mandate_id), name: String(r.name), version: num(r.version),
    principal: String(r.principal), agentId: String(r.agent_id), vaultId: String(r.vault_id),
    asset: String(r.asset) as Mandate["asset"], budget: num(r.budget), maxTransaction: num(r.max_transaction),
    velocityLimit: r.velocity_amount ? { amount: num(r.velocity_amount), windowMinutes: num(r.velocity_window) } : undefined,
    allowedCounterparties: (r.allowed_counterparties as string[]) ?? [],
    allowedCapabilities: (r.allowed_capabilities as string[]) ?? [],
    prohibitedCapabilities: (r.prohibited_capabilities as string[]) ?? [],
    approvedChains: (r.approved_chains as Mandate["approvedChains"]) ?? [],
    policyVersion: String(r.policy_version),
    expiresAt: new Date(String(r.expires_at)).toISOString(), nonce: num(r.nonce),
    status: String(r.status) as Mandate["status"], confidentialPolicy: Boolean(r.confidential_policy),
  };
}

function rowToReservation(r: Record<string, unknown>): Reservation {
  return {
    reservationId: String(r.reservation_id), runId: String(r.run_id), vaultId: String(r.vault_id),
    intentId: String(r.intent_id), mandateId: String(r.mandate_id), mandateVersion: num(r.mandate_version),
    asset: String(r.asset) as Reservation["asset"], amount: num(r.amount),
    chain: String(r.chain) as Reservation["chain"], actionDigest: String(r.action_digest),
    expiresAt: new Date(String(r.expires_at)).toISOString(), nonce: num(r.nonce),
    status: String(r.status) as Reservation["status"], version: num(r.version),
  };
}

function rowToEvent(r: Record<string, unknown>): RunEvent {
  return {
    eventId: String(r.event_id), runId: String(r.run_id), at: new Date(String(r.at)).toISOString(),
    kind: String(r.kind) as RunEvent["kind"], title: String(r.title), description: String(r.description),
    status: String(r.status) as RunEvent["status"], receiptId: (r.receipt_id as string) ?? undefined,
    objectRef: (r.object_ref as string) ?? undefined,
    metadata: (r.metadata ?? {}) as Record<string, string | number | boolean>,
  };
}
