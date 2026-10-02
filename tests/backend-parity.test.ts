/**
 * The two store backends must describe the SAME world.
 *
 * This test exists because of F36, and it is the test that would have caught it.
 *
 * The failure it prevents: `/clearing`, `/obligations`, `/runs` and `/accounting`
 * served `seed.ts` fixtures directly, so they looked correct under the in-memory
 * backend and returned an empty world under Postgres. `DATABASE_URL` is unset by
 * default, so the suite was green in the default configuration and broken in the
 * configured one — and nothing detected the disagreement.
 *
 * **Mutation audit proved the claim was false.** After "fixing" F36 by adding
 * repository methods, making `InMemoryRepository.listObligations` return `[]`
 * broke **zero** tests. The methods existed and both backends compiled, but nothing
 * asserted they agreed — so the defect could return at any time by editing one
 * line in one file.
 *
 * This is the assertion that closes that door.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MIGRATIONS } from "@/lib/store/schema";
import { PostgresRepository } from "@/lib/store/postgres";
import { InMemoryRepository } from "@/lib/store/provider";
import { createPool } from "@/lib/store/db";
import { vaults as seedVaults } from "@/lib/store/seed";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("backend parity — in-memory and postgres describe the same world", () => {
  let pool: Pool;
  let pg: PostgresRepository;
  let mem: InMemoryRepository;

  beforeAll(async () => {
    pool = createPool(url);
    for (const sql of MIGRATIONS) await pool.query(sql);
    pg = new PostgresRepository(pool);
    mem = new InMemoryRepository();
    // TRUNCATE before seeding. Without it this file compares a database other
    // suites have already written to against a FRESH in-memory ledger, and the
    // derived-field assertion fails on reservations another test created. That is
    // shared-database pollution, not a backend divergence - and the previous
    // failure of exactly that kind is how a real divergence would be missed.
    await pool.query(
      "TRUNCATE mitra.agreement_spaces, mitra.consumed_nonces, mitra.reservations, " +
      "mitra.authorizations, mitra.event_log, mitra.mandates, mitra.vaults, " +
      "mitra.agreements, mitra.spaces, mitra.obligations, mitra.settlements, " +
      "mitra.runs, mitra.deliverables CASCADE",
    );
    await pg.seedReferenceData();
  });
  afterAll(async () => { await pool?.end(); });

  /**
   * Canonical form: object keys sorted recursively.
   *
   * `JSON.stringify` is WRONG for this comparison and the first version used it.
   * PostgreSQL's JSONB does not preserve key order — it reorders by length then
   * value — so two objects holding identical data serialise to different strings
   * and every parity check fails. The comparison reported a divergence that did
   * not exist, which is worse than no comparison at all: it would have trained
   * everyone to ignore the alarm.
   */
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
  };

  // Vaults are MUTABLE state: the persistence tests reserve capital against them,
  // so by the time this file runs the Postgres balances have moved and the
  // in-memory ledger is fresh. Comparing full vault records therefore compares a
  // mutated database against an unmutated one and always fails.
  //
  // The honest assertion for mutable state is IDENTITY - the same set of vaults
  // exists in both - not equal contents. Reference data (everything below) is
  // immutable and IS compared in full.
  it("both backends hold the same VAULTS (identity, not mutable balances)", async () => {
    const a = (await pg.listVaults()).map((v) => v.vaultId).sort();
    const b = (await mem.listVaults()).map((v) => v.vaultId).sort();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("derived vault fields match, even though balances legitimately differ", async () => {
    // `activeMandates` and `activeReservations` are DERIVED from reference data,
    // not mutable balance state, so they must agree across backends.
    //
    // They were hardcoded to `[]` in `rowToVault` — a Vault missing two fields the
    // domain type declares — and no test caught it because every vault assertion
    // read from whichever backend was selected. Narrowing the vault comparison to
    // identity removed the last coverage, so this assertion exists to keep the
    // derived fields honest while balances are free to diverge.
    const pgv = await pg.listVaults();
    const memv = await mem.listVaults();
    for (const v of pgv) {
      const m = memv.find((x) => x.vaultId === v.vaultId);
      expect(m, `vault ${v.vaultId} missing in memory`).toBeTruthy();
      expect(v.activeMandates.slice().sort(), `${v.vaultId} activeMandates`)
        .toEqual(m!.activeMandates.slice().sort());
      expect(v.activeReservations.slice().sort(), `${v.vaultId} activeReservations`)
        .toEqual(m!.activeReservations.slice().sort());
    }
  });

  it("at least one vault actually HAS derived entries, so the check above is not vacuous", () => {
    // The derived-fields comparison passes trivially if both sides are empty.
    // Asserting non-emptiness here is what stops it from being decoration.
    expect(
      seedVaults.some((v) => v.activeMandates.length > 0 || v.activeReservations.length > 0),
      "the seed vaults have no derived entries at all",
    ).toBe(true);
  });

  const entities = [
    ["spaces", () => pg.listSpaces(), () => mem.listSpaces()],
    ["agreements", () => pg.listAgreements(), () => mem.listAgreements()],
    ["obligations", () => pg.listObligations(), () => mem.listObligations()],
    ["settlements", () => pg.listSettlements(), () => mem.listSettlements()],
    ["runs", () => pg.listRuns(), () => mem.listRuns()],
    ["deliverables", () => pg.listDeliverables(), () => mem.listDeliverables()],
  ] as const;

  for (const [name, fromPg, fromMem] of entities) {
    it(`both backends expose the same ${name}`, async () => {
      // Not just "both are non-empty" — that would pass when they disagree about
      // WHICH rows, which is the failure mode that matters.
      const a = (await fromPg()).map(canonical).sort();
      const b = (await fromMem()).map(canonical).sort();
      expect(a.length, `${name}: postgres returned nothing`).toBeGreaterThan(0);
      expect(b.length, `${name}: in-memory returned nothing`).toBeGreaterThan(0);
      expect(a, `${name}: the two backends disagree`).toEqual(b);
    });
  }

  it("every entity an agreement references actually exists in both backends", async () => {
    // A dangling reference passes every structural check while making the
    // commerce graph unusable.
    for (const repo of [pg, mem]) {
      const agreements = await repo.listAgreements();
      const spaces = new Set((await repo.listSpaces()).map((s) => s.spaceId));
      for (const a of agreements) {
        // An agreement may legitimately join NO Space (an external, non-Mitra-native
        // engagement), so only the ids it DOES name are checked.
        for (const sid of a.spaceIds) {
          expect(spaces.has(sid), `${a.agreementId} -> ${sid}`).toBe(true);
        }
      }
    }
  });

  it("seed counts are non-zero on both, so 'seeded' means something", async () => {
    const a = await pg.seedReferenceData();
    const b = await mem.seedReferenceData();
    expect((a as { obligations?: number }).obligations ?? 0, "pg obligations count").toBeGreaterThan(0);
    expect((b as { obligations?: number }).obligations ?? 0, "mem obligations count").toBeGreaterThan(0);
    expect(a.spaces).toBeGreaterThan(0);
    expect(b.spaces).toBeGreaterThan(0);
  });
});
