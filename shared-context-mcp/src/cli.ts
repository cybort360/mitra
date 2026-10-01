#!/usr/bin/env node
/**
 * Operator CLI. Useful for inspecting and seeding context from a shell, and for
 * setting up a node without an MCP client attached.
 *
 *   shared-context init    --db ./ctx.db --sync-dir ./shared
 *   shared-context audit   --db ./ctx.db
 *   shared-context digest  --db ./ctx.db [--scope kernel]
 *   shared-context say     --db ./ctx.db --kind decision --title "..." --body "..." --author agent:x --scope kernel
 *   shared-context sync    --db ./ctx.db --sync-dir ./shared
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ContextStore } from "./store.js";
import { SyncAgent } from "./sync.js";
import { digest } from "./digest.js";
import type { EntryKind } from "./types.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const has = (name: string) => argv.includes(`--${name}`);

const dbPath = flag("db", process.env.SHARED_CONTEXT_DB ?? ".shared-context/context.db")!;
// Default to the repo's committed `shared-context/sync` folder. Walking up from
// the database handles both layouts: <repo>/.shared-context/context.db (the
// usual one) and a database kept elsewhere. In the git-shared setup this means a
// bare `say` is enough to share an entry — the easiest thing to get wrong.
const syncDir = flag("sync-dir", process.env.SHARED_CONTEXT_SYNC_DIR ?? defaultSyncDir(dbPath));

/** Locate `shared-context/sync` by walking up from the database file. */
function defaultSyncDir(db: string): string {
  let dir = resolve(dirname(resolve(db)));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, "shared-context", "sync");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(resolve(db)), "..", "sync");
}
const nodeId = flag("node", process.env.SHARED_CONTEXT_NODE_ID);

function open(): ContextStore {
  return new ContextStore({ path: dbPath, ...(nodeId ? { nodeId } : {}) });
}

const usage = `shared-context <command> [options]

Commands:
  init      Create the store (and shared folder) and print connection details
  audit     Verify the hash chain
  digest    Onboarding summary, optionally scoped
  list      List entries
  say       Append an entry
  sync      Run one publish/import cycle against --sync-dir
  watch     Run auto-sync in the foreground until interrupted

Options:
  --db <path>          sqlite file (default $SHARED_CONTEXT_DB or .shared-context/context.db)
  --sync-dir <path>    shared folder (default: ../sync beside the db, or $SHARED_CONTEXT_SYNC_DIR)
  --kind, --title, --body, --author, --scope, --tags (comma-separated), --supersedes
  --limit <n>          for list
`;

switch (command) {
  case "init": {
    const store = open();
    const a = store.verify();
    console.log(`store ready  node=${store.nodeId}  db=${dbPath}`);
    console.log(`audit        ok=${a.ok} entries=${a.checked}`);

    // Onboarding should leave you informed, not empty: publish our (possibly
    // empty) bundle, then import whatever the team already has.
    const agent = new SyncAgent({ store, dir: syncDir! });
    agent.publish();
    const applied = agent.importPeers().reduce((n, r) => n + r.applied, 0);
    const total = store.list({ limit: 100000 }).length;
    console.log(`sync dir     ${syncDir}`);
    console.log(`context      ${total} entries available${applied > 0 ? ` (${applied} from teammates)` : ""}`);
    if (total > 0) {
      const d = digest(store.list({ limit: 1000 }), store.listActors(), "all");
      console.log(`start with   context_digest — ${d.mustRead.length} must-read, ${d.blockers.length} blockers`);
    }
    store.close();
    break;
  }
  case "audit": {
    const store = open();
    const a = store.verify();
    console.log(JSON.stringify({ ...a, nodeId: store.nodeId }, null, 2));
    store.close();
    if (!a.ok) process.exit(1);
    break;
  }
  case "digest": {
    const store = open();
    const d = digest(store.list({ limit: 1000 }), store.listActors(), flag("scope", "all")!);
    console.log(`scope: ${d.scope}  entries: ${d.total}`);
    console.log("\nmust read:");
    for (const e of d.mustRead) console.log(`  [${e.kind}] ${e.title}`);
    if (d.blockers.length) {
      console.log("\nblockers:");
      for (const e of d.blockers) console.log(`  ${e.title}`);
    }
    if (d.openQuestions.length) {
      console.log("\nopen questions:");
      for (const e of d.openQuestions) console.log(`  ${e.title}`);
    }
    if (d.contested.length) {
      console.log("\ncontested (multiple authors, same topic):");
      for (const c of d.contested) console.log(`  ${c.title} — ${c.authors.join(", ")}`);
    }
    store.close();
    break;
  }
  case "list": {
    const store = open();
    for (const e of store.list({ scope: flag("scope"), kind: flag("kind"), limit: Number(flag("limit", "20")) })) {
      console.log(`${String(e.seq).padStart(3)} [${e.kind}] ${e.title}  (${e.status})`);
    }
    store.close();
    break;
  }
  case "say": {
    const store = open();
    const title = flag("title");
    if (!title) { console.error("--title is required"); process.exit(1); }
    const entry = store.append({
      kind: (flag("kind", "note") as EntryKind),
      title: title!,
      body: flag("body", "")!,
      scope: flag("scope", "general")!,
      authorId: flag("author", "human:cli")!,
      tags: flag("tags")?.split(",").map((t) => t.trim()).filter(Boolean),
      supersedesId: flag("supersedes"),
    });
    // Publish so collaborators see the entry without a second command. Falls
    // back to a `sync/` folder beside the database, which is the committed
    // location in a git-shared setup.
    if (syncDir) new SyncAgent({ store, dir: syncDir }).publish();
    console.log(`${entry.entryId}  seq=${entry.seq}  hash=${entry.hash.slice(0, 12)}`);
    store.close();
    break;
  }
  case "sync": {
    const store = open();
    const agent = new SyncAgent({ store, dir: syncDir! });
    agent.publish();
    const reports = agent.importPeers();
    const total = reports.reduce((n, r) => n + r.applied, 0);
    console.log(`published ${store.list({ limit: 100000 }).length} entries; applied ${total} from peers`);
    for (const r of reports) {
      if (r.applied || r.conflicts.length) {
        console.log(`  ${r.applied} applied, ${r.skipped} skipped, ${r.orphaned} orphaned, ${r.conflicts.length} conflicts`);
      }
    }
    const a = store.verify();
    console.log(`audit ok=${a.ok} entries=${a.checked}`);
    store.close();
    break;
  }
  case "watch": {
    const store = open();
    const agent = new SyncAgent({ store, dir: syncDir!, intervalMs: Number(flag("interval", "3000")) });
    agent.start();
    console.log(`watching ${syncDir} every ${flag("interval", "3000")}ms — ctrl-c to stop`);
    await new Promise(() => {}); // run until interrupted
    break;
  }
  default:
    console.log(usage);
}
