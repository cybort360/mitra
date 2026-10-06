/**
 * Webhook delivery worker (PP-3). Tails the event log and delivers to every
 * active subscription (lib/webhooks/dispatcher.ts).
 *
 *   DATABASE_URL=… npx tsx scripts/webhook-worker.ts            # loop
 *   DATABASE_URL=… npx tsx scripts/webhook-worker.ts --once     # one pass, then exit
 *
 * MITRA_WEBHOOK_POLL_MS (default 2000) sets the interval between passes.
 * Without DATABASE_URL it would read an empty in-memory log of its own, so it
 * refuses to start.
 *
 * ## Why there is a lease
 *
 * Delivery is at-least-once and the cursor advances per subscription. Two workers
 * draining the same subscription concurrently both read cursor N, both deliver N,
 * and both write N+1 — so the duplicate is delivered twice. The dispatcher already
 * said "run ONE worker per deployment" and then relied on an operator obeying it,
 * which is a control with no mechanism: a second replica, a `systemd` restart loop
 * that overlaps, or a `kubectl scale` during an incident all produce exactly the
 * duplication the sentence warns about.
 *
 * So the lease is the mechanism, and this worker *stands down* when it cannot take
 * it. That is the important half: the alternative — blocking until the lock frees —
 * turns a redundant replica into a pod that hangs in `Running` with no message,
 * which reads as a broken deployment rather than a healthy one.
 *
 * ## Why the lease is re-asserted rather than assumed
 *
 * The lock is session-scoped on one dedicated connection, so Postgres releases it
 * when that connection dies — a killed worker, a dropped link, a database restart
 * mid-pass. Holding it is therefore not a permanent property. The worker re-checks
 * before every pass and re-acquires when the answer is no, because a worker that
 * kept draining on a remembered `true` would be silently double-delivering the
 * whole time it claimed to be safe.
 */
import { getStore } from "@/lib/store/provider";
import { createPool } from "@/lib/store/db";
import { WEBHOOK_WORKER_LEASE, tryAcquireWorkerLease, type WorkerLease } from "@/lib/store/postgres";
import { drain } from "@/lib/webhooks/dispatcher";
import { getWebhookStore } from "@/lib/webhooks/store";
import { safeTransport } from "@/lib/webhooks/transport";

/** Exit code for "another worker already holds the lease". Distinct from 2 (misconfigured). */
const EXIT_STANDING_DOWN = 3;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("webhook worker: DATABASE_URL is required. An in-memory store is private to one process, so there is nothing to deliver.");
    process.exit(2);
  }
  const once = process.argv.includes("--once");
  const pollMs = Math.max(200, Number(process.env.MITRA_WEBHOOK_POLL_MS ?? 2000) || 2000);
  const { repo } = await getStore();
  const store = await getWebhookStore();
  const deps = { transport: safeTransport(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now() };

  // Its own pool, not the request store's: the lease must survive a pass failing,
  // and it must be one dedicated connection held for the process's lifetime. The
  // pool's default `max` is larger than the worker's whole working set, so a
  // `connect()` could otherwise be handed a *different* client next time — and a
  // session lock taken on client A is invisible from client B.
  const leasePool = createPool();
  let lease: WorkerLease | null = await tryAcquireWorkerLease(leasePool, WEBHOOK_WORKER_LEASE);
  if (!lease) {
    console.error(
      `webhook worker: another worker holds the "${WEBHOOK_WORKER_LEASE}" lease; standing down. ` +
        "This is healthy — one worker per database, not one per replica.",
    );
    await leasePool.end();
    process.exit(EXIT_STANDING_DOWN);
  }
  console.error(`webhook worker: holding the "${WEBHOOK_WORKER_LEASE}" lease`);

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  try {
    do {
      // Re-assert before each pass, and re-acquire if the session died. Re-checking
      // costs one `SELECT 1` per pass; assuming costs duplicate deliveries.
      if (!(await lease!.held())) {
        console.error("webhook worker: lease lost (connection closed); re-acquiring");
        lease = await tryAcquireWorkerLease(leasePool, WEBHOOK_WORKER_LEASE);
        if (!lease) {
          console.error("webhook worker: another worker took the lease while this one was down; exiting");
          return process.exit(EXIT_STANDING_DOWN);
        }
      }
      const r = await drain(repo, store, deps);
      if (r.scanned) console.error(`webhook worker: scanned ${r.scanned}, delivered ${r.delivered}, dead-lettered ${r.deadLettered}`);
      if (once) break;
      await new Promise((res) => setTimeout(res, pollMs));
    } while (!stopping);
  } finally {
    // On a clean shutdown. Not the mechanism that matters — Postgres drops the
    // session lock when this connection closes, and the process dying closes it —
    // but it makes the release observable in the logs rather than inferred.
    await lease!.release().catch(() => {});
    await leasePool.end();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
