/**
 * Webhook delivery worker (PP-3). Tails the event log and delivers to every
 * active subscription (lib/webhooks/dispatcher.ts). Run exactly one per deployment.
 *
 *   DATABASE_URL=… npx tsx scripts/webhook-worker.ts            # loop
 *   DATABASE_URL=… npx tsx scripts/webhook-worker.ts --once     # one pass, then exit
 *
 * MITRA_WEBHOOK_POLL_MS (default 2000) sets the interval between passes.
 * Without DATABASE_URL it would read an empty in-memory log of its own, so it
 * refuses to start.
 */
import { getStore } from "@/lib/store/provider";
import { drain } from "@/lib/webhooks/dispatcher";
import { getWebhookStore } from "@/lib/webhooks/store";
import { safeTransport } from "@/lib/webhooks/transport";

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
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  do {
    const r = await drain(repo, store, deps);
    if (r.scanned) console.error(`webhook worker: scanned ${r.scanned}, delivered ${r.delivered}, dead-lettered ${r.deadLettered}`);
    if (once) break;
    await new Promise((res) => setTimeout(res, pollMs));
  } while (!stopping);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
