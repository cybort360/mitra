import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ContextStore } from "../src/store.js";
import { GENESIS, canonical, hashEntry, sha256 } from "../src/hash.js";
import { search, tokenize } from "../src/recall.js";
import { detectDrift, digest } from "../src/digest.js";

const fresh = () => new ContextStore({ path: ":memory:", nodeId: "n_test" });

const entry = (over: Partial<Parameters<ContextStore["append"]>[0]> = {}) => ({
  kind: "note" as const, title: "A note", body: "Body text",
  scope: "core", authorId: "agent:a", ...over,
});

describe("hashing", () => {
  it("canonicalizes key order so equivalent objects hash identically", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(sha256(canonical({ b: 1, a: 2 }))).toBe(sha256(canonical({ a: 2, b: 1 })));
  });
  it("preserves array order, which is semantically meaningful", () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it("ignores undefined values rather than hashing them", () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });
});

describe("append and chain", () => {
  let store: ContextStore;
  beforeEach(() => { store = fresh(); });

  it("gives the first entry no parents", () => {
    const e = store.append(entry());
    expect(e.seq).toBe(1);
    expect(e.parents).toEqual([]);
  });

  it("links each entry to the current tip", () => {
    const a = store.append(entry({ title: "first" }));
    const b = store.append(entry({ title: "second" }));
    expect(b.parents).toEqual([a.hash]);
    expect(b.seq).toBe(2);
  });

  it("links a superseding entry to both the tip and the entry it retires", () => {
    const a = store.append(entry({ title: "first" }));
    const b = store.append(entry({ title: "second" }));
    const c = store.append(entry({ title: "third", supersedesId: a.entryId }));
    expect(c.parents).toContain(b.hash);
    expect(c.parents).toContain(a.hash);
  });

  it("assigns distinct ids to entries with identical content in the same tick", () => {
    const a = store.append(entry());
    const b = store.append(entry());
    expect(a.entryId).not.toBe(b.entryId);
  });

  it("deduplicates and sorts tags", () => {
    const e = store.append(entry({ tags: ["b", "a", "b"] }));
    expect(e.tags).toEqual(["a", "b"]);
  });

  it("rejects superseding an entry that does not exist", () => {
    expect(() => store.append(entry({ supersedesId: "ctx_nope" }))).toThrow(/SUPERSEDE_TARGET_NOT_FOUND/);
  });

  it("marks a superseded entry instead of deleting it", () => {
    const a = store.append(entry({ title: "original" }));
    const b = store.append(entry({ title: "replacement", supersedesId: a.entryId }));
    expect(store.get(a.entryId)?.status).toBe("superseded");
    expect(store.get(b.entryId)?.status).toBe("active");
    // History is preserved for audit.
    expect(store.get(a.entryId)?.title).toBe("original");
  });

  it("never mutates the superseded row, so the chain stays verifiable", () => {
    // Regression: superseding used to UPDATE the old row's status, which is
    // covered by that entry's own hash and broke the audit trail.
    const a = store.append(entry({ title: "v1" }));
    const before = store.db.prepare("SELECT * FROM entries WHERE entry_id = ?").get(a.entryId) as Record<string, unknown>;
    store.append(entry({ title: "v2", supersedesId: a.entryId }));
    const after = store.db.prepare("SELECT * FROM entries WHERE entry_id = ?").get(a.entryId) as Record<string, unknown>;
    expect(after.hash).toBe(before.hash);
    expect(after.status).toBe(before.status);
    expect(store.verify().ok).toBe(true);
  });

  it("still filters by derived superseded status", () => {
    const a = store.append(entry({ title: "old take" }));
    store.append(entry({ title: "new take", supersedesId: a.entryId }));
    expect(store.list({ status: "superseded" }).map((e) => e.title)).toEqual(["old take"]);
    expect(store.list({ status: "active" }).map((e) => e.title)).toEqual(["new take"]);
  });
});

