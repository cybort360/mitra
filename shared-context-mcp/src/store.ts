import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GENESIS, canonical, hashEntry, sha256 } from "./hash.js";
import type {
  Actor, AuditResult, Entry, EntryStatus, MergeReport, NewEntry, SyncBundle,
} from "./types.js";

const WRITTEN_STATUSES: EntryStatus[] = ["active", "resolved", "archived", "superseded"];

/** Why an entry's stored content fails its own id or hash, or null if it holds. */
function integrityFailure(entry: Entry): string | null {
  const { entryId, hash, seq: _localSeq, ...rest } = entry;
  if (entryId !== `ctx_${sha256(canonical(rest)).slice(0, 16)}`) {
    return "ENTRY_ID_MISMATCH: content was altered after the id was issued";
  }
  if (hashEntry({ ...rest, entryId }) !== hash) {
    return "CONTENT_HASH_MISMATCH: entry content was altered after it was written";
  }
  return null;
}

/**
 * The status an entry's id commits to. Older nodes published the read-time
 * "superseded" instead of the status an entry was written with, and those
 * bundles are still on disk; for them, recover the written status the id and
 * hash prove. Anything that verifies under no status is refused.
 */
function committedStatus(entry: Entry): EntryStatus {
  const failure = integrityFailure(entry);
  if (!failure) return entry.status;
  if (entry.status === "superseded") {
    const written = WRITTEN_STATUSES.find((status) => !integrityFailure({ ...entry, status }));
    if (written) return written;
  }
  throw new Error(`${failure} (${entry.entryId})`);
}

export interface StoreOptions {
  /** Path to the sqlite file, or ":memory:". */
  path: string;
  nodeId?: string;
}

export class ContextStore {
  readonly db: DatabaseSync;
  readonly nodeId: string;

  constructor(opts: StoreOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    this.nodeId = opts.nodeId ?? `n_${Math.random().toString(36).slice(2, 10)}`;
    // WAL lets readers work while a writer appends — several agents may hit
    // the same store concurrently.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.restoreWrittenStatus();
  }

