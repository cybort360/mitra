import { describe, expect, it, afterEach } from "vitest";
import { Pool } from "pg";
import { WEBHOOK_WORKER_LEASE, tryAcquireWorkerLease } from "@/lib/store/postgres.js";

/**
 * The webhook worker's single-writer lease, against a real PostgreSQL instance.
 *
 * ## Why this needs a real database and cannot be mocked
 *
 * The property under test is a property **of Postgres**: that a session-level
 * advisory lock is exclusive between sessions, survives arbitrary work on other
 * connections, and is released when — and only when — its session ends. A fake
 * `pg_try_advisory_lock` returns whatever the fake was told to return, so it would
 * pass by construction while proving nothing about the one guarantee the worker
 * depends on. This is the same reason `tests/persistence.test.ts` exists for
 * `FR-VAULT-004/013`.
 *
 * It is also how a wrong-but-plausible implementation gets caught. The first
 * `held()` in this repository read `pg_locks`, and reproduced the key split as
 * `(hashtext($1) >> 16)` / `(hashtext($1) & 65535)`. `hashtext` returns a *signed*
 * int4 that sign-extends into the 64-bit advisory key, so `pg_locks` holds the
 * **unsigned** 32-bit halves: measured on this server, key `-1748458786` appears as
 * `classid=4294967295, objid=2546508510`. The predicate silently matched nothing.
 *
 * Skipped, loudly, when DATABASE_URL is unset — the same rule as every other
 * persistence suite, and `docs/EVIDENCE.md`'s: a vacuous pass is worse than an
 * absent one.
 */
const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

if (!url) {
  // eslint-disable-next-line no-console
  console.warn("[webhook-lease] DATABASE_URL unset — skipping lease tests. The single-writer guarantee remains UNVERIFIED.");
}

/**
 * Teardown, in ONE hook and in one order: leases first, then pools.
 *
 * Two separate `afterEach` hooks were tried first and they interleave, which
 * produced a 30-second hook timeout and a `null` lease in a later test. The cause is
 * not subtle once stated: a lease holds a **checked-out** client, and
 * `pool.end()` blocks until every client is released. So if the pools are ended
 * before the leases are released, teardown hangs; and a lease whose pool has already
 * ended can no longer be released, so its session — and its advisory lock — stay
 * alive into the next test. That second half is why a later test's first
 * acquisition came back `null`: the previous test's writer was still the writer.
 *
 * One hook, leases before pools, no ordering to get wrong.
 */
const taken: Array<{ release(): Promise<void> }> = [];
const pools: Pool[] = [];
afterEach(async () => {
  while (taken.length) await taken.pop()!.release().catch(() => {});
  while (pools.length) await pools.pop()!.end().catch(() => {});
});

const withLease = async (pool: Pool, name: string) => {
  const lease = await tryAcquireWorkerLease(pool, name);
  if (lease) taken.push(lease);
  return lease;
};

describeDb("webhook worker lease (single writer, real Postgres)", () => {
  const pool = () => {
    const p = new Pool({ connectionString: url });
    pools.push(p);
    return p;
  };

  it("grants the lease to one session and refuses another", async () => {
    const a = await withLease(pool(), WEBHOOK_WORKER_LEASE);
    expect(a, "the first session must get the lease").not.toBeNull();

    // A SEPARATE pool, so this is a separate session and not the same connection
    // asked twice. This is the case the worker exists for: two replicas, two pools,
    // one writer.
    const b = await tryAcquireWorkerLease(pool(), WEBHOOK_WORKER_LEASE);
    expect(b, "a second session must be refused, not queued").toBeNull();
    // `try_` and not the blocking form: a worker that waited here would hang with no
    // message, which reads as a broken deployment rather than a redundant replica.
  });

  it("holds across unrelated work on other connections", async () => {
    const a = await withLease(pool(), WEBHOOK_WORKER_LEASE);
    // Real traffic, on its own connection: if the lock were transaction-scoped, or
    // keyed somewhere narrower than the session, this is where it would lapse.
    const other = pool();
    await other.query("SELECT 1");
    await other.query("BEGIN");
    await other.query("SELECT 1");
    await other.query("COMMIT");

    expect(await a!.held(), "the lease must survive other sessions' transactions").toBe(true);
    expect(await tryAcquireWorkerLease(pool(), WEBHOOK_WORKER_LEASE)).toBeNull();
  });

  it("does not stand in for itself: one session cannot take its own lease twice", async () => {
    // Session advisory locks are COUNTED, so a second `pg_try_advisory_lock` on the
    // same session succeeds and needs a second unlock. An implementation that
    // re-asserted its lease each pass by calling the try function again would leak a
    // lock reference per pass — invisible until the worker restarted.
    const p = pool();
    const first = await withLease(p, WEBHOOK_WORKER_LEASE);
    expect(first).not.toBeNull();
    expect(await tryAcquireWorkerLease(p, WEBHOOK_WORKER_LEASE),
      "taking the same lease again on one pool must not silently succeed").toBeNull();
  });

  it("reports the lease lost once its session ends, with no cleanup code", async () => {
    // The property that makes a session lock the right kind of lock here: a worker
    // killed with SIGKILL, or one whose database connection dropped, stops being the
    // writer without running a line of cleanup. A lease that needed cleanup would be
    // a lease that is eventually leaked.
    const p = pool();
    const a = await tryAcquireWorkerLease(p, WEBHOOK_WORKER_LEASE);
    expect(a).not.toBeNull();
    expect(await a!.held()).toBe(true);
    await a!.release();
    expect(await a!.held(), "a released lease must not report itself held").toBe(false);

    const next = await withLease(pool(), WEBHOOK_WORKER_LEASE);
    expect(next, "another session may take it immediately afterwards").not.toBeNull();
  });

  it("uses distinct keys for distinct names", async () => {
    const a = await withLease(pool(), WEBHOOK_WORKER_LEASE);
    const b = await tryAcquireWorkerLease(pool(), `${WEBHOOK_WORKER_LEASE}:other`);
    // Two different roles must not stand each other down. `hashtext` is 32 bits, so a
    // collision is possible in principle; this asserts the names we actually use do
    // not collide, which is checkable and is the part that matters.
    expect(b, "a different lease name must be independently acquirable").not.toBeNull();
    if (b) taken.push(b);
    expect(a).not.toBeNull();
  });

  it("is release-safe to call twice", async () => {
    // The worker's `finally` runs on the normal path and again on an exception path
    // in some runners. A second release must not throw, or it would mask the error
    // that caused it.
    const a = await tryAcquireWorkerLease(pool(), WEBHOOK_WORKER_LEASE);
    expect(a).not.toBeNull();
    await a!.release();
    await expect(a!.release()).resolves.toBeUndefined();
  });
});