describe("audit", () => {
  it("passes on an untouched chain", () => {
    const store = fresh();
    store.append(entry());
    store.append(entry());
    const result = store.verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
  });

  it("passes on an empty store", () => {
    const result = fresh().verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("detects content altered directly in the database", () => {
    const store = fresh();
    store.append(entry({ title: "honest" }));
    store.append(entry({ title: "second" }));
    // Simulate tampering: rewrite history behind the store's back.
    store.db.prepare("UPDATE entries SET body = ? WHERE title = ?").run("tampered", "honest");
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenReason).toMatch(/ENTRY_ID_MISMATCH/);
  });

  it("detects a deleted entry as a sequence gap", () => {
    const store = fresh();
    store.append(entry({ title: "a" }));
    store.append(entry({ title: "b" }));
    store.append(entry({ title: "c" }));
    store.db.prepare("DELETE FROM entries WHERE seq = 2").run();
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
  });

  it("detects a re-chained forgery that still breaks the next link", () => {
    const store = fresh();
    store.append(entry({ title: "a" }));
    store.append(entry({ title: "b" }));
    // Forge entry 1: alter the body and recompute its own hash so the
    // content check passes for that row on its own...
    const row = store.db.prepare("SELECT * FROM entries WHERE seq = 1").get() as Record<string, unknown>;
    const e = store.rowToEntry(row);
    const { entryId, hash, seq: _localSeq, ...rest } = e;
    const forged = hashEntry({ ...rest, body: "forged", entryId });
    store.db.prepare("UPDATE entries SET body = ?, hash = ? WHERE seq = 1").run("forged", forged);
    // ...but entry 2 still points at the old hash, and the entryId betrays the
    // edit. Either signal alone is enough to refuse the log.
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenReason).toMatch(/ENTRY_ID_MISMATCH|PREV_HASH_MISMATCH/);
  });

  it("catches a forgery that also re-hashes the row, via the content-addressed id", () => {
    const store = fresh();
    store.append(entry({ title: "a" }));
    const row = store.db.prepare("SELECT * FROM entries WHERE seq = 1").get() as Record<string, unknown>;
    const e = store.rowToEntry(row);
    const { entryId, hash, seq: _s, ...rest } = e;
    // Forge the body AND recompute the row's own hash, so both the content-hash
    // and the prevHash linkage look consistent...
    const forged = hashEntry({ ...rest, body: "forged", entryId });
    store.db.prepare("UPDATE entries SET body = ?, hash = ? WHERE seq = 1").run("forged", forged);
    // ...but the content-addressed entryId, already handed to peers, betrays it.
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenReason).toMatch(/ENTRY_ID_MISMATCH/);
  });
});

