/**
 * Shared Context — canonical domain types.
 *
 * Design constraints that the rest of the package depends on:
 *  - Every mutation is an append-only `Entry`. Nothing is ever updated or
 *    deleted in place; "editing" writes a new entry that supersedes an old one.
 *    This is what makes the audit log verifiable and sync conflict-free.
 *  - Every entry is content-addressed (`hash`) and chain-linked to its
 *    predecessor (`prevHash`), so tampering is detectable.
 *  - Entries carry a monotonic `seq` per store, which gives a total order and
 *    makes merges between divergent peers deterministic.
 */

export type EntryKind =
  | "decision"
  | "convention"
  | "invariant"
  | "task"
  | "finding"
  | "blocker"
  | "question"
  | "handoff"
  | "note";

export type EntryStatus = "active" | "superseded" | "resolved" | "archived";

export type ActorKind = "human" | "agent" | "service";

export interface Actor {
  actorId: string;
  kind: ActorKind;
  displayName: string;
  /** Free-form: "backend", "kernel", "infra", "design". */
  role?: string;
  createdAt: string;
}

export interface Entry {
  entryId: string;
  seq: number;
  kind: EntryKind;
  title: string;
  body: string;
  status: EntryStatus;
  /** Free-form grouping: repo path, service, epic. */
  scope: string;
  tags: string[];
  authorId: string;
  createdAt: string;
  /**
   * Hashes this entry descends from, most recent first.
   *
   * This is a parent *set*, not a single parent, because several agents write
   * concurrently: two entries created from the same state legitimately both
   * descend from the same tip. A single-parent linear chain cannot represent
   * that fork and would report valid concurrent work as tampering. The list is
   * canonicalized on write so every peer computes an identical hash.
   */
  parents: string[];
  hash: string;
  /** Entry this one supersedes/replies to. */
  supersedesId?: string;
  /** Extra structured payload (e.g. file paths, decisions detail). */
  data?: Record<string, unknown>;
}

export interface NewEntry {
  kind: EntryKind;
  title: string;
  body: string;
  scope: string;
  authorId: string;
  tags?: string[];
  status?: EntryStatus;
  supersedesId?: string;
  data?: Record<string, unknown>;
}

/** What a peer exchanges to bring another store up to date. */
export interface SyncBundle {
  fromNodeId: string;
  /** Highest seq the sender has. Receiver can compute the gap. */
  highSeq: number;
  entries: Entry[];
  actors: Actor[];
  /** Hash of the last entry, lets receiver verify continuity. */
  tipHash: string;
}

export interface MergeReport {
  applied: number;
  skipped: number;
  /** Entries whose hash chain did not connect — indicates divergence/tampering. */
  orphaned: number;
  newActors: number;
  conflicts: SyncConflict[];
}

export interface SyncConflict {
  entryId: string;
  reason: string;
  localHash: string;
  incomingHash: string;
}

export interface AuditResult {
  ok: boolean;
  checked: number;
  /** First entry that breaks the chain, if any. */
  brokenAtSeq?: number;
  brokenReason?: string;
  tipHash: string;
}

export interface RecallHit {
  entry: Entry;
  score: number;
  matchedIn: string[];
}