  /**
   * Undo what older merges stored: the read-time "superseded" in place of the
   * status an entry was written with. The id and hash prove the written value,
   * so this restores content rather than rewriting it. A row that verifies
   * under no status is left alone for the audit to report.
   */
  private restoreWrittenStatus(): void {
    const rows = this.db.prepare("SELECT * FROM entries WHERE status = 'superseded'").all() as Record<string, unknown>[];
    for (const row of rows) {
      const entry = this.rowToEntry(row);
      if (!integrityFailure(entry)) continue;
      const written = WRITTEN_STATUSES.find((status) => !integrityFailure({ ...entry, status }));
      if (written) this.db.prepare("UPDATE entries SET status = ? WHERE entry_id = ?").run(written, entry.entryId);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id      TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        body          TEXT NOT NULL,
        status        TEXT NOT NULL,
        scope         TEXT NOT NULL,
        tags          TEXT NOT NULL,
        author_id     TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        parents       TEXT NOT NULL,
        hash          TEXT NOT NULL UNIQUE,
        supersedes_id TEXT,
        data          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_scope  ON entries(scope);
      CREATE INDEX IF NOT EXISTS idx_entries_kind   ON entries(kind);
      CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
      CREATE INDEX IF NOT EXISTS idx_entries_author ON entries(author_id);
      CREATE TABLE IF NOT EXISTS actors (
        actor_id     TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role         TEXT,
        created_at   TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- actors

  registerActor(actor: Omit<Actor, "createdAt"> & { createdAt?: string }): Actor {
    const now = actor.createdAt ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO actors (actor_id, kind, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(actor_id) DO NOTHING`,
    ).run(actor.actorId, actor.kind, actor.displayName, actor.role ?? null, now);
    return { ...actor, createdAt: now };
  }

  getActor(actorId: string): Actor | null {
    const row = this.db.prepare("SELECT * FROM actors WHERE actor_id = ?").get(actorId) as Record<string, unknown> | undefined;
    return row ? rowToActor(row) : null;
  }

  listActors(): Actor[] {
    return (this.db.prepare("SELECT * FROM actors ORDER BY created_at ASC").all() as Record<string, unknown>[]).map(rowToActor);
  }

  // ---------------------------------------------------------------- entries

  rowToEntry(row: Record<string, unknown>): Entry {
    return {
      entryId: String(row.entry_id),
      seq: Number(row.seq),
      kind: String(row.kind) as Entry["kind"],
      title: String(row.title),
      body: String(row.body),
      status: String(row.status) as Entry["status"],
      scope: String(row.scope),
      tags: JSON.parse(String(row.tags)) as string[],
      authorId: String(row.author_id),
      createdAt: String(row.created_at),
      parents: JSON.parse(String(row.parents)) as string[],
      hash: String(row.hash),
      supersedesId: (row.supersedes_id as string) ?? undefined,
      data: row.data ? (JSON.parse(String(row.data)) as Record<string, unknown>) : undefined,
    };
  }

  get(entryId: string): Entry | null {
    const row = this.db.prepare("SELECT * FROM entries WHERE entry_id = ?").get(entryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entry = this.rowToEntry(row);
    const newer = this.db.prepare("SELECT 1 FROM entries WHERE supersedes_id = ? LIMIT 1").get(entryId);
    return newer ? { ...entry, status: "superseded" } : entry;
  }

  tip(): Entry | null {
    const row = this.db.prepare("SELECT * FROM entries ORDER BY seq DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Rows carry the status they were written with. "superseded" is derived here
   * (rather than stored) so that superseding never mutates an existing row.
   */
  private withDerivedStatus(rows: Record<string, unknown>[]): Entry[] {
    if (!rows.length) return [];
    const superseded = new Set(
      (this.db.prepare("SELECT DISTINCT supersedes_id AS id FROM entries WHERE supersedes_id IS NOT NULL").all() as Record<string, unknown>[])
        .map((r) => String(r.id)),
    );
    return rows.map((r) => {
      const entry = this.rowToEntry(r);
      return superseded.has(entry.entryId) ? { ...entry, status: "superseded" as const } : entry;
    });
  }

  list(filter: { scope?: string; kind?: string; status?: string; authorId?: string; limit?: number } = {}): Entry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.scope) { where.push("scope = ?"); params.push(filter.scope); }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.authorId) { where.push("author_id = ?"); params.push(filter.authorId); }
    // "superseded" is derived, so it must be filtered in SQL rather than after
    // the rows are read -- filtering post-hoc would silently drop entries.
    const SUPERSEDED = "EXISTS (SELECT 1 FROM entries s WHERE s.supersedes_id = entries.entry_id)";
    if (filter.status === "superseded") where.push(SUPERSEDED);
    else if (filter.status) { where.push(`NOT ${SUPERSEDED} AND status = ?`); params.push(filter.status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(filter.limit ?? 50);
    return this.withDerivedStatus(
      this.db.prepare(`SELECT * FROM entries ${clause} ORDER BY seq DESC LIMIT ?`).all(...params) as Record<string, unknown>[],
    );
  }

  /** Entries newer than a seq — the primitive behind incremental sync. */
  since(seq: number, limit = 1000): Entry[] {
    return this.withDerivedStatus(
      this.db.prepare("SELECT * FROM entries WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(seq, limit) as Record<string, unknown>[],
    );
  }

  /**
   * Append an entry. The hash covers the entry's own content *and* the previous
   * tip, so the log is a chain: altering any historical entry invalidates every
   * hash after it.
   */
  append(input: NewEntry): Entry {
    const tip = this.tip();
    // Most recent first, deduped: the tip plus the superseded entry it retires.
    // Retiring an entry links the replacement to it, so the history of a
    // decision stays connected rather than dangling.
    const parents = [...new Set([tip?.hash, input.supersedesId ? this.get(input.supersedesId)?.hash : undefined].filter(Boolean) as string[])];
    const seq = (tip?.seq ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const status = input.status ?? "active";
    const tags = [...new Set(input.tags ?? [])].sort();

    if (input.supersedesId && !this.get(input.supersedesId)) {
      throw new Error(`SUPERSEDE_TARGET_NOT_FOUND: ${input.supersedesId}`);
    }

    const material: Record<string, unknown> = {
      // NOTE: `seq` is deliberately excluded. It is *local* ordering, assigned by
      // whichever node stored the entry, so it cannot participate in a hash that
      // must reproduce identically on every peer. Integrity comes from the
      // content hash and the parent set; seq is only a local index.
      kind: input.kind, title: input.title, body: input.body, status,
      scope: input.scope, tags, authorId: input.authorId, createdAt,
      parents, supersedesId: input.supersedesId, data: input.data,
    };
    const entryId = `ctx_${sha256(canonical(material)).slice(0, 16)}`;
    const hash = hashEntry({ ...material, entryId });

    // Entries are immutable. A supersede does NOT mutate the old row: doing so
    // would change content covered by that entry's own hash and break the chain.
    // "superseded" is derived at read time from the existence of an entry that
    // points at this one, which keeps history genuinely append-only.
    this.db.prepare(
      `INSERT INTO entries
         (entry_id, kind, title, body, status, scope, tags, author_id, created_at, parents, hash, supersedes_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId, input.kind, input.title, input.body, status, input.scope,
      JSON.stringify(tags), input.authorId, createdAt, JSON.stringify(parents), hash,
      input.supersedesId ?? null,
      input.data ? JSON.stringify(input.data) : null,
    );
    return { ...material, seq, entryId, hash } as unknown as Entry;
  }

  // ------------------------------------------------------------------ audit

  /**
   * Recompute the whole history.
   *
   * Two independent checks:
   *  1. the content-addressed entryId and the content hash must both still match;
   *  2. every parent hash must resolve to an entry that exists in this log.
   *
   * Check 2 is a set-membership test, not a linear-predecessor test, so two
   * entries written concurrently from the same state are valid rather than
   * being reported as a broken chain. What it does catch is a dangling
   * reference: content claiming a history this log cannot produce.
   */
  verify(): AuditResult {
    const rows = this.db.prepare("SELECT * FROM entries ORDER BY seq ASC").all() as Record<string, unknown>[];
    const known = new Set(rows.map((r) => String(r.hash)));
    let tipHash = GENESIS;
    let expectedSeq = 1;

    for (const row of rows) {
      const entry = this.rowToEntry(row);
      if (entry.seq !== expectedSeq) {
        return { ok: false, checked: expectedSeq - 1, brokenAtSeq: entry.seq, brokenReason: `SEQ_GAP: expected ${expectedSeq}, found ${entry.seq}`, tipHash };
      }
      // The entryId is content-addressed and was handed to peers, so it is an
      // independent commitment. Without this a forger could rewrite an entry,
      // recompute its hash, and leave the log internally consistent.
      const failure = integrityFailure(entry);
      if (failure) {
        return { ok: false, checked: expectedSeq - 1, brokenAtSeq: entry.seq, brokenReason: failure, tipHash };
      }
      for (const parent of entry.parents) {
        if (!known.has(parent)) {
          return { ok: false, checked: expectedSeq - 1, brokenAtSeq: entry.seq, brokenReason: `DANGLING_PARENT: ${entry.entryId} references history this log does not contain`, tipHash };
        }
      }
      tipHash = entry.hash;
      expectedSeq += 1;
    }
    return { ok: true, checked: rows.length, tipHash };
  }


  // ------------------------------------------------------------------- sync

  /**
   * Bundle everything after `sinceSeq` (0 = entire history). Entries go out with
   * the status they were written with, which is what their id commits to; the
   * read-time "superseded" is re-derived by each receiver.
   */
  exportBundle(sinceSeq = 0): SyncBundle {
    const tip = this.tip();
    const rows = this.db.prepare("SELECT * FROM entries WHERE seq > ? ORDER BY seq ASC").all(sinceSeq) as Record<string, unknown>[];
    return {
      fromNodeId: this.nodeId,
      highSeq: tip?.seq ?? 0,
      entries: rows.map((r) => this.rowToEntry(r)),
      actors: this.listActors(),
      tipHash: tip?.hash ?? GENESIS,
    };
  }

  /**
   * Apply a peer's bundle. Merge is idempotent and additive: an entry already
   * present (by entryId) is skipped. The local log is append-only, so we never
   * rewrite local history to "win" a conflict -- genuine divergence surfaces
   * in `conflicts` for a human to adjudicate rather than being silently resolved.
   */
  merge(bundle: SyncBundle): MergeReport {
    const report: MergeReport = { applied: 0, skipped: 0, orphaned: 0, newActors: 0, conflicts: [] };
    // Grows as we apply, so an entry referencing a sibling in the same bundle
    // is not miscounted as an orphan.
    const knownHashes = new Set(
      (this.db.prepare("SELECT hash FROM entries").all() as Record<string, unknown>[]).map((r) => String(r.hash)),
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const actor of bundle.actors ?? []) {
        if (!this.db.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(actor.actorId)) {
          this.registerActor(actor);
          report.newActors += 1;
        }
      }
      for (const incoming of bundle.entries) {
        const existing = this.get(incoming.entryId);
        if (existing) {
          if (existing.hash !== incoming.hash) {
            report.conflicts.push({
              entryId: incoming.entryId,
              reason: "HASH_DIVERGENCE: same entryId with different content",
              localHash: existing.hash, incomingHash: incoming.hash,
            });
          }
          report.skipped += 1;
          continue;
        }
        // An orphan is an entry whose ancestry we cannot account for locally.
        // With a parent *set* a concurrent fork is expected, so only genuinely
        // unknown parents count as orphaned.
        if (incoming.parents.some((p) => !knownHashes.has(p))) report.orphaned += 1;

        // Throws for content its own id or hash does not prove, which rolls
        // back the whole bundle: a peer cannot plant an entry the audit rejects.
        const status = committedStatus(incoming);

        // `seq` is local: assign the next local value rather than copying the
        // peer's, which would collide with our own autoincrement.
        this.db.prepare(
          `INSERT INTO entries
             (seq, entry_id, kind, title, body, status, scope, tags, author_id, created_at, parents, hash, supersedes_id, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          (this.tip()?.seq ?? 0) + 1,
          incoming.entryId, incoming.kind, incoming.title, incoming.body,
          status, incoming.scope, JSON.stringify(incoming.tags), incoming.authorId,
          incoming.createdAt, JSON.stringify(incoming.parents), incoming.hash, incoming.supersedesId ?? null,
          incoming.data ? JSON.stringify(incoming.data) : null,
        );
        report.applied += 1;
        knownHashes.add(incoming.hash);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return report;
  }

  /** Merge a peer then immediately re-verify local chain integrity. */
  mergeAndVerify(bundle: SyncBundle): MergeReport & { audit: AuditResult } {
    const report = this.merge(bundle);
    return { ...report, audit: this.verify() };
  }
}

function rowToActor(row: Record<string, unknown>): Actor {
  return {
    actorId: String(row.actor_id),
    kind: String(row.kind) as Actor["kind"],
    displayName: String(row.display_name),
    role: (row.role as string) ?? undefined,
    createdAt: String(row.created_at),
  };
}
