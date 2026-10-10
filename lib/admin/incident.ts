/**
 * Incident controls (PP-4, PRD Phase 10): an operator can halt value movement
 * while everything that only reads keeps working.
 *
 * Three scopes, each naming the routes it stops:
 *   - `agreements`: opening a new agreement;
 *   - `funding`: funding an agreement, and creating a reservation (both encumber capital);
 *   - `execution`: the execution guard (`/reservations/execute`), settlement
 *     (`settle`, `settleResidual`) and x402 payments.
 *
 * Deliberately left running: refunds and rejections (the recovery path; halting
 * compensation during an incident strands capital), confirming a settlement that
 * already happened on chain (refusing would hide the truth), authorizations (an
 * ALLOW moves nothing), every GET, and the event stream.
 *
 * The state is read on every guarded request, from Postgres when `DATABASE_URL`
 * is set, so a pause reaches every process at once. It is not cached: a halt that
 * lags by a cache TTL is a halt that lets the next payment through.
 *
 * The pause governs the API. Operator scripts that hold keys and call chains
 * directly are outside it.
 */
import { NextResponse } from "next/server";
import type { Pool } from "pg";

/**
 * What a pause stops.
 *
 * `authority` (F100) covers Mandate creation. A Mandate is the ROOT of the authority tree —
 * every authorization below it is evaluated against that record — so granting one during an
 * incident is how an agent acquires a ceiling nobody intended to give it. Minting authority
 * is therefore pausable, unlike granting an Authorization, which is bounded by a Mandate
 * that already exists.
 */
export const PAUSE_SCOPES = ["agreements", "funding", "execution", "authority"] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];

export interface PauseState {
  paused: boolean;
  scopes: PauseScope[];
  reason: string;
  /** When the current state was set. */
  since: string;
  version: number;
}

const RUNNING: PauseState = { paused: false, scopes: [], reason: "", since: new Date(0).toISOString(), version: 0 };

interface IncidentStore {
  get(): Promise<PauseState>;
  set(next: Omit<PauseState, "version" | "since">, at: string): Promise<PauseState>;
}

class MemoryIncidentStore implements IncidentStore {
  private state: PauseState = { ...RUNNING };
  async get() { return { ...this.state, scopes: [...this.state.scopes] }; }
  async set(next: Omit<PauseState, "version" | "since">, at: string) {
    this.state = { ...next, scopes: [...next.scopes], since: at, version: this.state.version + 1 };
    return this.get();
  }
}

const MIGRATIONS = [
  `CREATE SCHEMA IF NOT EXISTS mitra`,
  `CREATE TABLE IF NOT EXISTS mitra.incident_controls (id text PRIMARY KEY, data jsonb NOT NULL, version bigint NOT NULL)`,
];

class PostgresIncidentStore implements IncidentStore {
  constructor(private readonly pool: Pool) {}
  async migrate() { for (const sql of MIGRATIONS) await this.pool.query(sql); }
  async get(): Promise<PauseState> {
    const { rows } = await this.pool.query(`SELECT data, version FROM mitra.incident_controls WHERE id = 'global'`);
    return rows[0] ? { ...(rows[0].data as Omit<PauseState, "version">), version: Number(rows[0].version) } : { ...RUNNING };
  }
  async set(next: Omit<PauseState, "version" | "since">, at: string): Promise<PauseState> {
    const data = { ...next, since: at };
    const { rows } = await this.pool.query(
      `INSERT INTO mitra.incident_controls (id, data, version) VALUES ('global', $1::jsonb, 1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = mitra.incident_controls.version + 1
       RETURNING version`,
      [JSON.stringify(data)],
    );
    return { ...data, version: Number(rows[0].version) };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mitraIncidentStore: Promise<{ store: IncidentStore; pool?: Pool }> | undefined;
}

function incidentStore(): Promise<IncidentStore> {
  if (!globalThis.__mitraIncidentStore) {
    globalThis.__mitraIncidentStore = (async () => {
      if (!process.env.DATABASE_URL) return { store: new MemoryIncidentStore() };
      const { createPool } = await import("@/lib/store/db");
      const pool = createPool(process.env.DATABASE_URL);
      const store = new PostgresIncidentStore(pool);
      await store.migrate();
      return { store, pool };
    })();
  }
  return globalThis.__mitraIncidentStore.then((h) => h.store);
}

export async function getPauseState(): Promise<PauseState> {
  return (await incidentStore()).get();
}

export async function setPauseState(next: { paused: boolean; scopes: PauseScope[]; reason: string }): Promise<PauseState> {
  // Resuming clears every scope: a partial resume is a pause with fewer scopes.
  const scopes = next.paused ? [...new Set(next.scopes)].sort() as PauseScope[] : [];
  return (await incidentStore()).set({ paused: next.paused && scopes.length > 0, scopes, reason: next.reason }, new Date().toISOString());
}

/**
 * The guard a value-moving route calls first. Returns the 503 to send, or null
 * when the scope is running. Fails closed: if the state cannot be read, the
 * route refuses rather than assuming it may move value.
 */
export async function refuseIfPaused(scope: PauseScope): Promise<NextResponse | null> {
  let state: PauseState;
  try {
    state = await getPauseState();
  } catch {
    return NextResponse.json({ error: "SYSTEM_PAUSE_STATE_UNAVAILABLE", scope }, { status: 503, headers: { "retry-after": "30" } });
  }
  if (!state.paused || !state.scopes.includes(scope)) return null;
  return NextResponse.json(
    { error: "SYSTEM_PAUSED", scope, reason: state.reason, since: state.since },
    { status: 503, headers: { "retry-after": "60" } },
  );
}

/** Tests: back to running; on Postgres, the row removed. */
export async function __resetIncidentStoreForTests(): Promise<void> {
  const prior = globalThis.__mitraIncidentStore;
  globalThis.__mitraIncidentStore = undefined;
  if (prior) await (await prior).pool?.end();
  if (process.env.DATABASE_URL) {
    const { createPool } = await import("@/lib/store/db");
    const pool = createPool(process.env.DATABASE_URL);
    try {
      for (const sql of MIGRATIONS) await pool.query(sql);
      await pool.query(`DELETE FROM mitra.incident_controls`);
    } finally {
      await pool.end();
    }
  }
}
