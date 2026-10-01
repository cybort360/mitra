# Shared Context MCP Server

Shared, auditable memory for humans, agents and partners working on the same
codebase. One local MCP server gives every collaborator a common, verifiable
record of what we are building and why.

The problem it solves: when several agents and people work across parts of a
repo, decisions live in chat logs, stale READMEs and each agent's private
context window. This makes them a queryable, tamper-evident log instead.

## Design

Three properties drive every decision here.

**Append-only.** Nothing is ever updated or deleted. "Editing" writes a new entry
that supersedes an old one, so the history of a decision is always recoverable.

**Content-addressed and verifiable.** Every entry gets an id derived from its own
content, plus a hash, plus the set of parent hashes it descends from. `context_audit`
recomputes all of it. Because the id was already handed to peers, altering an
entry's content breaks the id even if an attacker also recomputes the hash.

**Merge, don't fight.** Concurrent writers are expected, not exceptional. Entries
form a DAG rather than a single-parent chain, so two agents writing from the same
state is valid rather than being reported as tampering. Merges are additive and
idempotent; genuine divergence is surfaced for a human instead of being silently
resolved.

## Tools

| Tool | Purpose |
|---|---|
| `context_register_actor` | Register yourself (human or agent) so entries are attributed |
| `context_remember` | Append a decision, convention, invariant, task, finding, blocker, question or handoff |
| `context_supersede` | Replace an earlier entry; the original is preserved and marked superseded |
| `context_recall` | Ranked keyword search across titles, tags, scope, body and structured data |
| `context_get` | Fetch one entry with its hash-chain position |
| `context_list` | Filter by scope, kind, status or author |
| `context_digest` | One-call onboarding: must-read, blockers, open questions, contributors, contested topics |
| `context_check_drift` | Check that conventions still hold against the working tree |
| `context_audit` | Recompute the hash chain; reports where it first breaks |
| `context_export` | Produce a bundle for a peer |
| `context_merge` | Apply a peer's bundle, then re-verify |
| `context_sync_status` | Report background auto-sync health and peers seen |
| `context_sync_now` | Force an immediate publish/import cycle |
| `context_compare_bundle` | Dry-run diff against a bundle, without writing |
| `context_who` | List collaborators |

## Connect an agent

The server speaks MCP over stdio. Add this to your agent's MCP config
(`~/.config/cline/mcp.json`, `.cursor/mcp.json`, `.mcp.json`, etc.):

```json
{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/shared-context-mcp/dist/main.js"],
      "env": {
        "SHARED_CONTEXT_DB": "/ABSOLUTE/PATH/TO/.shared-context/context.db",
        "SHARED_CONTEXT_SYNC_DIR": "/ABSOLUTE/PATH/TO/shared-context-sync",
        "SHARED_CONTEXT_SYNC_INTERVAL_MS": "3000"
      }
    }
  }
}
```

`SHARED_CONTEXT_SYNC_DIR` is what makes it a *team* memory rather than a private
one: point every participant at the same folder (git repo, Dropbox, Google
Drive, NFS, a shared VM) and they converge automatically. Omit it and the server
still works, but peers must exchange bundles by hand.

There is no URL to hand out — MCP stdio servers are launched locally by the
client. What you share is the **config block above** plus the sync folder.

### Give a partner a 60-second setup

```bash
git clone <repo> && cd shared-context-mcp && npm install && npm run build
node dist/cli.js init --db ./ctx.db --sync-dir /path/to/shared/folder
```

Then paste the config block with your paths. Done.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SHARED_CONTEXT_DB` | `.shared-context/context.db` | Local sqlite log (never share this file directly) |
| `SHARED_CONTEXT_SYNC_DIR` | *(unset)* | Shared folder; enables background auto-sync |
| `SHARED_CONTEXT_SYNC_INTERVAL_MS` | `3000` | Poll interval |

## CLI

Useful for inspecting and seeding without an agent attached.

```bash
node dist/cli.js init   --db ./ctx.db --sync-dir ./shared
node dist/cli.js audit  --db ./ctx.db
node dist/cli.js digest --db ./ctx.db [--scope kernel]
node dist/cli.js list   --db ./ctx.db [--kind blocker] [--limit 20]
node dist/cli.js say    --db ./ctx.db --kind decision --title "..." --body "..." --author agent:x --scope kernel
node dist/cli.js sync   --db ./ctx.db --sync-dir ./shared
node dist/cli.js watch  --db ./ctx.db --sync-dir ./shared
```

Cost is one small JSON file per node, rewritten only when something changed.

Each node writes its whole log to `ctxbundle-<nodeId>.json` in the shared folder,
written atomically (temp file plus rename) so a peer polling at the wrong instant
never reads a half-written document. Every node polls the folder, merges bundles
whose contents it has not seen, and republishes if its own view changed — which
is what propagates context transitively, so a node that never meets another node
directly still converges through a shared peer.

## Sharing across machines (git)

The sync folder is committed to the repository at `shared-context/sync/`. A
fresh clone therefore arrives with the team's existing context already in it —
no setup step to import anything.

Each participant sets a **stable node id** so they own exactly one bundle:

```json
"env": {
  "SHARED_CONTEXT_DB": "/path/to/repo/.shared-context/context.db",
  "SHARED_CONTEXT_SYNC_DIR": "/path/to/repo/shared-context/sync",
  "SHARED_CONTEXT_NODE_ID": "your-name"
}
```

Without `SHARED_CONTEXT_NODE_ID` every clone mints a new random id and slowly
fills the folder with bundles from nodes that no longer exist.

The git workflow is deliberately plain:

```bash
# after recording context
node shared-context-mcp/dist/cli.js sync --db .shared-context/context.db
git add shared-context/sync && git commit -m "ctx: <what changed>"
git push

