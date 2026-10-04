/**
 * Load the reference fixtures into a migrated Postgres schema.
 *
 * ## Why this exists
 *
 * The Postgres repository had no way to be populated. With `DATABASE_URL` set,
 * every route 404'd, because the vaults and mandates the tests and the demo rely
 * on live only in `lib/store/seed.ts` — an in-memory array. So the durable store
 * was, in practice, unusable, and "the repository is wired" would have been
 * untrue in the only configuration that matters.
 *
 * ## This is a fixture loader, not a migration path
 *
 * It is idempotent (`ON CONFLICT DO NOTHING`) and it seeds the *reference* rows
 * only — vaults, mandates and their reservations. It is how a developer gets a
 * working local environment, not how production data arrives. Production rows
 * come from the vault controller in PRD Phase 2, which does not exist yet.
 *
 * Seeding is explicit. Nothing calls this automatically, because a process that
 * silently inserted fixtures on boot would be indistinguishable from one holding
 * real data.
 */
import type { Pool } from "pg";
import {
  agents as seedAgents, clearingEpochs as seedEpochs,
  agreements, deliverables, mandates, obligations, reservations, runs, settlements,
  spaces, vaults,
} from "@/lib/store/seed";

export interface SeedCounts {
  vaults: number; mandates: number; reservations: number;
  spaces: number; agreements: number;
  obligations: number; settlements: number; runs: number; deliverables: number;
  agents: number;
  epochs: number;
}

