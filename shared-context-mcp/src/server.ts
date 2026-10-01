import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContextStore } from "./store.js";
import { search } from "./recall.js";
import { detectDrift, digest } from "./digest.js";
import { SyncAgent } from "./sync.js";
import type { Entry, EntryKind } from "./types.js";

export const DEFAULT_DB = process.env.SHARED_CONTEXT_DB ?? ".shared-context/context.db";

const KINDS = ["decision", "convention", "invariant", "task", "finding", "blocker", "question", "handoff", "note"] as const;

/** Build a server bound to a store. Exported so tests can drive it in-process. */
export function createServer(store: ContextStore, sync?: SyncAgent) {
  const server = new McpServer({ name: "shared-context", version: "0.1.0" });

  const ok = (payload: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });
  // Errors return as data, not thrown, so a calling agent can read the reason
  // and correct itself instead of seeing an opaque protocol error.
  const fail = (reason: string, detail?: unknown) => ({
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: reason, detail }, null, 2) }],
  });
  const run = (fn: () => unknown) => {
    try {
      return ok(fn());
    } catch (err) {
      return fail(err instanceof Error ? err.message : "UNKNOWN_ERROR", String(err));
    }
  };

  // ------------------------------------------------------------ pass / store

  server.registerTool("context_remember", {
    title: "Remember something for the team",
    description:
      "Append a durable entry to shared context. Entries are immutable and auditable; to change " +
      "an earlier claim pass supersedesId rather than editing.\n\n" +
      "WHEN TO CALL — do this BEFORE you start non-obvious work, not at the end:\n" +
      "  - You are about to change behaviour others depend on -> kind=decision, body states why " +
      "and what you rejected.\n" +
      "  - You learned how this codebase actually works -> kind=finding.\n" +
      "  - You are stuck or waiting on someone -> kind=blocker, name who is needed.\n" +
      "  - You need an answer you cannot get yourself -> kind=question.\n" +
      "  - You are stopping so someone else can continue -> kind=handoff, stating exactly what " +
      "is done, what is next, and the risk.\n\n" +
      "WHAT NOT TO WRITE: things the code or git already says (file contents, commit messages, " +
      "test names), anything you have not verified, and speculation. A wrong entry costs every " +
      "reader who trusts it — supersede it loudly if you were wrong.\n\n" +
      "TITLE RULE: state the fact, not the topic. 'Reservation expiry is not enforced in the " +
      "execution guard' beats 'expiry bug'. You will search these later.",
    inputSchema: {
      kind: z.enum(KINDS),
      title: z.string().min(3).describe("Short, searchable, stated as a fact. 'X is Y', not 'X stuff'."),
      body: z.string().describe("Why, what you tried, what you rejected, what would change your mind."),
      scope: z.string().describe("Stable grouping key. Reuse an existing one (e.g. 'kernel', 'ui', 'infra') so scoped digests work."),
      authorId: z.string().describe("Your actor id; register with context_register_actor first."),
      tags: z.array(z.string()).optional(),
      supersedesId: z.string().optional().describe("Entry this replaces. The old one is marked superseded, never deleted."),
      data: z.record(z.string(), z.unknown()).optional().describe("Structured payload, e.g. { files: [...] }."),
    },
  }, async (args) => run(() => {
    const entry = store.append(args as Parameters<ContextStore["append"]>[0]);
    sync?.touch(); // publish to peers on the next tick
    return { entryId: entry.entryId, seq: entry.seq, hash: entry.hash, status: entry.status };
  }));

  server.registerTool("context_supersede", {
    title: "Replace an earlier entry",
    description:
      "Write a new entry superseding an existing one. The original is preserved and marked " +
      "superseded, so the decision history stays auditable. Use this instead of editing.\n\n" +
      "WHEN TO CALL — when you were wrong, or the world changed. Say plainly in the body what " +
      "changed and why; a silent replacement destroys the record of why the original choice was " +
      "made, which is usually the most valuable part.\n\n" +
      "Never quietly contradict an entry you did not write. Supersede it and name the author.",
    inputSchema: {
      supersedesId: z.string(),
      kind: z.enum(KINDS),
      title: z.string().min(3),
      body: z.string(),
      scope: z.string(),
      authorId: z.string(),
      tags: z.array(z.string()).optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (args) => run(() => {
    const { supersedesId, ...rest } = args;
    const entry = store.append({ ...rest, supersedesId } as Parameters<ContextStore["append"]>[0]);
    sync?.touch();
    return { entryId: entry.entryId, superseded: supersedesId, seq: entry.seq };
  }));

  // --------------------------------------------------------- retrieve / recall

  server.registerTool("context_recall", {
    title: "Search shared context",
    description:
      "Ranked keyword search across titles, tags, scope, body and structured data.\n\n" +
      "WHEN TO CALL — this is the most important habit here:\n" +
      "  - Before editing any file you did not write. Someone may have already learned why it " +
      "looks wrong.\n" +
      "  - Whenever existing code surprises you. The surprise is the signal; the explanation is " +
      "usually already recorded as a decision or finding.\n" +
      "  - Before proposing an approach, to check whether it was already considered and rejected.\n\n" +
      "Search by SUBSTANCE not by exact words: 'reservation expiry', 'vault capital', 'why is " +
      "time injected'. Superseded entries are demoted, not hidden, so a changed decision still " +
      "shows up with its history.",
    inputSchema: {
      query: z.string().min(2),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async ({ query, scope, limit }) => run(() => {
    const pool = store.list({ scope, limit: 500 });
    return search(pool, query, limit ?? 10).map((h) => ({
      entryId: h.entry.entryId, kind: h.entry.kind, title: h.entry.title, body: h.entry.body,
      scope: h.entry.scope, status: h.entry.status, authorId: h.entry.authorId,
      createdAt: h.entry.createdAt, score: h.score, matchedIn: h.matchedIn,
    }));
  }));

  server.registerTool("context_get", {
    title: "Get one entry by id",
    description: "Fetch a single entry including its hash-chain position and supersedes link.",
    inputSchema: { entryId: z.string() },
  }, async ({ entryId }) => run(() => {
    const entry = store.get(entryId);
    if (!entry) throw new Error(`NOT_FOUND: ${entryId}`);
    return entry;
  }));

  server.registerTool("context_list", {
    title: "List entries",
    description: "List entries filtered by scope, kind, status or author.",
    inputSchema: {
      scope: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      status: z.enum(["active", "superseded", "resolved", "archived"]).optional(),
      authorId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async (args) => run(() => store.list(args).map(slimEntry)));


  // ------------------------------------------------------------- comprehend

  server.registerTool("context_digest", {
    title: "Get oriented in a scope",
    description:
      "One-call onboarding for a scope: what it contains, who contributed, the invariants and " +
      "decisions to read first, open questions and blockers, and any topic where several people " +
      "recorded competing decisions.\n\n" +
      "WHEN TO CALL — first thing, before touching unfamiliar work. It is the cheapest way to " +
      "avoid re-solving a problem or contradicting a decision someone already made.\n\n" +
      "Read `mustRead` properly: invariants are constraints that must keep holding, decisions " +
      "were deliberate and supersede guesswork. Check `contested` before assuming consensus — " +
      "that is exactly where you and a colleague are about to disagree.",
    inputSchema: { scope: z.string().optional().describe("Omit for all scopes. Prefer a specific one when focused.") },
  }, async ({ scope }) => run(() => {
    const d = digest(store.list({ limit: 1000 }), store.listActors(), scope ?? "all");
    return {
      scope: d.scope, total: d.total, byKind: d.byKind, contributors: d.contributors,
      mustRead: d.mustRead.map(slimEntry), openQuestions: d.openQuestions.map(slimEntry),
      blockers: d.blockers.map(slimEntry), recentDecisions: d.recentDecisions.map(slimEntry),
      contested: d.contested,
    };
  }));

  server.registerTool("context_check_drift", {
    title: "Check conventions against the working tree",
    description:
      "Verify that active conventions still hold by testing the files each convention " +
      "references. Conventions carrying a data.files array are checked on disk; returns a " +
      "gap per missing file. Catches the team agreeing on something nobody implemented.",
    inputSchema: { root: z.string().optional().describe("Repo root to resolve files against.") },
  }, async ({ root }) => run(() => {
    const base = root ?? process.cwd();
    return detectDrift(store.list({ kind: "convention", status: "active", limit: 500 }), (rel) => {
      try {
        readFileSync(`${base}/${rel}`, "utf8");
        return null; // exists and is fine
      } catch {
        return false; // explicitly missing
      }
    });
  }));

  // ------------------------------------------------------------------ audit

  server.registerTool("context_audit", {
    title: "Verify the integrity of the context log",
    description:
      "Recompute the hash chain across every entry. Detects altered content, broken links and " +
      "sequence gaps. Returns where the chain first breaks, so tampering can be located exactly.",
    inputSchema: {},
  }, async () => run(() => {
    const audit = store.verify();
    return { ...audit, nodeId: store.nodeId, entryCount: store.list({ limit: 100000 }).length };
  }));

  // ------------------------------------------------------------------- sync

  server.registerTool("context_export", {
    title: "Export context for a peer",
    description:
      "Produce a portable bundle of entries to hand to another node. Pass sinceSeq to send " +
      "only what a peer is missing. Output is JSON suitable for context_merge or for storage " +
      "in a shared repo directory.",
    inputSchema: { sinceSeq: z.number().int().min(0).optional() },
  }, async ({ sinceSeq }) => run(() => store.exportBundle(sinceSeq ?? 0)));

  server.registerTool("context_merge", {
    title: "Merge a peer's context bundle",
    description:
      "Apply a bundle from another node. Idempotent and additive: entries already held are " +
      "skipped, and the local log is never rewritten. Genuine divergence is returned in " +
      "conflicts for a human to resolve rather than being silently resolved. Returns a " +
      "post-merge integrity check.",
    inputSchema: { bundle: z.unknown().describe("A bundle produced by context_export.") },
  }, async ({ bundle }) => run(() => store.mergeAndVerify(bundle as Parameters<ContextStore["merge"]>[0])));

  server.registerTool("context_compare_bundle", {
    title: "Compare local context against a peer's bundle",
    description:
      "Dry-run: report how many entries a peer is missing and how many you are missing, " +
      "without writing anything. With background auto-sync enabled you rarely need this; " +
      "it is for inspecting a bundle you were handed by other means.",
    inputSchema: { bundle: z.unknown() },
  }, async ({ bundle }) => run(() => {
    const b = bundle as Parameters<ContextStore["merge"]>[0];
    const localIds = new Set(store.list({ limit: 100000 }).map((e) => e.entryId));
    const remoteIds = new Set((b.entries ?? []).map((e: Entry) => e.entryId));
    const missingLocally = [...remoteIds].filter((id) => !localIds.has(id));
    const missingRemotely = [...localIds].filter((id) => !remoteIds.has(id));
    return {
      peer: b.fromNodeId, localEntries: localIds.size, remoteEntries: remoteIds.size,
      missingLocally: missingLocally.length, missingRemotely: missingRemotely.length,
      inSync: missingLocally.length === 0 && missingRemotely.length === 0,
    };
  }));

  server.registerTool("context_sync_status", {
    title: "Check background auto-sync",
    description:
      "Report whether background sync is running, which peers have been merged, and how many " +
      "entries/conflicts have flowed. Use this to confirm the team is actually sharing context " +
      "rather than assuming it. If auto-sync is off, set SHARED_CONTEXT_SYNC_DIR and restart.",
    inputSchema: { force: z.boolean().optional().describe("Run a sync cycle immediately.") },
  }, async ({ force }) => run(() => {
    if (!sync) {
      return { enabled: false, hint: "Set SHARED_CONTEXT_SYNC_DIR to a shared folder and restart the server to enable auto-sync." };
    }
    if (force) sync.tick();
    return { ...sync.getStatus(), localEntries: store.list({ limit: 100000 }).length, nodeId: store.nodeId };
  }));

  server.registerTool("context_sync_now", {
    title: "Sync with peers right now",
    description:
      "Force an immediate publish-and-import cycle instead of waiting for the next tick. " +
      "Call this before relying on context you expect a collaborator to have just written.",
    inputSchema: {},
  }, async () => run(() => {
    if (!sync) return { enabled: false, hint: "Set SHARED_CONTEXT_SYNC_DIR and restart the server." };
    const before = store.list({ limit: 100000 }).length;
    sync.tick();
    return { ...sync.getStatus(), entriesBefore: before, entriesAfter: store.list({ limit: 100000 }).length };
  }));

  // ------------------------------------------------------------------ actors

  server.registerTool("context_register_actor", {
    title: "Register yourself or a collaborator",
    description:
      "Register an actor so entries are attributed. Do this ONCE per session, before any other " +
      "tool, and reuse the same actorId forever so authorship stays consistent across sessions, " +
      "machines and restarts.\n\n" +
      "ID CONVENTION: prefix by kind so the digest reads clearly — 'agent:<name>' (e.g. " +
      "'agent:cline'), 'human:<name>' (e.g. 'human:sam'), 'service:<name>'. Reuse the SAME id " +
      "rather than making a new one per session, otherwise context looks like it came from a " +
      "crowd of one-off strangers.\n\n" +
      "Set `role` to the area you actually work in (e.g. 'kernel', 'ui', 'infra'). It is how " +
      "others know who to ask.",
    inputSchema: {
      actorId: z.string().min(2).describe("Stable id, e.g. 'agent:cline' or 'human:sam'."),
      kind: z.enum(["human", "agent", "service"]),
      displayName: z.string(),
      role: z.string().optional().describe("Area of the codebase or responsibility."),
    },
  }, async (args) => run(() => store.registerActor(args)));

  server.registerTool("context_who", {
    title: "List collaborators",
    description: "Every actor known to this node, human and agent alike, with their roles.",
    inputSchema: {},
  }, async () => run(() => store.listActors()));

  return { server, store };
}

function slimEntry(e: Entry) {
  return {
    entryId: e.entryId, seq: e.seq, kind: e.kind, title: e.title, scope: e.scope,
    status: e.status, authorId: e.authorId, createdAt: e.createdAt, tags: e.tags,
  };
}
