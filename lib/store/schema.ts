/**
 * Schema for durable economic state.
 *
 * Applied in order and idempotently, so it doubles as the migration. Kept as a
 * plain string rather than a migration framework because there are three
 * tables; if that changes, this is the thing to replace.
 *
 * Design notes tied to docs/SECURITY.md:
 *
 * - `reservations.amount > 0` enforces the lower bound at the storage layer, so
 *   even a buggy caller cannot persist a negative reservation.
 * - `vaults.version` supports optimistic concurrency; `reserve_capital` checks
 *   it and rolls back rather than silently overwriting a concurrent write.
 * - `consumed_nonces` is UNIQUE on (vault_id, nonce). That constraint *is* the
 *   idempotency boundary: a replay fails at the database, not in application
 *   logic that a future refactor could bypass.
 * - `event_log` is append-only. There is deliberately no UPDATE or DELETE path.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE SCHEMA IF NOT EXISTS mitra;

  CREATE TABLE IF NOT EXISTS mitra.vaults (
    vault_id      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    principal     TEXT NOT NULL,
    controller_ref TEXT NOT NULL,
    chain         TEXT NOT NULL,
    asset         TEXT NOT NULL,
    address       TEXT NOT NULL,
    total         NUMERIC(20,6) NOT NULL CHECK (total >= 0),
    available     NUMERIC(20,6) NOT NULL CHECK (available >= 0),
    reserved      NUMERIC(20,6) NOT NULL CHECK (reserved  >= 0),
    escrowed      NUMERIC(20,6) NOT NULL CHECK (escrowed  >= 0),
    encumbered    NUMERIC(20,6) NOT NULL CHECK (encumbered >= 0),
    settling      NUMERIC(20,6) NOT NULL CHECK (settling  >= 0),
    frozen        NUMERIC(20,6) NOT NULL CHECK (frozen    >= 0),
    emergency_freeze BOOLEAN NOT NULL DEFAULT FALSE,
    custody_mode  TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS mitra.mandates (
    mandate_id    TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       INTEGER NOT NULL,
    principal     TEXT NOT NULL,
    agent_id      TEXT NOT NULL,
    vault_id      TEXT NOT NULL REFERENCES mitra.vaults(vault_id),
    asset         TEXT NOT NULL,
    budget        NUMERIC(20,6) NOT NULL CHECK (budget > 0),
    max_transaction NUMERIC(20,6) NOT NULL CHECK (max_transaction > 0),
    velocity_amount  NUMERIC(20,6),
    velocity_window  INTEGER,
    allowed_counterparties TEXT[] NOT NULL,
    allowed_capabilities   TEXT[] NOT NULL,
    prohibited_capabilities TEXT[] NOT NULL,
    approved_chains TEXT[] NOT NULL,
    policy_version TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    nonce         INTEGER NOT NULL,
    status        TEXT NOT NULL,
    confidential_policy BOOLEAN NOT NULL DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS mitra.reservations (
    reservation_id TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    vault_id       TEXT NOT NULL REFERENCES mitra.vaults(vault_id),
    intent_id      TEXT NOT NULL,
    mandate_id     TEXT NOT NULL,
    mandate_version INTEGER NOT NULL,
    asset          TEXT NOT NULL,
    -- The lower bound lives here, not only in the kernel: a storage-level
    -- CHECK cannot be bypassed by a future caller.
    amount         NUMERIC(20,6) NOT NULL CHECK (amount > 0),
    chain          TEXT NOT NULL,
    action_digest  TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    nonce          INTEGER NOT NULL,
    status         TEXT NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_reservations_vault ON mitra.reservations(vault_id);
  CREATE INDEX IF NOT EXISTS idx_reservations_intent ON mitra.reservations(intent_id);

  -- The idempotency boundary. UNIQUE is the enforcement, not application code.
  CREATE TABLE IF NOT EXISTS mitra.consumed_nonces (
    vault_id     TEXT NOT NULL REFERENCES mitra.vaults(vault_id),
    nonce        INTEGER NOT NULL,
    reservation_id TEXT NOT NULL,
    consumed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, nonce)
  );

  CREATE TABLE IF NOT EXISTS mitra.authorizations (
    authorization_id TEXT PRIMARY KEY,
    run_id         TEXT,
    intent_id       TEXT,
    mandate_id     TEXT NOT NULL,
    mandate_version INTEGER NOT NULL,
    vault_id       TEXT NOT NULL,
    decision       TEXT NOT NULL,
    action_digest  TEXT NOT NULL,
    asset          TEXT NOT NULL,
    amount_ceiling NUMERIC(20,6) NOT NULL,
    chain          TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    nonce          INTEGER NOT NULL,
    reason_codes   TEXT[] NOT NULL,
    signer         TEXT NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Append-only. No UPDATE or DELETE path exists by design.
  CREATE TABLE IF NOT EXISTS mitra.event_log (
    seq         BIGSERIAL PRIMARY KEY,
    event_id    TEXT NOT NULL UNIQUE,
    run_id      TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL,
    receipt_id  TEXT,
    object_ref  TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE INDEX IF NOT EXISTS idx_event_run ON mitra.event_log(run_id, seq);
  `,
];
