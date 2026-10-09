import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transition } from "@/lib/kernel/machines";
import type {
  Agent, ClearingEpoch,
  Agreement, Authorization, Deliverable, EvidenceRecord, Integration, Intent, Mandate, Obligation, Receipt, Reservation, Run, RunEvent,
  Saga, Settlement, Space, Vault,
} from "@/lib/domain/types";
import { evidence, integrations } from "@/lib/store/seed";
import { linkAndSign, type ReceiptDraft, type ReceiptSigner } from "@/lib/kernel/receipts";
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

  async getSettlement(settlementId: string): Promise<Settlement | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.settlements WHERE settlement_id = $1", [settlementId]);
    return rows[0] ? (rows[0].document as Settlement) : null;
  }

  /**
   * One statement, so the database decides between racers. The conflict branch
   * only fires over a FAILED row; over anything else it matches zero rows and the
   * claim is refused.
   */
  async claimSettlement(settlement: Settlement): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO mitra.settlements (settlement_id, chain, asset, amount, status, document)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (settlement_id) DO UPDATE SET
         chain = EXCLUDED.chain, asset = EXCLUDED.asset, amount = EXCLUDED.amount,
         status = EXCLUDED.status, document = EXCLUDED.document
       WHERE mitra.settlements.status = 'FAILED'`,
      [settlement.settlementId, settlement.chain, settlement.asset, settlement.amount,
        settlement.status, JSON.stringify(settlement)],
    );
    return rowCount === 1;
  }

  /**
   * Link and insert under a per-run advisory lock, on one connection. Without the
   * lock two appends could read the same latest receipt and both link to it; the
   * UNIQUE (run_id, seq) constraint would then refuse one, but as an error rather
   * than a queue.
   */
  async appendReceipt(draft: ReceiptDraft, signer?: ReceiptSigner): Promise<Receipt> {
    const run = draft.runId ?? "";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mitra.receipts:${run}`]);
      const existing = await client.query("SELECT document FROM mitra.receipts WHERE receipt_id = $1", [draft.receiptId]);
      if (existing.rows[0]) { await client.query("COMMIT"); return existing.rows[0].document as Receipt; }
      const last = await client.query(
        "SELECT seq, document FROM mitra.receipts WHERE run_id = $1 ORDER BY seq DESC LIMIT 1", [run],
      );
      const previous = last.rows[0] ? (last.rows[0].document as Receipt) : null;
      // Signed inside the transaction, under the run's advisory lock, so the signed
      // hash is the one that is stored and linked.
      const receipt = await linkAndSign(draft, previous, signer);
      await client.query(
        "INSERT INTO mitra.receipts (receipt_id, run_id, seq, document) VALUES ($1,$2,$3,$4::jsonb)",
        [receipt.receiptId, run, last.rows[0] ? num(last.rows[0].seq) + 1 : 1, JSON.stringify(receipt)],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getReceipt(receiptId: string): Promise<Receipt | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.receipts WHERE receipt_id = $1", [receiptId]);
    return rows[0] ? (rows[0].document as Receipt) : null;
  }

  async listReceipts(runId: string): Promise<Receipt[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.receipts WHERE run_id = $1 ORDER BY seq ASC", [runId]);
    return rows.map((r) => r.document as Receipt);
  }

  async updateSettlement(settlement: Settlement): Promise<void> {
    const { rowCount } = await this.pool.query(
      "UPDATE mitra.settlements SET status = $2, document = $3::jsonb WHERE settlement_id = $1",
      [settlement.settlementId, settlement.status, JSON.stringify(settlement)],
    );
    if (rowCount !== 1) throw new Error("SETTLEMENT_NOT_CLAIMED");
  }

  async listRuns(): Promise<Run[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.runs ORDER BY created_at DESC");
    return rows.map((r) => r.document as Run);
  }

  async listDeliverables(): Promise<Deliverable[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.deliverables ORDER BY created_at DESC");
    return rows.map((r) => r.document as Deliverable);
  }

  /**
   * F94: the writer `listDeliverables` was missing.
   *
   * Upsert on `deliverable_id` so a retried submission — same agreement, same content —
   * converges rather than failing on the primary key. A submission is not an event that can
   * legitimately happen twice, but a network retry is not a second submission.
   */
  async saveDeliverable(deliverable: Deliverable): Promise<void> {
    await this.pool.query(
      `INSERT INTO mitra.deliverables (deliverable_id, agreement_id, accepted, document)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (deliverable_id) DO UPDATE SET
         accepted = EXCLUDED.accepted,
         document = EXCLUDED.document`,
      [deliverable.deliverableId, deliverable.agreementId, deliverable.accepted, JSON.stringify(deliverable)],
    );
  }

  /**
   * Integration + evidence declarations (PRD §52 Phase 10).
   *
   * These are declarations ABOUT THIS REPOSITORY, not ledger state. There is no
   * table for them and there should not be: nothing writes them at runtime, and a
   * row here would imply an audit trail that does not exist. They are served from
   * the same reference module the in-memory backend uses, so the two backends
   * report identical content — which is what backend parity actually requires.
   *
   * The Postgres backend label on /evidence therefore tells you the ROWS would be
   * durable if anything wrote them. It does NOT tell you any claim was re-verified.
   */
  /**
   * Intent persistence (LP-1). Upsert on intent_id so retries converge.
   * The searchable fields are columns; everything else lives only in `data`.
   */
  async createIntent(intent: Intent): Promise<Intent> {
    const existing = await this.getIntent(intent.intentId);
    if (existing) {
      return existing;
    }
    await this.pool.query(
      `INSERT INTO mitra.intents (intent_id, principal, agent_id, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (intent_id) DO NOTHING`,
      [intent.intentId, intent.principal, intent.initiatingAgentId, JSON.stringify(intent)],
    );
    return intent;
  }

  async getIntent(id: string): Promise<Intent | null> {
    const { rows } = await this.pool.query("SELECT data FROM mitra.intents WHERE intent_id = $1", [id]);
    return rows[0] ? (rows[0].data as Intent) : null;
  }

  async listIntents(filter: { principal?: string; agentId?: string } = {}): Promise<Intent[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.principal) { params.push(filter.principal); clauses.push(`principal = $${params.length}`); }
    if (filter.agentId) { params.push(filter.agentId); clauses.push(`agent_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(`SELECT data FROM mitra.intents ${where} ORDER BY intent_id`, params);
    return rows.map((r) => r.data as Intent);
  }

  async listIntegrations(): Promise<Integration[]> {
    return integrations.map((i) => ({ ...i }));
  }

  async listEvidenceRecords(): Promise<EvidenceRecord[]> {
    return evidence.map((e) => ({ ...e }));
  }

  async listSpaces(): Promise<Space[]> {
    const { rows } = await this.pool.query(
      "SELECT document FROM mitra.spaces ORDER BY space_id",
    );
    return rows.map((r) => r.document as Space);
  }

  /**
   * Single-row reads and the write path for Spaces and agreements.
   *
   * These were missing. The interface marks them optional and the agreements route
   * guarded every write with `if (repo.saveAgreement)`, so on this backend an
   * agreement was opened, funded and accepted with a 2xx response while NOTHING was
   * written — the next request read the seed state back. Same class as F36: the
   * in-memory backend worked, so the suite was green whenever DATABASE_URL was unset.
   */
  async createSpace(space: Space): Promise<void> {
    await this.pool.query(
      `INSERT INTO mitra.spaces (space_id, owner, status, document)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (space_id) DO UPDATE
         SET document = $4::jsonb, status = $3, owner = $2`,
      [space.spaceId, space.owner, space.status, JSON.stringify(space)],
    );
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.spaces WHERE space_id = $1", [spaceId]);
    return rows[0] ? (rows[0].document as Space) : null;
  }

  async updateSpace(space: Space): Promise<void> {
    const { rowCount } = await this.pool.query(
      "UPDATE mitra.spaces SET owner = $2, status = $3, document = $4::jsonb WHERE space_id = $1",
      [space.spaceId, space.owner, space.status, JSON.stringify(space)],
    );
    if (rowCount !== 1) throw new Error(`SPACE_NOT_FOUND: ${space.spaceId}`);
  }

  async getAgreement(agreementId: string): Promise<Agreement | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.agreements WHERE agreement_id = $1", [agreementId]);
    if (!rows[0]) return null;
    const links = await this.pool.query(
      "SELECT space_id FROM mitra.agreement_spaces WHERE agreement_id = $1 ORDER BY space_id",
      [agreementId],
    );
    return { ...(rows[0].document as Agreement), spaceIds: links.rows.map((r) => String(r.space_id)) };
  }

  /** Insert-only: opening an agreement twice under one id is a conflict, not an update. */
  async saveAgreement(agreement: Agreement): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO mitra.agreements (agreement_id, status, document) VALUES ($1,$2,$3::jsonb)",
        [agreement.agreementId, agreement.status, JSON.stringify(withoutMembership(agreement))],
      );
      for (const sid of agreement.spaceIds) {
        await client.query(
          "INSERT INTO mitra.agreement_spaces (agreement_id, space_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [agreement.agreementId, sid],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Membership is not rewritten: no agreement op changes which Spaces it is in. */
  async updateAgreement(agreement: Agreement): Promise<void> {
    const { rowCount } = await this.pool.query(
      "UPDATE mitra.agreements SET status = $2, document = $3::jsonb WHERE agreement_id = $1",
      [agreement.agreementId, agreement.status, JSON.stringify(withoutMembership(agreement))],
    );
    if (rowCount !== 1) throw new Error(`AGREEMENT_NOT_FOUND: ${agreement.agreementId}`);
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
            asset, amount, chain, action_digest, expires_at, nonce, status, version, agreement_id, residual_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RESERVED',1,$13,$14)
         RETURNING *`,
        [input.reservationId, input.runId, input.vaultId, input.intentId, input.mandateId,
          input.mandateVersion, input.asset, input.amount, input.chain, input.actionDigest,
          input.expiresAt, nonce, input.agreementId ?? null, input.residualRef ?? null],
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

  /**
   * Settlement capital (backlog #2), each in one transaction on one connection with
   * the reservation and vault rows locked. The reservation's status is the gate: a
   * second `completeSettlement` finds it SETTLED and changes nothing. The vault's
   * `CHECK (… >= 0)` constraints are the backstop if anything ever under-reserved.
   */
  async beginSettlement(reservationId: string): Promise<Reservation | null> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM mitra.reservations WHERE reservation_id = $1 FOR UPDATE", [reservationId]);
      if (!rows[0]) return null;
      let r = rowToReservation(rows[0]);
      if (r.status !== "RESERVED" && r.status !== "COMMITTED") return null;
      if (r.status === "RESERVED") r = { ...transition("reservation", r, "COMMITTED"), version: r.version + 1 };
      r = { ...transition("reservation", r, "SETTLING"), version: r.version + 1 };
      const moved = await client.query(
        `UPDATE mitra.vaults SET reserved = reserved - $1, settling = settling + $1, version = version + 1
          WHERE vault_id = $2 AND reserved >= $1`,
        [r.amount, r.vaultId],
      );
      if (moved.rowCount !== 1) throw new Error("RESERVATION_EXCEEDS_RESERVED_CAPITAL");
      await client.query("UPDATE mitra.reservations SET status = $1, version = $2 WHERE reservation_id = $3", [r.status, r.version, reservationId]);
      return r;
    });
  }

  async completeSettlement(reservationId: string, paidAmount: number): Promise<boolean> {
    if (!(paidAmount > 0)) throw new Error("INVALID_PAID_AMOUNT");
    return this.inTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM mitra.reservations WHERE reservation_id = $1 FOR UPDATE", [reservationId]);
      if (!rows[0]) return false;
      const r = rowToReservation(rows[0]);
      if (r.status !== "SETTLING") return false;
      if (paidAmount > r.amount) throw new Error("PAID_EXCEEDS_RESERVATION");
      const moved = await client.query(
        `UPDATE mitra.vaults
            SET settling = settling - $1, total = total - $2, available = available + ($1 - $2), version = version + 1
          WHERE vault_id = $3 AND settling >= $1`,
        [r.amount, paidAmount, r.vaultId],
      );
      if (moved.rowCount !== 1) throw new Error("SETTLEMENT_EXCEEDS_SETTLING_CAPITAL");
      const next = { ...transition("reservation", r, "SETTLED"), version: r.version + 1 };
      await client.query("UPDATE mitra.reservations SET status = $1, version = $2 WHERE reservation_id = $3", [next.status, next.version, reservationId]);
      return true;
    });
  }

  private async inTransaction<T>(f: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await f(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
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
          asset, amount, chain, action_digest, expires_at, nonce, status, version, agreement_id, residual_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (reservation_id) DO UPDATE SET
         agreement_id = EXCLUDED.agreement_id, residual_ref = EXCLUDED.residual_ref,
         run_id = EXCLUDED.run_id, vault_id = EXCLUDED.vault_id,
         intent_id = EXCLUDED.intent_id, mandate_id = EXCLUDED.mandate_id,
         mandate_version = EXCLUDED.mandate_version, asset = EXCLUDED.asset,
         amount = EXCLUDED.amount, chain = EXCLUDED.chain,
         action_digest = EXCLUDED.action_digest, expires_at = EXCLUDED.expires_at,
         nonce = EXCLUDED.nonce, status = EXCLUDED.status, version = EXCLUDED.version`,
      [reservation.reservationId, reservation.runId, reservation.vaultId, reservation.intentId,
        reservation.mandateId, reservation.mandateVersion, reservation.asset, reservation.amount,
        reservation.chain, reservation.actionDigest, reservation.expiresAt, reservation.nonce,
        reservation.status, reservation.version, reservation.agreementId ?? null, reservation.residualRef ?? null],
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
          reason_codes, signer, version, recipient_constraint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [auth.authorizationId, auth.runId, auth.intentId, auth.mandateId, auth.mandateVersion,
        auth.vaultId, auth.decision, auth.actionDigest, auth.asset, auth.amountCeiling,
        auth.chain, auth.expiresAt, auth.nonce, auth.reasonCodes, auth.signer, auth.version,
        auth.recipientConstraint ?? null],
    );
  }

  async listAuthorizations(runId?: string): Promise<Authorization[]> {
    const { rows } = runId
      ? await this.pool.query("SELECT * FROM mitra.authorizations WHERE run_id = $1 ORDER BY created_at DESC", [runId])
      : await this.pool.query("SELECT * FROM mitra.authorizations ORDER BY created_at DESC");
    return rows.map((r): Authorization => ({
      authorizationId: String(r.authorization_id), runId: String(r.run_id ?? ""), intentId: String(r.intent_id ?? ""),
      mandateId: String(r.mandate_id), mandateVersion: num(r.mandate_version), vaultId: String(r.vault_id),
      decision: String(r.decision) as Authorization["decision"], actionDigest: String(r.action_digest),
      asset: String(r.asset) as Authorization["asset"], amountCeiling: num(r.amount_ceiling),
      ...(r.recipient_constraint != null ? { recipientConstraint: String(r.recipient_constraint) } : {}),
      chain: String(r.chain) as Authorization["chain"], expiresAt: new Date(String(r.expires_at)).toISOString(),
      nonce: num(r.nonce), reasonCodes: (r.reason_codes as string[]) ?? [], signer: String(r.signer), version: num(r.version),
    }));
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

  async listEventsSince(cursor: number, limit = 200): Promise<Array<{ seq: number; event: RunEvent }>> {
    const { rows } = await this.pool.query(
      "SELECT * FROM mitra.event_log WHERE seq > $1 ORDER BY seq ASC LIMIT $2", [cursor, limit],
    );
    return rows.map((r) => ({ seq: num(r.seq), event: rowToEvent(r) }));
  }

  async getEpoch(epochId: string): Promise<ClearingEpoch | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.clearing_epochs WHERE epoch_id = $1", [epochId]);
    return rows[0] ? (rows[0].document as ClearingEpoch) : null;
  }

  async listEpochs(): Promise<ClearingEpoch[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.clearing_epochs ORDER BY created_at DESC");
    return rows.map((r) => r.document as ClearingEpoch);
  }

  async insertEpoch(epoch: ClearingEpoch): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "INSERT INTO mitra.clearing_epochs (epoch_id, status, document) VALUES ($1,$2,$3::jsonb) ON CONFLICT (epoch_id) DO NOTHING",
      [epoch.epochId, epoch.status, JSON.stringify(epoch)],
    );
    return rowCount === 1;
  }

  async saveEpoch(epoch: ClearingEpoch): Promise<void> {
    await this.pool.query(
      `INSERT INTO mitra.clearing_epochs (epoch_id, status, document) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (epoch_id) DO UPDATE SET status = EXCLUDED.status, document = EXCLUDED.document`,
      [epoch.epochId, epoch.status, JSON.stringify(epoch)],
    );
  }

  async listAgents(): Promise<Agent[]> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.agents ORDER BY agent_id");
    return rows.map((r) => r.document as Agent);
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const { rows } = await this.pool.query("SELECT document FROM mitra.agents WHERE agent_id = $1", [agentId]);
    return rows[0] ? (rows[0].document as Agent) : null;
  }

  async insertAgent(agent: Agent): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO mitra.agents (agent_id, status, document) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agent.agentId, agent.status, JSON.stringify(agent)],
    );
    return rowCount === 1;
  }

  async listMandates(): Promise<Mandate[]> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.mandates ORDER BY mandate_id");
    return rows.map(rowToMandate);
  }
  // ── Sagas (F49) ─────────────────────────────────────────────────────────────

  /**
   * Upsert.
   *
   * The recovery kernel emits a NEW immutable Saga per transition rather than
   * mutating one, so a replayed event stream must converge rather than fail on a
   * duplicate key. `version` is carried in the payload but deliberately NOT used as a
   * WHERE clause on the upsert: an out-of-order replay would then leave the newer row
   * untouched silently, which is harder to notice than a conflict.
   */
  async saveSaga(saga: Saga): Promise<void> {
    await this.pool.query(
      `INSERT INTO mitra.sagas
         (saga_id, run_id, intent_id, status, recovered_value, contained_value,
          steps, compensation_routes, route_attempts, route_commitments, committed_routes,
          timeout_policy, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
       ON CONFLICT (saga_id) DO UPDATE SET
         status              = EXCLUDED.status,
         recovered_value     = EXCLUDED.recovered_value,
         contained_value     = EXCLUDED.contained_value,
         steps               = EXCLUDED.steps,
         compensation_routes = EXCLUDED.compensation_routes,
         -- F47: route_attempts is overwritten from the caller's copy, so a persisted
         -- spent attempt can never be resurrected by a stale write.
         route_attempts      = EXCLUDED.route_attempts,
         -- F79: without this the §15.5 commitment is dropped on every advance, so a
         -- saga that has moved once can no longer be compensated at all.
         route_commitments   = EXCLUDED.route_commitments,
         -- F80: same reason — the committed route bodies must survive every advance.
         committed_routes    = EXCLUDED.committed_routes,
         timeout_policy      = EXCLUDED.timeout_policy,
         version             = EXCLUDED.version`,
      [
        saga.sagaId, saga.runId, saga.intentId, saga.status,
        saga.recoveredValue, saga.containedValue,
        JSON.stringify(saga.steps), JSON.stringify(saga.compensationRoutes),
        JSON.stringify(saga.routeAttempts ?? {}),
        JSON.stringify(saga.routeCommitments ?? {}),
        JSON.stringify(saga.committedRoutes ?? {}),
        saga.timeoutPolicy, saga.version,
      ],
    );
  }

  async getSaga(sagaId: string): Promise<Saga | null> {
    const { rows } = await this.pool.query("SELECT * FROM mitra.sagas WHERE saga_id = $1", [sagaId]);
    return rows[0] ? rowToSaga(rows[0]) : null;
  }

  async listSagas(runId?: string): Promise<Saga[]> {
    const { rows } = runId
      ? await this.pool.query("SELECT * FROM mitra.sagas WHERE run_id = $1 ORDER BY saga_id", [runId])
      : await this.pool.query("SELECT * FROM mitra.sagas ORDER BY saga_id");
    return rows.map(rowToSaga);
  }

  async updateSaga(saga: Saga): Promise<void> {
    await this.saveSaga(saga);
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
    ...(r.agreement_id != null ? { agreementId: String(r.agreement_id) } : {}),
    ...(r.residual_ref != null ? { residualRef: String(r.residual_ref) } : {}),
  };
}

/** Membership lives in `mitra.agreement_spaces` only (F33); the document must not carry it. */
function withoutMembership(agreement: Agreement): Omit<Agreement, "spaceIds"> {
  const { spaceIds: _spaceIds, ...rest } = agreement;
  return rest;
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

/**
 * Row -> `Saga`.
 *
 * `route_attempts` defaults to `{}` rather than being optional on the type, so a row
 * written before F47 (or with the column absent) reads as "no attempts spent" instead
 * of `undefined` — which would make a replayed compensation look like a first
 * attempt.
 */
function rowToSaga(r: Record<string, unknown>): Saga {
  return {
    sagaId: String(r.saga_id),
    runId: String(r.run_id),
    intentId: String(r.intent_id),
    status: String(r.status) as Saga["status"],
    steps: (Array.isArray(r.steps) ? r.steps : []) as Saga["steps"],
    compensationRoutes: (Array.isArray(r.compensation_routes) ? r.compensation_routes : []) as string[],
    routeAttempts: (r.route_attempts && typeof r.route_attempts === "object" ? r.route_attempts : {}) as Record<string, number>,
    // F76: absent on rows written before the column existed, which is exactly the
    // "no commitment" case `compensate` refuses rather than waves through.
    routeCommitments: (r.route_commitments && typeof r.route_commitments === "object" ? r.route_commitments : {}) as Record<string, string>,
    committedRoutes: (r.committed_routes && typeof r.committed_routes === "object" ? r.committed_routes : {}) as Record<string, string>,
    timeoutPolicy: String(r.timeout_policy ?? ""),
    recoveredValue: Number(r.recovered_value ?? 0),
    containedValue: Number(r.contained_value ?? 0),
    version: Number(r.version ?? 1),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Single-writer leases.
//
// `pg_advisory_xact_lock` above guards one transaction. A worker lease is the other
// kind: it must be held across many transactions, for as long as a process lives,
// and released when that process dies without anyone running cleanup code.
// ═════════════════════════════════════════════════════════════════════════════

/** The webhook delivery worker's lease name. Namespaced like every other lock key. */
export const WEBHOOK_WORKER_LEASE = "mitra.webhook-worker";

/**
 * A held session-level advisory lock.
 *
 * **Session-level, not transaction-level, and that is the whole design.** A
 * transaction-scoped lock dies with its `COMMIT`; the worker holds one across a
 * whole delivery pass and then sleeps for `MITRA_WEBHOOK_POLL_MS` with nothing
 * open. Worse, a session lock is released by Postgres itself when the connection
 * drops — so a worker killed with `SIGKILL`, or one whose database connection
 * died, stops being the writer *without any code running*. A lease that has to be
 * cleaned up is a lease that is eventually leaked.
 *
 * The consequence is that holding this is not permanent: `held()` re-reads the
 * server's own answer rather than caching a local boolean, and a worker that finds
 * the lease gone re-acquires it (see `scripts/webhook-worker.ts`). A cached `true`
 * would keep a second worker draining forever while reporting that it was safe.
 */
export interface WorkerLease {
  readonly name: string;
  /** The server's current answer, not a remembered one. */
  held(): Promise<boolean>;
  /** Explicit release. Safe to call when not held; the process dying does the rest. */
  release(): Promise<void>;
}

/**
 * Try to become the single writer for `name`.
 *
 * Returns `null` when another session already holds it — which is not an error.
 * "Someone else is doing the work" is the correct, healthy answer, and the caller
 * decides whether to stand down (the worker) or to proceed anyway (a test).
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: a *blocking* acquisition in
 * the worker's startup path would hang a second worker forever with no message,
 * which looks like a hung deployment rather than a redundant one.
 *
 * The key is `hashtext(name)` — 32 bits, derived by the server, exactly as the
 * receipt lock above does. A collision between two different lease names would let
 * one stand the other down, and `hashtext` is a 32-bit hash, so that is possible in
 * principle; it is accepted here for the same reason it is accepted there, and the
 * names are few and fixed.
 */
export async function tryAcquireWorkerLease(pool: Pool, name: string): Promise<WorkerLease | null> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name]);
    acquired = rows[0]?.ok === true;
  } catch (err) {
    client.release();
    throw err;
  }
  if (!acquired) {
    client.release();
    return null;
  }
  let released = false;
  return {
    name,
    async held() {
      // `SELECT 1`, and the reasoning is the whole point:
      //
      // A session-level advisory lock can only be released by the session that took
      // it — explicitly, or by the session ENDING. So while this connection is
      // usable, the lock is held; there is no state in which the query succeeds and
      // the lock is gone. `held()` is therefore exactly "is my session still
      // there?", and a dead connection returns false rather than throwing so the
      // worker's re-acquire path is the ordinary one.
      //
      // The alternative — reading `pg_locks` — was written first and is wrong. It
      // needs the key's 64-bit split reproduced in SQL, and the halves are NOT the
      // obvious ones: `hashtext` returns a *signed* int4, which sign-extends into
      // the advisory key, so `pg_locks` holds the UNSIGNED 32-bit halves. Measured
      // on this server for `mitra.webhook-worker`, key -1748458786 is stored as
      // `classid=4294967295, objid=2546508510` — not `(key >> 16)` and
      // `(key & 65535)`. Mirroring that split is a second encoding of a Postgres
      // internal, and it is precisely the failure this repository keeps paying for
      // (`vaultPda` in TS against `find_program_address` in Rust).
      if (released) return false;
      try {
        await client.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => {});
      client.release();
    },
  };
}
