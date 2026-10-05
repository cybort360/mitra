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
  `
  -- Spaces (PRD §13.1): the bounded commercial context.
  --
  -- Stored as JSONB plus the columns worth constraining or indexing. The nested
  -- shape (Money, participant and capability arrays) would otherwise be a dozen
  -- join tables for a boundary that is read whole every time — a Space is
  -- fetched to answer "is this participant admitted", never queried by field.
  CREATE TABLE IF NOT EXISTS mitra.spaces (
    space_id  TEXT PRIMARY KEY,
    owner     TEXT NOT NULL,
    status    TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
    document  JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Agreements, with a REAL foreign key to their Space.
  --
  -- The spaceId field was added to the Agreement type so that handing a kernel op
  -- the wrong Space would be DETECTABLE rather than merely discouraged. This
  -- makes that structural: an agreement whose space_id names no Space cannot be
  -- inserted, so the containment link cannot be left dangling by a buggy caller.
  CREATE TABLE IF NOT EXISTS mitra.agreements (
    agreement_id TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    document     JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- **A JOIN TABLE, not a NOT NULL column.**
  --
  -- The previous "agreements.space_id TEXT NOT NULL REFERENCES spaces" was correct
  -- F33 (it made the containment link enforceable) and wrong for interoperability:
  -- it made a Mitra tenancy MANDATORY, so an external agent's job could not exist
  -- without joining a Mitra Space. ADR-0011 open items 1 and 3.
  --
  -- A join table expresses three cases the single column could not:
  --   no Spaces     - an external, non-Mitra-native engagement interoperates
  --   one Space     - the common case
  --   several Spaces - a multi-party engagement spanning contexts
  --
  -- An agreement with zero rows here is NOT a broken row; it is a valid one with
  -- no tenancy, which is what interoperability requires.
  CREATE TABLE IF NOT EXISTS mitra.agreement_spaces (
    agreement_id TEXT NOT NULL REFERENCES mitra.agreements(agreement_id) ON DELETE CASCADE,
    space_id     TEXT NOT NULL REFERENCES mitra.spaces(space_id) ON DELETE RESTRICT,
    PRIMARY KEY (agreement_id, space_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agreement_space ON mitra.agreement_spaces(space_id);

  CREATE TABLE IF NOT EXISTS mitra.obligations (
    obligation_id TEXT PRIMARY KEY,
    debtor       TEXT NOT NULL,
    creditor     TEXT NOT NULL,
    asset        TEXT NOT NULL,
    amount       NUMERIC(20,6) NOT NULL CHECK (amount >= 0),
    status       TEXT NOT NULL,
    document     JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_obligation_status ON mitra.obligations(status);
  CREATE INDEX IF NOT EXISTS idx_obligation_party ON mitra.obligations(debtor, creditor);

  -- Settlements carry their own lifecycle (PENDING -> SUBMITTED -> CONFIRMED,
  -- plus FAILED and REVERSED). CONFIRMED is the terminal success state and there
  -- is no SETTLED member - an accounting view that assumed one would report zero
  -- settled forever (see F37).
  CREATE TABLE IF NOT EXISTS mitra.settlements (
    settlement_id TEXT PRIMARY KEY,
    chain         TEXT NOT NULL,
    asset         TEXT NOT NULL,
    amount        NUMERIC(20,6) NOT NULL CHECK (amount >= 0),
    status        TEXT NOT NULL,
    document      JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_settlement_status ON mitra.settlements(status);

  CREATE TABLE IF NOT EXISTS mitra.runs (
    run_id     TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    document   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS mitra.deliverables (
    deliverable_id TEXT PRIMARY KEY,
    agreement_id   TEXT NOT NULL,
    accepted       BOOLEAN NOT NULL DEFAULT FALSE,
    document       JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_deliverable_agreement ON mitra.deliverables(agreement_id);
  `,
  `
  -- MIGRATION (idempotent). CREATE TABLE IF NOT EXISTS never ALTERS an existing
  -- table, so the schema change from a single NOT NULL space_id to a join table
  -- cannot be delivered by the CREATE above alone - a database created before the
  -- change keeps its old shape and every insert then fails.
  --
  -- Three steps, each independently safe to run twice:
  --   1. backfill the join table from whatever space_id rows still have
  --   2. drop the NOT NULL so an agreement may join no Space at all
  --   3. drop the column, so there is no second source of truth left behind
  -- Step 3 is what stops the dual-write problem F33 describes.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='mitra' AND table_name='agreements' AND column_name='space_id'
    ) THEN
      INSERT INTO mitra.agreement_spaces (agreement_id, space_id)
      SELECT a.agreement_id, a.space_id FROM mitra.agreements a
       WHERE a.space_id IS NOT NULL
      ON CONFLICT DO NOTHING;

      ALTER TABLE mitra.agreements ALTER COLUMN space_id DROP NOT NULL;
      ALTER TABLE mitra.agreements DROP COLUMN space_id;
    END IF;
  END $$;

  -- Sagas (F49). The recovery kernel had complete unit coverage and NO write path, so
  -- declareSaga/compensate could only ever be exercised by a test calling them
  -- directly. This table is what lets a real agreement produce one.
  --
  -- route_attempts is NOT NULL DEFAULT '{}' -- F47. maxAttempts is only enforceable if
  -- the count lives on the persisted row. A nullable column would let a saga resume
  -- with no attempts recorded, and a replayed compensation would then be treated as a
  -- first attempt.
  CREATE TABLE IF NOT EXISTS mitra.sagas (
    saga_id             TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    intent_id           TEXT NOT NULL,
    status              TEXT NOT NULL,
    recovered_value     NUMERIC(20,6) NOT NULL DEFAULT 0,
    contained_value     NUMERIC(20,6) NOT NULL DEFAULT 0,
    steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
    compensation_routes JSONB NOT NULL DEFAULT '[]'::jsonb,
    route_attempts      JSONB NOT NULL DEFAULT '{}'::jsonb,
    timeout_policy      TEXT NOT NULL DEFAULT '',
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_sagas_run ON mitra.sagas(run_id);
  CREATE INDEX IF NOT EXISTS idx_sagas_status ON mitra.sagas(status);

  -- The agreement a reservation pays (sprint item 1). Nullable: most reservations
  -- pay no agreement. ADD COLUMN IF NOT EXISTS so a database created earlier
  -- gains it on the next migrate, which CREATE TABLE IF NOT EXISTS cannot do.
  ALTER TABLE mitra.reservations ADD COLUMN IF NOT EXISTS agreement_id TEXT;
  -- The authorization's recipient constraint was accepted and then dropped on write
  -- (backlog #5): the column did not exist, so a listed authorization lost it.
  ALTER TABLE mitra.authorizations ADD COLUMN IF NOT EXISTS recipient_constraint TEXT;

  -- Clearing epochs (backlog #5). The route finalizes the STORED epoch, never a
  -- client-supplied copy (F60).
  CREATE TABLE IF NOT EXISTS mitra.clearing_epochs (
    epoch_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    document   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Agents (backlog #5). Written only by a registration every listed wallet signed (F55).
  CREATE TABLE IF NOT EXISTS mitra.agents (
    agent_id   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    document   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Receipts (PRD §17), hash-chained per run. Terminal records: the application
  -- has no UPDATE or DELETE path. UNIQUE (run_id, seq) is the backstop against a
  -- forked chain; appendReceipt also takes a per-run advisory lock.
  CREATE TABLE IF NOT EXISTS mitra.receipts (
    receipt_id  TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    document    JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
  );
  `,
];
