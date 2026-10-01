# Onboarding

Everything you need to work on Mitra with the team — humans and agents alike.

## 1. Get the code

```bash
git clone https://github.com/cybort360/mitra
cd mitra
git checkout feat/shared-context-mcp
```

> The repository is **private**. Ask in the team channel for access if the clone
> is rejected. There is no public URL for this.

Requires **Node 22.5 or newer** — the server uses Node's built-in `node:sqlite`,
which is what keeps it dependency-free and portable. Check with `node --version`.
If you are on an older Node, upgrading is simpler than working around it.

## 2. Join the shared context

```bash
./shared-context-mcp/setup.sh your-name
```

Pick a stable name you will keep using — `sam`, or `cline` for an agent. This
script builds the server, registers you, pulls the team's existing context, and
prints a ready-to-paste config with your absolute paths.

Expected output ends with something like:

```
context      18 entries available (18 from teammates)
start with   context_digest — 11 must-read, 1 blockers
```

## 3. Connect your agent

Paste what `setup.sh` printed into your MCP client config —
`~/.config/cline/mcp.json`, `.cursor/mcp.json`, or `.mcp.json`:

```json
{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": ["/path/to/mitra/shared-context-mcp/dist/main.js"],
      "env": {
        "SHARED_CONTEXT_DB": "/path/to/mitra/.shared-context/context.db",
        "SHARED_CONTEXT_SYNC_DIR": "/path/to/mitra/shared-context/sync",
        "SHARED_CONTEXT_NODE_ID": "your-name"
      }
    }
  }
}
```

Restart the agent. You now have 15 tools, including `context_digest`.

**Keep `SHARED_CONTEXT_NODE_ID` set.** Without it every clone invents a new
identity, and the shared folder slowly fills with bundles from machines that no
longer exist.

## 4. Tell your agent how to behave

Paste this into your agent's instructions file so it works without being asked:

```
Use the shared-context MCP server for this project.

- context_register_actor once at the start, with my stable actorId.
- context_digest before starting work in an unfamiliar area.
- context_recall before editing any file you did not write, and whenever the
  existing code surprises you.
- context_remember BEFORE non-obvious work: a decision entry stating why and
  what you rejected. Record only what you verified, never speculation.
- If you are blocked or need a decision, record it as a blocker or question
  naming who or what is needed.
- If you stop mid-task, leave a handoff entry: what is done, what is next,
  what the risk is.
- Never quietly contradict an entry you did not write. Supersede it and name
  the author.
- Run context_audit before declaring work done.
```

The tool descriptions already carry this guidance, but stating it in your agent's
instructions makes it reliable rather than advisory.

## 5. Daily loop

Context syncs through a folder committed to this repo.

```bash
# pick up what teammates recorded
node shared-context-mcp/dist/cli.js sync --db .shared-context/context.db

# share what you recorded
git add shared-context/sync && git commit -m "ctx: what changed" && git push
```

Do the `sync` **before** you rely on someone else's context. Agents running on
the same machine converge automatically within a few seconds; across machines it
happens on `git pull`.

Quick look without an agent attached:

```bash
node shared-context-mcp/dist/cli.js digest --db .shared-context/context.db --scope kernel
node shared-context-mcp/dist/cli.js list   --db .shared-context/context.db --kind blocker
```

## What to record

The bar is that a reader who was not there can trust it.

| Record | Don't record |
|---|---|
| "Reservation expiry is not enforced in the execution guard" | "expiry bug" |
| What you verified, and what you ruled out | Speculation |
| `scope: kernel`, reused consistently | `scope: misc`, `scope: stuff` |
| A blocker naming the person or decision needed | A blocker describing a symptom |

A wrong entry is worse than a missing one, because it will be believed.

## When you disagree

`context_digest` flags a topic as `contested` when two people recorded the same
decision differently. That is the system working. Do not silently pick one —
write a new `decision` that supersedes both and states the tradeoff. If it
genuinely needs a human, record a `question` naming the exact choice.

## Where things are

| Path | What |
|---|---|
| `shared-context-mcp/README.md` | Tools, guarantees, sync internals |
| `shared-context/sync/` | Committed sync bundles (how context travels) |
| `docs/ARCHITECTURE.md` | Lifecycle and layering |
| `docs/SECURITY.md` | Invariants and production gates |
| `docs/EVIDENCE.md` | What is and is not proven |
| `VERIFICATION.md` | Current verification status |

## Verify your setup

```bash
npm run typecheck && npm test && npm run build     # in the repo root
npm test && npm run build                          # in shared-context-mcp
node shared-context-mcp/dist/cli.js audit --db .shared-context/context.db
```

`audit` should report `"ok": true`. If it does not, do not trust the log — ask
in the team channel.
