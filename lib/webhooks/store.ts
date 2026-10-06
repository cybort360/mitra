/**
 * Webhook subscriptions and their delivery record (PP-3).
 *
 * Kept apart from `EconomicRepository`: a subscription is deployment plumbing,
 * not economic state, and the repository's backends are the lead's. The backend
 * follows the economic store's: Postgres when `DATABASE_URL` is set (its own two
 * tables, created here), memory otherwise.
 *
 * The secret is stored recoverable, because signing needs it. It is returned to
 * the operator once, at registration, and never by a read.
 */
import type { Pool } from "pg";

export interface WebhookSubscription {
  webhookId: string;
  url: string;
  /** `*`, `<topic>.*`, or exact types. */
  events: string[];
  secret: string;
  description?: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  /** The last event-log position this subscription has processed. */
  cursor: number;
}

/** One delivery's final outcome. Retries are summarised in `attempts`, not stored apart. */
export interface DeliveryRecord {
  deliveryId: string;
  webhookId: string;
  eventId: string;
  seq: number;
  type: string;
  outcome: "DELIVERED" | "DEAD_LETTERED";
  attempts: number;
  /** HTTP status of the last attempt, if a response arrived. */
  lastStatus?: number;
  /** Why the last attempt failed, if it did. */
  lastError?: string;
  at: string;
}

export interface WebhookStore {
  createSubscription(sub: WebhookSubscription): Promise<void>;
  listSubscriptions(): Promise<WebhookSubscription[]>;
  advanceCursor(webhookId: string, seq: number): Promise<void>;
  /**
   * Upsert by `deliveryId` (one per subscription and event): a worker that died
   * after recording but before advancing the cursor resends the event, and its
   * second outcome replaces the first rather than wedging the drain on a
   * duplicate key.
   */
  recordDelivery(d: DeliveryRecord): Promise<void>;
  listDeliveries(filter?: { webhookId?: string; outcome?: DeliveryRecord["outcome"] }): Promise<DeliveryRecord[]>;
}

export class MemoryWebhookStore implements WebhookStore {
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly deliveries: DeliveryRecord[] = [];

  async createSubscription(sub: WebhookSubscription) {
    if (this.subs.has(sub.webhookId)) throw new Error(`WEBHOOK_EXISTS:${sub.webhookId}`);
    this.subs.set(sub.webhookId, { ...sub, events: [...sub.events] });
  }
  async listSubscriptions() {
    return [...this.subs.values()].map((s) => ({ ...s, events: [...s.events] }));
  }
  async advanceCursor(webhookId: string, seq: number) {
    const s = this.subs.get(webhookId);
    // Forward only: a late or duplicate worker never rewinds a subscriber.
    if (s && seq > s.cursor) s.cursor = seq;
  }
  async recordDelivery(d: DeliveryRecord) {
    const i = this.deliveries.findIndex((x) => x.deliveryId === d.deliveryId);
    if (i >= 0) this.deliveries[i] = { ...d }; else this.deliveries.push({ ...d });
  }
  async listDeliveries(filter: { webhookId?: string; outcome?: DeliveryRecord["outcome"] } = {}) {
    return this.deliveries
      .filter((d) => (!filter.webhookId || d.webhookId === filter.webhookId) && (!filter.outcome || d.outcome === filter.outcome))
      .map((d) => ({ ...d }));
  }
}

export const WEBHOOK_MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS mitra`,
  `CREATE TABLE IF NOT EXISTS mitra.webhook_subscriptions (
     webhook_id text PRIMARY KEY,
     data jsonb NOT NULL,
     cursor bigint NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS mitra.webhook_deliveries (
     delivery_id text PRIMARY KEY,
     webhook_id text NOT NULL REFERENCES mitra.webhook_subscriptions(webhook_id),
     outcome text NOT NULL,
     data jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_by_hook ON mitra.webhook_deliveries (webhook_id, outcome)`,
];

export class PostgresWebhookStore implements WebhookStore {
  constructor(private readonly pool: Pool) {}

  async migrate() {
    for (const sql of WEBHOOK_MIGRATIONS) await this.pool.query(sql);
  }
  async createSubscription(sub: WebhookSubscription) {
    const { cursor, ...data } = sub;
    // No upsert: re-registering an id must not silently replace its URL or secret.
    await this.pool.query(
      `INSERT INTO mitra.webhook_subscriptions (webhook_id, data, cursor) VALUES ($1, $2::jsonb, $3)`,
      [sub.webhookId, JSON.stringify(data), cursor],
    );
  }
  async listSubscriptions() {
    const { rows } = await this.pool.query(`SELECT data, cursor FROM mitra.webhook_subscriptions ORDER BY webhook_id`);
    return rows.map((r) => ({ ...(r.data as Omit<WebhookSubscription, "cursor">), cursor: Number(r.cursor) }));
  }
  async advanceCursor(webhookId: string, seq: number) {
    await this.pool.query(
      `UPDATE mitra.webhook_subscriptions SET cursor = $2 WHERE webhook_id = $1 AND cursor < $2`,
      [webhookId, seq],
    );
  }
  async recordDelivery(d: DeliveryRecord) {
    await this.pool.query(
      `INSERT INTO mitra.webhook_deliveries (delivery_id, webhook_id, outcome, data) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (delivery_id) DO UPDATE SET outcome = EXCLUDED.outcome, data = EXCLUDED.data`,
      [d.deliveryId, d.webhookId, d.outcome, JSON.stringify(d)],
    );
  }
  async listDeliveries(filter: { webhookId?: string; outcome?: DeliveryRecord["outcome"] } = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.webhookId) { params.push(filter.webhookId); clauses.push(`webhook_id = $${params.length}`); }
    if (filter.outcome) { params.push(filter.outcome); clauses.push(`outcome = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query(`SELECT data FROM mitra.webhook_deliveries ${where} ORDER BY (data->>'seq')::bigint, delivery_id`, params);
    return rows.map((r) => r.data as DeliveryRecord);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mitraWebhookStore: Promise<{ store: WebhookStore; pool?: Pool }> | undefined;
}

export function getWebhookStore(): Promise<WebhookStore> {
  if (!globalThis.__mitraWebhookStore) globalThis.__mitraWebhookStore = openWebhookStore();
  return globalThis.__mitraWebhookStore.then((h) => h.store);
}

async function openWebhookStore(): Promise<{ store: WebhookStore; pool?: Pool }> {
  if (!process.env.DATABASE_URL) return { store: new MemoryWebhookStore() };
  const { createPool } = await import("@/lib/store/db");
  const pool = createPool(process.env.DATABASE_URL);
  const store = new PostgresWebhookStore(pool);
  await store.migrate();
  return { store, pool };
}

/** Tests: a fresh store; on Postgres, the webhook tables emptied. */
export async function __resetWebhookStoreForTests(): Promise<void> {
  const prior = globalThis.__mitraWebhookStore;
  globalThis.__mitraWebhookStore = undefined;
  if (prior) {
    const { pool } = await prior;
    await pool?.end();
  }
  if (process.env.DATABASE_URL) {
    const { createPool } = await import("@/lib/store/db");
    const pool = createPool(process.env.DATABASE_URL);
    try {
      for (const sql of WEBHOOK_MIGRATIONS) await pool.query(sql);
      await pool.query(`TRUNCATE mitra.webhook_deliveries, mitra.webhook_subscriptions`);
    } finally {
      await pool.end();
    }
  }
}