describe("sync", () => {
  it("exports a bundle that reproduces the full chain on a fresh node", () => {
    const a = fresh();
    a.append(entry({ title: "one" }));
    a.append(entry({ title: "two" }));
    const b = fresh();
    const report = b.merge(a.exportBundle());
    expect(report.applied).toBe(2);
    expect(b.verify().ok).toBe(true);
    expect(b.list().map((e) => e.title).sort()).toEqual(["one", "two"]);
  });

  it("is idempotent: merging twice changes nothing", () => {
    const a = fresh();
    a.append(entry({ title: "one" }));
    a.append(entry({ title: "two" }));
    const b = fresh();
    b.merge(a.exportBundle());
    const second = b.merge(a.exportBundle());
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(2);
    expect(b.list({ limit: 100 })).toHaveLength(2);
  });

  it("converges two peers that each wrote independently", () => {
    const a = fresh();
    const b = fresh();
    a.append(entry({ title: "from A" }));
    b.append(entry({ title: "from B" }));
    const reportA = a.merge(b.exportBundle());
    const reportB = b.merge(a.exportBundle());
    expect(reportA.applied).toBe(1);
    expect(reportB.applied).toBe(1);
    const titlesA = a.list({ limit: 100 }).map((e) => e.title).sort();
    const titlesB = b.list({ limit: 100 }).map((e) => e.title).sort();
    expect(titlesA).toEqual(titlesB);
  });

  it("transfers actors so authorship survives the merge", () => {
    const a = fresh();
    a.registerActor({ actorId: "agent:x", kind: "agent", displayName: "X", role: "kernel" });
    a.append(entry({ authorId: "agent:x" }));
    const b = fresh();
    const report = b.merge(a.exportBundle());
    expect(report.newActors).toBe(1);
    expect(b.getActor("agent:x")?.displayName).toBe("X");
  });

  it("exports only entries after a sequence cursor", () => {
    const a = fresh();
    a.append(entry({ title: "old" }));
    a.append(entry({ title: "new" }));
    expect(a.exportBundle(1).entries).toHaveLength(1);
    expect(a.exportBundle(1).entries[0].title).toBe("new");
  });

  it("flags a forged bundle instead of silently accepting it", () => {
    const a = fresh();
    a.append(entry({ title: "real" }));
    const bundle = a.exportBundle();
    // Corrupt the payload but keep the id: the peer must report a conflict.
    bundle.entries[0] = { ...bundle.entries[0], body: "forged" };
    const local = fresh();
    local.db.prepare(
      `INSERT INTO entries (entry_id, seq, kind, title, body, status, scope, tags, author_id, created_at, parents, hash, supersedes_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(bundle.entries[0].entryId, 1, "note", "real", "local copy", "active", "core", "[]",
      "agent:a", new Date().toISOString(), "[]", "deadbeef", null, null);
    const report = local.merge(bundle);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].reason).toMatch(/HASH_DIVERGENCE/);
    expect(report.applied).toBe(0);
  });

  it("accepts two agents writing concurrently from the same state", () => {
    // Both nodes start empty and write independently, so each entry has no
    // parents. Merging must not treat this legitimate fork as tampering.
    const a = fresh();
    const b = fresh();
    a.append(entry({ title: "a1" }));
    b.append(entry({ title: "b1" }));
    const report = a.mergeAndVerify(b.exportBundle());
    expect(report.applied).toBe(1);
    expect(report.orphaned).toBe(0);
    expect(report.audit.ok).toBe(true);
    expect(a.list({ limit: 100 }).map((e) => e.title).sort()).toEqual(["a1", "b1"]);
  });

  it("counts an entry as orphaned only when its ancestry is unknown", () => {
    const a = fresh();
    a.append(entry({ title: "a1" }));
    const b = fresh();
    b.append(entry({ title: "b1" }));
    b.append(entry({ title: "b2" }));   // b2 descends from b1
    const c = fresh();
    // Merge only b2, leaving its parent b1 absent: genuine dangling ancestry.
    const report = c.merge({ ...b.exportBundle(), entries: [b.list({ limit: 10 }).find((e) => e.title === "b2")!] });
    expect(report.orphaned).toBe(1);
  });

  it("keeps the audit valid when two independently-branched peers exchange", () => {
    const a = fresh();
    const b = fresh();
    a.append(entry({ title: "from A" }));
    b.append(entry({ title: "from B" }));
    a.merge(b.exportBundle());
    b.merge(a.exportBundle());
    expect(a.verify().ok).toBe(true);
    expect(b.verify().ok).toBe(true);
  });

  it("rolls back the whole merge if any entry is invalid", () => {
    const a = fresh();
    a.append(entry({ title: "ok" }));
    const b = fresh();
    const bundle = a.exportBundle();
    bundle.entries[0] = { ...bundle.entries[0], authorId: null as unknown as string };
    // author_id is NOT NULL, so this must abort without partial application.
    expect(() => b.merge(bundle)).toThrow();
    expect(b.list({ limit: 100 })).toHaveLength(0);
  });

  it("publishes the status an entry was written with, not its read-time status", () => {
    const a = fresh();
    const old = a.append(entry({ title: "old" }));
    a.append(entry({ title: "new", supersedesId: old.entryId }));
    const published = a.exportBundle().entries.find((e) => e.entryId === old.entryId)!;
    // "superseded" is derived on read; the id commits to the written status.
    expect(published.status).toBe("active");
  });

  it("verifies on a node that first receives an entry after it was superseded", () => {
    const a = fresh();
    const old = a.append(entry({ title: "old" }));
    a.append(entry({ title: "new", supersedesId: old.entryId }));
    const b = fresh();
    b.merge(a.exportBundle());
    expect(b.verify().ok).toBe(true);
    expect(b.get(old.entryId)?.status).toBe("superseded");
  });

  it("accepts a bundle carrying the leaked superseded status from an older node", () => {
    const a = fresh();
    const old = a.append(entry({ title: "old" }));
    a.append(entry({ title: "new", supersedesId: old.entryId }));
    const bundle = a.exportBundle();
    // Older nodes published read-time status; their bundles are still on disk.
    bundle.entries = bundle.entries.map((e) => (e.entryId === old.entryId ? { ...e, status: "superseded" as const } : e));
    const b = fresh();
    const report = b.merge(bundle);
    expect(report.applied).toBe(2);
    expect(b.verify().ok).toBe(true);
    expect(b.get(old.entryId)?.status).toBe("superseded");
  });

  it("refuses a new entry whose id does not match its content", () => {
    const a = fresh();
    a.append(entry({ title: "real" }));
    const bundle = a.exportBundle();
    bundle.entries[0] = { ...bundle.entries[0], body: "forged" };
    const b = fresh();
    expect(() => b.merge(bundle)).toThrow(/ENTRY_ID_MISMATCH/);
    expect(b.list({ limit: 100 })).toHaveLength(0);
  });

  it("refuses a new entry whose hash does not match its content", () => {
    const a = fresh();
    a.append(entry({ title: "real" }));
    const bundle = a.exportBundle();
    bundle.entries[0] = { ...bundle.entries[0], hash: "f".repeat(64) };
    const b = fresh();
    expect(() => b.merge(bundle)).toThrow(/CONTENT_HASH_MISMATCH/);
    expect(b.list({ limit: 100 })).toHaveLength(0);
  });

  it("restores a row already stored with the leaked status when the store opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxstore-"));
    try {
      const path = join(dir, "context.db");
      const a = new ContextStore({ path, nodeId: "n_test" });
      const old = a.append(entry({ title: "old" }));
      a.append(entry({ title: "new", supersedesId: old.entryId }));
      // What an older node's merge left behind.
      a.db.prepare("UPDATE entries SET status = 'superseded' WHERE entry_id = ?").run(old.entryId);
      expect(a.verify().brokenReason).toMatch(/ENTRY_ID_MISMATCH/);
      a.db.close();

      const reopened = new ContextStore({ path, nodeId: "n_test" });
      expect(reopened.verify().ok).toBe(true);
      expect(reopened.get(old.entryId)?.status).toBe("superseded");
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not touch a row whose content was genuinely altered", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxstore-"));
    try {
      const path = join(dir, "context.db");
      const a = new ContextStore({ path, nodeId: "n_test" });
      const e = a.append(entry({ title: "real" }));
      a.db.prepare("UPDATE entries SET body = 'tampered', status = 'superseded' WHERE entry_id = ?").run(e.entryId);
      a.db.close();

      const reopened = new ContextStore({ path, nodeId: "n_test" });
      expect(reopened.verify().ok).toBe(false);
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
