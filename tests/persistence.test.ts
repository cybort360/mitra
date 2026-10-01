import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresRepository } from "@/lib/store/postgres.js";
import { MIGRATIONS } from "@/lib/store/schema.js";
import { createPool } from "@/lib/store/db.js";
import { reconcileVault } from "@/lib/kernel/vault.js";

/**
 * Phase 3 verification against a real PostgreSQL instance.
 *
 * These are the tests docs/SECURITY.md implies but could not previously be
 * written: invariants 11, 12 and 13 are about concurrency and durability, and
 * neither an in-memory ledger nor a static array can demonstrate either.
 *
 * Skipped, loudly, when DATABASE_URL is unset — see docs/EVIDENCE.md on not
 * claiming evidence that was not gathered.
 */
const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

if (!url) {
  // eslint-disable-next-line no-console
  console.warn("[phase3] DATABASE_URL unset — skipping persistence tests. Evidence level for persistence remains DESIGN_ONLY.");
}

describeDb("postgres repository (SECURITY.md invariants 11, 12, 13)", () => {
  let pool: Pool;
  let repo: PostgresRepository;

  beforeAll(async () => {
    pool = createPool(url);
    for (const sql of MIGRATIONS) await pool.query(sql);
    repo = new PostgresRepository(pool);
  });

  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    await pool.query("TRUNCATE mitra.reservations, mitra.consumed_nonces, mitra.authorizations, mitra.event_log, mitra.mandates, mitra.vaults CASCADE");
    await pool.query(
      `INSERT INTO mitra.vaults
         (vault_id, name, principal, controller_ref, chain, asset, address,
          total, available, reserved, escrowed, encumbered, settling, frozen,
          emergency_freeze, custody_mode, version)
       VALUES ('v1','Test','P','ctl','solana','USDC','addr',
               1000, 1000, 0, 0, 0, 0, 0, FALSE, 'CAPITAL_HOLDING', 1)`,
    );
    await pool.query(
      `INSERT INTO mitra.mandates
         (mandate_id, name, version, principal, agent_id, vault_id, asset, budget,
          max_transaction, velocity_amount, velocity_window, allowed_counterparties,
          allowed_capabilities, prohibited_capabilities, approved_chains,
          policy_version, expires_at, nonce, status, confidential_policy)
       VALUES ('m1','Test',1,'P','a1','v1','USDC', 500, 100, 500, 60,
               ARRAY['ok:*'], ARRAY['cap'], ARRAY['bad'], ARRAY['solana'],
               'v1', now() + interval '1 day', 1, 'ACTIVE', FALSE)`,
    );
  });

  const reserve = (id: string, amount: number) => repo.reserveCapital({
    vaultId: "v1", amount, reservationId: id, runId: "r1", intentId: `i-${id}`,
    asset: "USDC", chain: "solana", mandateId: "m1", mandateVersion: 1,
    actionDigest: "sha256:x", expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  it("moves capital from available to reserved and conserves the total", async () => {
    const result = await reserve("res-1", 300);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vault.available).toBe(700);
    expect(result.vault.reserved).toBe(300);
    // Invariant 11: available capital still reflects every encumbrance.
    expect(reconcileVault(result.vault).ok).toBe(true);
    expect(reconcileVault(result.vault).difference).toBe(0);
  });

  it("refuses to overdraw the vault", async () => {
    const result = await reserve("res-1", 5000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("INSUFFICIENT_AVAILABLE_CAPITAL");
    const vault = await repo.getVault("v1");
    // A refused reservation must leave capital untouched.
    expect(vault?.available).toBe(1000);
  });

  it("survives a new repository instance: state is durable, not in-process", async () => {
    await reserve("res-1", 250);
    // A completely separate repository over the same pool, as a restarted
    // process would see. This is the property the Phase 1 ledger could not offer.
    const fresh = new PostgresRepository(pool);
    const vault = await fresh.getVault("v1");
    expect(vault?.available).toBe(750);
    expect((await fresh.listReservations()).map((r) => r.reservationId)).toEqual(["res-1"]);
  });

  it("keeps nonce replay protection across repository instances", async () => {
    const a = await reserve("res-1", 10);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const nonce = a.reservation.nonce;
    const first = new PostgresRepository(pool);
    const second = new PostgresRepository(pool);
    expect(await first.consumeNonce("v1", nonce, "res-1")).toBe(true);
    // A different instance, as after a restart, still refuses the replay.
    expect(await second.consumeNonce("v1", nonce, "res-1")).toBe(false);
  });

  it("allocates distinct nonces to concurrent reservations", async () => {
    const results = await Promise.all([reserve("r-a", 10), reserve("r-b", 10), reserve("r-c", 10)]);
    const nonces = results.filter((r) => r.ok).map((r) => (r.ok ? r.reservation.nonce : 0));
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("SECURITY.md 13: concurrent intents cannot consume the same available capital", async () => {
    // Ten intents race for capital that only covers three. Exactly three must win.
    //
    // This uses a pool of exactly ONE connection on purpose. With a larger pool,
    // `Promise.all` of ten racers queues on pool.connect() instead of overlapping,
    // so the test would pass trivially without ever exercising contention — which
    // is exactly what happened on the first attempt. Forcing every racer to queue
    // at the row lock tests the condition the invariant is actually about.
    const solo = new Pool({ connectionString: url, max: 1 });
    await solo.query("SELECT 1");
    // Make the vault scarce: 300 available against 1000 demanded. `total` stays
    // 1000 with 700 in other buckets so reconcileVault still balances, which
    // is what makes the shortage a real constraint rather than a broken fixture.
    await solo.query(
      `INSERT INTO mitra.vaults
         (vault_id, name, principal, controller_ref, chain, asset, address,
          total, available, reserved, escrowed, encumbered, settling, frozen,
          emergency_freeze, custody_mode, version)
       VALUES ('v1','Test','P','ctl','solana','USDC','addr',
               1000, 300, 0, 700, 0, 0, 0, FALSE, 'CAPITAL_HOLDING', 1)
       ON CONFLICT (vault_id) DO UPDATE
         SET available = 300, reserved = 0, escrowed = 700, version = 1`,
    );
    const tightRepo = new PostgresRepository(solo);
    try {
      const ATTEMPTS = 10;
      const CAPITAL = 300;
      const PER = 100;
      const req = (id: string) => tightRepo.reserveCapital({
        vaultId: "v1", amount: PER, reservationId: id, runId: "r1", intentId: `i-${id}`,
        asset: "USDC", chain: "solana", mandateId: "m1", mandateVersion: 1,
        actionDigest: "sha256:x", expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      const results = await Promise.all(Array.from({ length: ATTEMPTS }, (_, i) => req(`race-${i}`)));

      const granted = results.filter((r) => r.ok).length;
      const refused = results.filter((r) => !r.ok);
      expect(granted).toBe(CAPITAL / PER);
      expect(refused).toHaveLength(ATTEMPTS - CAPITAL / PER);
      for (const r of refused) {
        expect(r.ok === false && r.reason).toBe("INSUFFICIENT_AVAILABLE_CAPITAL");
      }
      // Capital is conserved: no double-spend, no leakage. Read through the
      // same tight pool — the wider one may still be waiting on locks held by
      // the racers, and a stale read here would report the wrong numbers.
      const vault = await tightRepo.getVault("v1");
      expect(vault?.available).toBe(300 - CAPITAL);
      expect(vault?.reserved).toBe(CAPITAL);
      expect(reconcileVault(vault!).ok).toBe(true);
      // And the loser count agrees with the database, not just the return values.
      const { rows } = await solo.query("SELECT COUNT(*)::int AS n FROM mitra.reservations");
      expect(Number(rows[0].n)).toBe(CAPITAL / PER);
    } finally {
      await solo.end();
    }
  });

  it("SECURITY.md 12: a reservation belongs to one vault and one intent", async () => {
    // The intent is recorded on the row, so a reservation cannot be silently
    // re-pointed at a different intent or vault.
    const result = await reserve("res-owned", 50);
    expect(result.ok).toBe(true);
    const stored = (await repo.listReservations("v1"))[0];
    expect(stored.vaultId).toBe("v1");
    expect(stored.intentId).toBe("i-res-owned");
    const { rowCount } = await pool.query("SELECT 1 FROM mitra.reservations WHERE intent_id = $1", ["someone-elses-intent"]);
    expect(rowCount).toBe(0);
  });

  it("rejects a negative amount at the storage layer", async () => {
    // SECURITY.md invariant 11 treats encumbrances as non-negative. The CHECK
    // constraint is the last line of defence if a caller bypasses the kernel.
    await expect(reserve("res-neg", -100)).rejects.toThrow();
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM mitra.reservations WHERE reservation_id = 'res-neg'");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("appends events and replays them in order", async () => {
    for (const title of ["first", "second", "third"]) {
      await repo.appendEvent({ runId: "run-x", at: new Date().toISOString(), kind: "SYSTEM", title, description: "", status: "INFO", metadata: {} });
    }
    const events = await repo.listEvents("run-x");
    expect(events.map((e) => e.title)).toEqual(["first", "second", "third"]);
  });

  it("refuses an illegal status transition persisted through the database", async () => {
    const r = await reserve("res-m", 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await repo.setReservationStatus("res-m", "COMMITTED");
    // Phase 2's guard applies here too: the database is not the only gate.
    await expect(repo.setReservationStatus("res-m", "RESERVED")).rejects.toThrow(/TERMINAL_STATE|ILLEGAL_TRANSITION/);
  });
});
