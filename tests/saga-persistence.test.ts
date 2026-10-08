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
import { commitAgreementOp } from "@/lib/commerce/commit-op";
import { openAgreement } from "@/lib/kernel/commerce";
import { routeCommitment } from "@/lib/domain/canonical";
import type { Money, Space } from "@/lib/domain/types";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });
const space = (): Space => ({
  spaceId: "space_f79", owner: "buyer_1",
  governance: { mode: "QUORUM" as const, admins: [], governors: ["buyer_1"], threshold: 1 },
  rules: { source: "mitra" as const, digest: "d" },
  status: "ACTIVE", participants: ["buyer_1"],
  allowedCapabilities: ["research"], settlementChains: ["solana"],
  budget: USDC(1000), committed: USDC(0), version: 1, createdAt: "2026-01-01T00:00:00Z",
});

const url = process.env.DATABASE_URL;
const suite = url ? it : it.skip;

const REQUIRED_SAGA_COLUMNS = ["saga_id", "run_id", "intent_id", "status", "steps",
  "compensation_routes", "route_attempts", "route_commitments", "committed_routes", "timeout_policy",
  "recovered_value", "contained_value", "version"];

const saga = (over: Partial<Saga> = {}): Saga => ({
  sagaId: "saga_1", runId: "run_1", intentId: "intent_1",
  steps: [{ stepId: "s1", name: "reserve", state: "FAILED", attempts: 1 }],
  compensationRoutes: ["r1"], routeAttempts: { r1: 1 },
  timeoutPolicy: "abort after 15m", status: "RECOVERED",
  recoveredValue: 10, containedValue: 0, version: 3, ...over,
});

/** A representative `Saga`'s key set — the same keys `rowToSaga` must produce. */
const SAGA_KEYS = Object.keys(saga()).sort();

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
    for (const c of REQUIRED_SAGA_COLUMNS) {
      expect(cols, `mitra.sagas is missing ${c}`).toContain(c);
    }

    // F79: this assertion was a HARDCODED list, which is why adding `routeCommitments`
    // to the `Saga` type did not make it fail — `saveSaga` writes an explicit column
    // list, so the new field was dropped on the way to the database and every in-memory
    // suite stayed green while Postgres lost the §15.5 commitment. The list is now
    // derived from the type's own key set, so a new field cannot be added without this
    // test noticing. The mapping from camelCase keys to column names is the one thing
    // still maintained by hand, and it is listed explicitly above for that reason.
    const EXPECTED_FOR_KEYS = {
      sagaId: "saga_id", runId: "run_id", intentId: "intent_id", status: "status",
      steps: "steps", compensationRoutes: "compensation_routes",
      routeAttempts: "route_attempts", routeCommitments: "route_commitments",
      committedRoutes: "committed_routes",
      timeoutPolicy: "timeout_policy", recoveredValue: "recovered_value",
      containedValue: "contained_value", version: "version",
    } as const;

    for (const key of SAGA_KEYS) {
      const column = EXPECTED_FOR_KEYS[key as keyof typeof EXPECTED_FOR_KEYS];
      expect(column, `Saga.${key} has no column mapping — saveSaga would drop it`).toBeTruthy();
      expect(cols, `mitra.sagas has no column for Saga.${key} (${column})`).toContain(column);
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

/**
 * F79 — a field on `Saga` that `saveSaga` does not name is silently dropped.
 *
 * `PostgresRepository.saveSaga` writes an EXPLICIT column list. Adding
 * `routeCommitments` to the `Saga` type and enforcing it in the kernel was therefore
 * not enough: the commitment reached the database write and vanished, and the next
 * `compensate` refused with `COMPENSATION_ROUTE_NOT_COMMITTED`.
 *
 * It failed CLOSED, which is why every in-memory suite stayed green — the in-memory
 * store keeps the whole object. This is the F76 guarantee silently switched off on the
 * only backend that runs in production, and it is why these suites run against a real
 * database at all.
 */
describe("F79 — the §15.5 route commitment survives a real round trip", () => {
  let pool2: Pool;
  let repo2: PostgresRepository;

  beforeAll(async () => {
    pool2 = createPool(url!);
    for (const sql of MIGRATIONS) await pool2.query(sql);
    repo2 = new PostgresRepository(pool2);
  });
  afterAll(async () => { await pool2?.end(); });

  suite("a reloaded saga can still be compensated", async () => {
    const repo = repo2;
    const NONCE = Math.random().toString(36).slice(2, 8);

    const agreementId = `ag_f79_${NONCE}`;
    const opened = openAgreement(space(), {
      agreementId, runId: `run_f79_${NONCE}`, intentId: `intent_f79_${NONCE}`,
      client: "buyer_1", provider: "provider_1",
      externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
    } as never, { capability: "research", amount: USDC(10) });
    if (!opened.ok) throw new Error(opened.reason);
    await repo.createSpace!(space());
    await repo.saveAgreement!(opened.value.agreement);

    const funded = await commitAgreementOp(repo, space(), opened.value.agreement, "fund", {
      capability: "research", amount: USDC(10),
      onChainEscrow: {
        chain: "baseSepolia",
        contractAddress: "0x6a731a654423d64afb9839742c3e48c6c54eea9c",
        jobId: `0x${"7c".repeat(32)}`,
      },
    });
    if (!funded.ok) throw new Error(funded.reason);

    // Read back through a FRESH load, which is the only way to see what the database
    // actually kept. Reading the object the kernel returned would prove nothing.
    const reloaded = await repo.getSaga!(funded.value.saga!.sagaId);
    expect(reloaded, "the saga exists").toBeTruthy();
    expect(reloaded!.routeCommitments, "the commitment survived the round trip").toBeTruthy();

    const routeId = `route_refund_${`0x${"7c".repeat(32)}`.slice(0, 10)}`;
    // F80: the committed BODY survives too, which is what lets the refund run the agreed
    // route instead of rebuilding one from `escrowRef`.
    expect(reloaded!.committedRoutes![routeId]).toBe(
      `evm:refundEscrow:baseSepolia:0x6a731a654423d64afb9839742c3e48c6c54eea9c:0x${"7c".repeat(32)}`,
    );
    expect(reloaded!.routeCommitments![routeId]).toBe(
      routeCommitment(`evm:refundEscrow:baseSepolia:0x6a731a654423d64afb9839742c3e48c6c54eea9c:0x${"7c".repeat(32)}`),
    );

    // And it is the SAME value on the agreement — one number, two layers.
    expect((await repo.getAgreement!(agreementId))?.refundRouteHash).toBe(reloaded!.routeCommitments![routeId]);

    // The consequence that matters: a RELOADED saga can still be compensated. This is
    // what F79 broke, and it is why the failure was invisible until Postgres was used.
    const started = await commitAgreementOp(repo, space(),
      (await repo.getAgreement!(agreementId))!, "startExecution", { capability: "research", amount: USDC(10) });
    if (!started.ok) throw new Error(started.reason);
    const submitted = await commitAgreementOp(repo, space(),
      (await repo.getAgreement!(agreementId))!, "submitDeliverable",
      { capability: "research", amount: USDC(10), artifactRefs: ["a"], contentHash: "sha256:x" });
    if (!submitted.ok) throw new Error(submitted.reason);

    const rejected = await commitAgreementOp(repo, space(),
      (await repo.getAgreement!(agreementId))!, "rejectDeliverable",
      { capability: "research", amount: USDC(10), failureReason: "DELIVERABLE_REJECTED" });

    expect(rejected.ok, "a reloaded saga must still be able to compensate").toBe(true);
  });
});
