import type { Reservation } from "@/lib/domain/types";
import { __resetLedgerForTests } from "@/lib/store/ledger";
import { __resetStoreForTests } from "@/lib/store/provider";

/** Shared fixtures for the API wiring tests. Before mandate expiry, inside the window. */
export const NOW = "2026-10-01T12:00:00.000Z";

export const goodProposal = {
  mandateId: "mandate_research_v7",
  vaultId: "vault_sol_primary",
  amount: 5, asset: "USDC", chain: "solana",
  counterparty: "virtuals:research-agent-18",
  capability: "market_research",
  intentId: "intent_t1", runId: "run_t1",
  now: NOW,
};

export const json = (res: Response) => res.json();
export const req = (body: unknown) =>
  new Request("http://localhost/api/v1/x", { method: "POST", body: JSON.stringify(body) });

/**
 * Prepare whichever store the routes will actually use.
 *
 * The API suites drive real route handlers, so their outcome depends on the
 * backend: with no `DATABASE_URL` the routes are served by the in-memory ledger,
 * which is seeded at construction; with one set they are served by Postgres,
 * which starts empty and therefore 404s on every request.
 *
 * Previously each suite called `__resetLedgerForTests()` alone, which reset the
 * ledger but left the provider holding a reference to the discarded instance —
 * so state leaked between tests, and the Postgres path had no fixtures at all.
 * One helper, used by every suite that drives a route, removes both problems.
 */
export async function prepareStore(): Promise<void> {
  __resetLedgerForTests();
  __resetStoreForTests();
  if (!process.env.DATABASE_URL) return;
  const { createPool } = await import("@/lib/store/db");
  const { MIGRATIONS } = await import("@/lib/store/schema");
  const { PostgresRepository } = await import("@/lib/store/postgres");
  const pool = createPool(process.env.DATABASE_URL);
  try {
    for (const sql of MIGRATIONS) await pool.query(sql);
    const repo = new PostgresRepository(pool);
    // Truncate first: a previous suite's reservations would otherwise make the
    // velocity window non-empty and deny proposals these tests expect to pass.
    await pool.query("TRUNCATE mitra.reservations, mitra.consumed_nonces, mitra.authorizations, mitra.event_log, mitra.mandates, mitra.vaults CASCADE");
    await repo.seedReferenceData();
  } finally {
    await pool.end();
  }
}
