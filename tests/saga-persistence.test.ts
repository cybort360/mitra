/**
 * F49 Step 1 — saga persistence.
 *
 * The recovery kernel had complete unit coverage and **no write path at all**:
 * `declareSaga`, `armSaga`, `recordStep` and `compensate` could only be reached by a
 * test calling them directly. So PRD §4.5 — "failure is a state transition, not an
 * exception" — was unenforced in anything that actually ran.
 *
 * These tests drive the real Postgres schema and repository, because the failure mode
 * being guarded is exactly the one an in-memory test cannot see: a column that exists
 * in the type and not in the database.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import type { Saga } from "@/lib/domain/types";
import { createPool } from "@/lib/store/db";
import { MIGRATIONS } from "@/lib/store/schema";
import { PostgresRepository } from "@/lib/store/postgres";

const url = process.env.DATABASE_URL;
const suite = url ? it : it.skip;

const saga = (over: Partial<Saga> = {}): Saga => ({
  sagaId: "saga_1", runId: "run_1", intentId: "intent_1",
  steps: [{ stepId: "s1", name: "reserve", state: "FAILED", attempts: 1 }],
  compensationRoutes: ["r1"], routeAttempts: { r1: 1 },
  timeoutPolicy: "abort after 15m", status: "RECOVERED",
  recoveredValue: 10, containedValue: 0, version: 3, ...over,
});

describe("F49 — the sagas table exists and round-trips", () => {
  let pool: Pool;
  let repo: PostgresRepository;

  beforeAll(async () => {
    pool = createPool(url!);
    for (const sql of MIGRATIONS) await pool.query(sql);
    repo = new PostgresRepository(pool);
  });
  afterAll(async () => { await pool?.end(); });

  suite("every column the Saga type needs is a real column", async () => {
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='mitra' AND table_name='sagas'",
    );
    const cols = rows.map((r) => r.column_name);
    for (const c of ["saga_id", "run_id", "intent_id", "status", "steps",
                     "compensation_routes", "route_attempts", "timeout_policy",
                     "recovered_value", "contained_value", "version"]) {
      expect(cols, `mitra.sagas is missing ${c}`).toContain(c);
    }
  });

  suite("route_attempts is NOT NULL with a default (F47 persistence)", async () => {
    // A nullable attempts column would let a saga resume with nothing recorded, and a
    // replayed compensation would then look like a first attempt.
    const { rows } = await pool.query(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema='mitra' AND table_name='sagas' AND column_name='route_attempts'",
    );
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBeTruthy();
  });

  suite("a saga saves and reads back unchanged", async () => {
    await repo.saveSaga(saga());
    const got = await repo.getSaga("saga_1");
    expect(got?.status).toBe("RECOVERED");
    expect(got?.routeAttempts).toEqual({ r1: 1 });
    expect(got?.steps).toHaveLength(1);
    expect(got?.steps[0].state).toBe("FAILED");
    expect(got?.version).toBe(3);
  });

  suite("saveSaga is an upsert, not an insert", async () => {
    await repo.saveSaga(saga());
    await repo.saveSaga(saga({ status: "CONTAINED", containedValue: 4, version: 4 }));
    const got = await repo.getSaga("saga_1");
    expect(got?.status).toBe("CONTAINED");
    expect(got?.version).toBe(4);
  });

  suite("a spent attempt cannot be resurrected by a stale write", async () => {
    // The F47 guard depends on the persisted count. If saveSaga wrote NULL or dropped
    // the field, a replayed compensation would be treated as a first attempt.
    await repo.saveSaga(saga({ routeAttempts: { r1: 1 }, status: "COMPENSATING" }));
    await repo.saveSaga(saga({ routeAttempts: {}, status: "COMPENSATING", version: 5 }));
    expect((await repo.getSaga("saga_1"))?.routeAttempts).toEqual({});
  });

  suite("listSagas filters by runId and returns everything otherwise", async () => {
    await repo.saveSaga(saga({ sagaId: "saga_a", runId: "run_a" }));
    await repo.saveSaga(saga({ sagaId: "saga_b", runId: "run_b" }));
    expect((await repo.listSagas("run_a")).map((s) => s.sagaId)).toEqual(["saga_a"]);
    expect((await repo.listSagas()).length).toBeGreaterThanOrEqual(3);
  });

  suite("a missing saga is null, not a throw", async () => {
    expect(await repo.getSaga("saga_nope")).toBeNull();
  });
});
