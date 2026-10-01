import { Pool } from "pg";
import { PostgresRepository } from "./postgres.js";

/**
 * Database connection.
 *
 * `DATABASE_URL` is required. There is deliberately no default: silently
 * falling back to a local database would let a run appear to pass against
 * developer state that does not exist in production. This matches the
 * `docs/EVIDENCE.md` rule that an unconfigured integration must report itself
 * as such rather than pretending to work.
 */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a " +
      "PostgreSQL instance. Refusing to fall back to a default: a run that " +
      "silently used developer state would misreport its own evidence level.",
    );
  }
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // NUMERIC arrives as a string from node-postgres and is parsed with
    // Number() in the row mappers, so precision is preserved without a
    // server-side numeric_float_digits setting. That GUC does not exist before
    // PostgreSQL 17, and setting it broke connections against the 16 server.
  });
}

/** Convenience for tests and scripts: a migrated repository over a pool. */
export async function openRepository(connectionString?: string): Promise<{ pool: Pool; repo: PostgresRepository }> {
  const pool = createPool(connectionString);
  const repo = new PostgresRepository(pool);
  await repo.migrate();
  return { pool, repo };
}