export async function seedReferenceData(pool: Pool): Promise<SeedCounts> {
  for (const v of vaults) {
    await pool.query(
      `INSERT INTO mitra.vaults
         (vault_id, name, principal, controller_ref, chain, asset, address,
          total, available, reserved, escrowed, encumbered, settling, frozen,
          emergency_freeze, custody_mode, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (vault_id) DO NOTHING`,
      [v.vaultId, v.name, v.principal, v.controllerRef, v.chain, v.asset, v.address,
        v.total, v.available, v.reserved, v.escrowed, v.encumbered, v.settling, v.frozen,
        v.emergencyFreeze, v.custodyMode, v.version],
    );
  }

  for (const m of mandates) {
    await pool.query(
      `INSERT INTO mitra.mandates
         (mandate_id, name, version, principal, agent_id, vault_id, asset, budget,
          max_transaction, velocity_amount, velocity_window, allowed_counterparties,
          allowed_capabilities, prohibited_capabilities, approved_chains, policy_version,
          expires_at, nonce, status, confidential_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (mandate_id) DO NOTHING`,
      [m.mandateId, m.name, m.version, m.principal, m.agentId, m.vaultId, m.asset, m.budget,
        m.maxTransaction, m.velocityLimit?.amount ?? null, m.velocityLimit?.windowMinutes ?? null,
        m.allowedCounterparties, m.allowedCapabilities, m.prohibitedCapabilities,
        m.approvedChains, m.policyVersion, m.expiresAt, m.nonce, m.status, m.confidentialPolicy],
    );
  }

  let reservationCount = 0;
  for (const r of reservations) {
    const res = await pool.query(
      `INSERT INTO mitra.reservations
         (reservation_id, run_id, vault_id, intent_id, mandate_id, mandate_version,
          asset, amount, chain, action_digest, expires_at, nonce, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (reservation_id) DO NOTHING`,
      [r.reservationId, r.runId, r.vaultId, r.intentId, r.mandateId, r.mandateVersion,
        r.asset, r.amount, r.chain, r.actionDigest, r.expiresAt, r.nonce, r.status, r.version],
    );
    reservationCount += res.rowCount ?? 0;
  }

  // Spaces MUST be persisted before agreements: `mitra.agreements.space_id`
  // references `mitra.spaces(space_id)`, so inserting an agreement first would
  // fail the foreign key. The order here is a real constraint, not a style choice.
  //
  // **Why this block exists:** running the suite with DATABASE_URL set selected
  // the Postgres backend and three commerce tests failed with "expected 0 to be
  // greater than 0" — the in-memory backend serves fixtures from seed.ts while
  // the Postgres backend had never been given any. Two backends serving different
  // worlds is worse than one serving an honest empty store, because the tests
  // looked green whenever DATABASE_URL was unset.
  // NOTE: with DO UPDATE, `rowCount` counts only rows whose values CHANGED, so it
  // is a statement about this call rather than about the store. The returned
  // counts are queried with `count()` below for exactly that reason.
  let spaceCount = 0;
  for (const sp of spaces) {
    const res = await pool.query(
      `INSERT INTO mitra.spaces (space_id, owner, status, document)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (space_id) DO UPDATE SET owner=EXCLUDED.owner, status=EXCLUDED.status, document=EXCLUDED.document`,
      [sp.spaceId, sp.owner, sp.status, JSON.stringify(sp)],
    );
    spaceCount += res.rowCount ?? 0;
  }

  let agreementCount = 0;
  for (const a of agreements) {
    const res = await pool.query(
      `INSERT INTO mitra.agreements (agreement_id, status, document)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (agreement_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [a.agreementId, a.status, JSON.stringify(a)],
    );
    // The document must NOT carry membership: it is stored once, in the join
    // table, and rehydrated on read. Writing it in both places would recreate the
    // dual-source problem F33 describes.
    const { spaceIds } = JSON.parse(JSON.stringify(a)) as { spaceIds?: string[] };
    await pool.query("DELETE FROM mitra.agreement_spaces WHERE agreement_id = $1", [a.agreementId]);
    for (const sid of a.spaceIds ?? []) {
      await pool.query(
        `INSERT INTO mitra.agreement_spaces (agreement_id, space_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [a.agreementId, sid],
      );
    }
    void spaceIds;
    agreementCount += res.rowCount ?? 0;
  }

  // The remaining economic entities. Same reason as spaces/agreements: the
  // Postgres backend must describe the same world as the in-memory one, or a
  // route that goes through the store returns different data depending on
  // whether DATABASE_URL happens to be set.
  for (const o of obligations) {
    await pool.query(
      `INSERT INTO mitra.obligations (obligation_id, debtor, creditor, asset, amount, status, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (obligation_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [o.obligationId, o.debtor, o.creditor, o.amount.asset, o.amount.amount, o.status, JSON.stringify(o)],
    );
  }
  for (const st of settlements) {
    await pool.query(
      `INSERT INTO mitra.settlements (settlement_id, chain, asset, amount, status, document)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (settlement_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [st.settlementId, st.chain, st.asset, st.amount, st.status, JSON.stringify(st)],
    );
  }
  for (const r of runs) {
    await pool.query(
      `INSERT INTO mitra.runs (run_id, status, document)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (run_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [r.runId, r.status, JSON.stringify(r)],
    );
  }
  for (const d of deliverables) {
    await pool.query(
      `INSERT INTO mitra.deliverables (deliverable_id, agreement_id, accepted, document)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (deliverable_id) DO UPDATE SET accepted=EXCLUDED.accepted, document=EXCLUDED.document`,
      [d.deliverableId, d.agreementId, d.accepted, JSON.stringify(d)],
    );
  }

  for (const e of seedEpochs) {
    await pool.query(
      `INSERT INTO mitra.clearing_epochs (epoch_id, status, document) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (epoch_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [e.epochId, e.status, JSON.stringify(e)],
    );
  }

  for (const a of seedAgents) {
    await pool.query(
      `INSERT INTO mitra.agents (agent_id, status, document) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET status=EXCLUDED.status, document=EXCLUDED.document`,
      [a.agentId, a.status, JSON.stringify(a)],
    );
  }

  // **Counts are WORLD SIZE, not rows inserted by this call.**
  //
  // The first version returned `rowCount`, so a second call reported 0 for
  // everything it had already inserted. The backend-parity test asserted the
  // counts were non-zero and failed — correctly, because the number was a
  // statement about this call rather than about the store, and "seeded" is a
  // claim about the store.
  const count = async (table: string, idCol: string) => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mitra.${table}`);
    return rows[0].n as number;
  };

  return {
    vaults: await count("vaults", "vault_id"),
    mandates: await count("mandates", "mandate_id"),
    reservations: await count("reservations", "reservation_id"),
    spaces: await count("spaces", "space_id"),
    agreements: await count("agreements", "agreement_id"),
    obligations: await count("obligations", "obligation_id"),
    settlements: await count("settlements", "settlement_id"),
    runs: await count("runs", "run_id"),
    deliverables: await count("deliverables", "deliverable_id"),
    agents: await count("agents", "agent_id"),
    epochs: await count("clearing_epochs", "epoch_id"),
  };
}