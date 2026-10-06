/**
 * Webhook delivery (PP-3): an outbox over the event log.
 *
 * `drain` walks each active subscription forward from its own cursor through
 * `listEventsSince`, the log the SSE stream serves, and delivers the events its
 * patterns match. No route waits on a subscriber, and events written by another
 * process (Postgres) are delivered like any other. A subscriber that is down
 * delays only itself.
 *
 * Delivery is at-least-once: the cursor advances after each event's outcome is
 * recorded, so a worker that dies mid-delivery resends that event. Receivers
 * drop duplicates by `X-Mitra-Event-Id`.
 *
 * **Two concurrent drainers would deliver everything twice.** This used to be
 * handled by a sentence — "run ONE worker per deployment" — which is a control
 * with no mechanism: a second replica, an overlapping `systemd` restart, or a
 * `kubectl scale` during an incident all produce exactly the duplication the
 * sentence warns about, and none of them is an operator's mistake. `drain` now
 * expects its caller to hold the single-writer lease
 * (`tryAcquireWorkerLease` in `lib/store/postgres.ts`), and `scripts/webhook-worker.ts`
 * stands down when it cannot take it. The `drain` function itself is unchanged and
 * remains safe to call directly from a test: the lease is a deployment-level
 * concern, and putting it *inside* `drain` would mean a per-subscription lock
 * acquired and released once per subscription per pass.
 *
 * Retry policy: at most `maxAttempts` (3), waiting `backoffMs[i]` before retry
 * i+1 (1s, then 5s). A 5xx, 408, 429, timeout or network failure is retried; any
 * other non-2xx dead-letters at once, because repeating a request the receiver
 * has refused will not change its answer. A dead letter is recorded, not
 * dropped, and the cursor moves on.
 */
import type { EconomicRepository } from "@/lib/store/repository";
import { envelopeFor, matchesAny, type WebhookEnvelope } from "./events";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "./signing";
import type { DeliveryRecord, WebhookStore, WebhookSubscription } from "./store";
import type { WebhookTransport } from "./transport";

export interface DispatchDeps {
  transport: WebhookTransport;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now: () => number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  timeoutMs?: number;
}

export const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: [1_000, 5_000], timeoutMs: 10_000 } as const;

const retryable = (status: number) => status >= 500 || status === 408 || status === 429;

export async function deliver(sub: WebhookSubscription, envelope: WebhookEnvelope, deps: DispatchDeps): Promise<DeliveryRecord> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const backoff = deps.backoffMs ?? DEFAULT_RETRY.backoffMs;
  const body = JSON.stringify(envelope);
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  let attempts = 0;
  const record = (outcome: DeliveryRecord["outcome"]): DeliveryRecord => ({
    deliveryId: `dlv_${sub.webhookId}_${envelope.seq}`, webhookId: sub.webhookId, eventId: envelope.id, seq: envelope.seq,
    type: envelope.type, outcome, attempts,
    ...(lastStatus !== undefined ? { lastStatus } : {}), ...(lastError ? { lastError } : {}),
    at: new Date(deps.now()).toISOString(),
  });

  while (attempts < maxAttempts) {
    if (attempts > 0) await deps.sleep(backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0);
    attempts++;
    // Signed per attempt, so a retry after backoff carries a timestamp inside the receiver's window.
    const timestamp = Math.floor(deps.now() / 1000);
    try {
      const { status } = await deps.transport(sub.url, body, {
        [SIGNATURE_HEADER]: signWebhook(sub.secret, timestamp, body),
        [TIMESTAMP_HEADER]: String(timestamp),
        [EVENT_ID_HEADER]: envelope.id,
      }, deps.timeoutMs ?? DEFAULT_RETRY.timeoutMs);
      lastStatus = status;
      lastError = undefined;
      if (status >= 200 && status < 300) return record("DELIVERED");
      lastError = status >= 300 && status < 400 ? "REDIRECT_NOT_FOLLOWED" : `HTTP_${status}`;
      if (!retryable(status)) break;
    } catch (e) {
      lastStatus = undefined;
      lastError = e instanceof Error ? e.message : String(e);
      // A target refused by the SSRF guard will be refused again: no retry.
      if (/WEBHOOK_TARGET_FORBIDDEN|URL_/.test(lastError)) break;
    }
  }
  return record("DEAD_LETTERED");
}

export interface DrainResult { scanned: number; delivered: number; deadLettered: number }

/** One pass: every active subscription, up to `limit` log entries each. */
export async function drain(repo: EconomicRepository, store: WebhookStore, deps: DispatchDeps, opts: { limit?: number } = {}): Promise<DrainResult> {
  const result: DrainResult = { scanned: 0, delivered: 0, deadLettered: 0 };
  for (const sub of await store.listSubscriptions()) {
    if (sub.status !== "ACTIVE") continue;
    for (const { seq, event } of await repo.listEventsSince(sub.cursor, opts.limit ?? 100)) {
      result.scanned++;
      const envelope = envelopeFor(seq, event);
      if (matchesAny(sub.events, envelope.type)) {
        const d = await deliver(sub, envelope, deps);
        await store.recordDelivery(d);
        if (d.outcome === "DELIVERED") result.delivered++; else result.deadLettered++;
      }
      await store.advanceCursor(sub.webhookId, seq);
    }
  }
  return result;
}

/** The log's current head, so a new subscription starts now rather than replaying history. */
export async function logHead(repo: EconomicRepository): Promise<number> {
  let cursor = 0;
  for (;;) {
    const page = await repo.listEventsSince(cursor, 1000);
    if (page.length === 0) return cursor;
    cursor = page[page.length - 1].seq;
  }
}