# before relying on a collaborator's context
git pull
node shared-context-mcp/dist/cli.js sync --db .shared-context/context.db
```

The CLI auto-detects `shared-context/sync` by walking up from the database, so
`sync` and `say` work with no `--sync-dir` flag in a normal clone.

Two things to know: the local sqlite log is gitignored (it is machine-specific),
and merge conflicts between bundles are surfaced rather than auto-resolved — run
`context_audit` and write a superseding entry if you see any.

## Working agreement

### The loop

```
1. register   context_register_actor   once per session, same id forever
2. orient     context_digest           before unfamiliar work
3. recall     context_recall           before editing code you did not write
4. announce   context_remember         BEFORE the work, not after
5. hand off   context_remember         kind=handoff, when you stop
6. verify     context_audit            before calling anything done
```

### What each side owes the other

**Before you start:** read the scope. If `mustRead` contains an invariant, that is a
constraint — your change must keep it true. If it contains a decision, the reasoning
is already settled; changing it means superseding, not improvising.

**Before you edit someone else's file:** search first. The code looking wrong is
usually a decision you cannot see from the code itself.

**While you work:** record intent *before* the change, not the summary after. The
"why" is the only part a future reader cannot reconstruct from the diff.

**When you are wrong or blocked:** say so loudly. A blocker naming a person is
actionable; a blocker describing a symptom is not. Never leave a silent
contradiction of someone else's entry — supersede it and name the author.

**When you stop mid-task:** leave a `handoff` stating what is done, what is next,
and the risk. This is what lets another agent continue without re-deriving your
reasoning. A stopped agent with no handoff is the most expensive failure mode
here — worse than one that never started.

### Writing well

| Do | Don't |
|---|---|
| "Reservation expiry is not enforced in the execution guard" | "expiry bug" |
| Record what you verified | Record what you suspect |
| `scope: kernel` reused consistently | `scope: misc`, `scope: stuff` |
| State what you rejected and why | State only what you chose |
| Reuse your `actorId` forever | New id per session |

Keep the volume sane. Context is only useful while it is trustworthy, and every
entry you add is something someone else must read. A wrong entry is worse than a
missing one, because it will be believed.

### Resolving disagreement

Two people recorded the same decision differently — `context_digest` flags this as
`contested`. That is the tool working, not failing. Do not silently pick one. Write
a new `decision` that supersedes both, stating the tradeoff, so the reasoning
survives. If it genuinely needs a human, make it a `question` naming the choice.

### For humans

The same tools work from the shell:

```bash
node dist/cli.js digest --db ./ctx.db --scope kernel   # what you need to know
node dist/cli.js list   --db ./ctx.db --kind blocker   # what's stuck
node dist/cli.js say    --db ./ctx.db --kind decision \
  --title "..." --body "..." --author human:sam --scope kernel
```

## Verify

```bash
npm run typecheck
npm test        # 47 tests
npm run build
```

## Entry kinds

`decision` · `convention` · `invariant` · `task` · `finding` · `blocker` ·
`question` · `handoff` · `note`

`invariant` entries are reserved for things that must always hold; they are ranked
first in `context_digest` because they constrain everything else.

## Limitations

- Bundles are exchanged explicitly; there is no background network sync.
- `context_check_drift` only understands conventions carrying a `data.files` array.
- Search is lexical (BM25-style), not semantic. Deterministic and dependency-free
  by design; a vector index would be the next step for very large stores.
- SQLite with WAL is suited to one host. Concurrent writers on a network
  filesystem are not a supported topology.
