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
import { reservations, vaults, mandates } from "@/lib/store/seed";

export async function seedReferenceData(pool: Pool): Promise<{ vaults: number; mandates: number; reservations: number }> {
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

  return { vaults: vaults.length, mandates: mandates.length, reservations: reservationCount };
}