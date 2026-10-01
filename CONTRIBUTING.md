# Working together on Mitra

This repo carries a **shared context server**: one auditable record of what we
are building, what we decided, and why — shared by humans and agents alike, so
nobody re-solves a settled problem or silently contradicts a colleague.

New here? Start with [ONBOARDING.md](./ONBOARDING.md).

## The short version

```bash
git clone https://github.com/cybort360/mitra && cd mitra
git checkout feat/shared-context-mcp
./shared-context-mcp/setup.sh your-name
```

That builds the server, joins you to the shared context, and prints a
ready-to-paste MCP config. Paste it into your agent and you start with the
team's existing knowledge rather than an empty head.

## What the shared context is for

Code tells you *what* it does. It does not tell you *why* it is that way, what
was already tried, or which constraint someone is quietly working around. That
is what lives here:

- **decisions** — what we chose, and what we rejected
- **conventions** — how we do things, and the files they apply to
- **invariants** — things that must stay true (these constrain all other work)
- **findings** — how the code actually behaves, usually contrary to expectation
- **blockers / questions** — what is stuck, and what we need decided
- **handoffs** — so an agent can stop and another can continue

## The loop

```
register   context_register_actor   once per session, same id forever
orient     context_digest           before unfamiliar work
recall     context_recall           before editing code you didn't write
announce   context_remember         BEFORE the work, not after
hand off   context_remember         kind=handoff, when you stop
verify     context_audit            before calling anything done
```

Full guidance, including how to disagree well, is in
[shared-context-mcp/README.md](./shared-context-mcp/README.md).

## Why it is built this way

Entries are **append-only** and **content-addressed**. Nothing is edited or
deleted; changing a claim writes a new entry that supersedes the old one, so the
reasoning survives. Every entry is hash-linked and its id is derived from its
own content, so `context_audit` detects tampering and names where the chain
first breaks.

Concurrent writers are expected rather than exceptional — several agents will
write at once — so entries form a DAG, not a single-parent chain. Merges are
additive and idempotent, which is what lets two machines converge through a
shared folder with no server and no coordination.

## Project status

Mitra 0.1 is `LOCAL_PASS` for the deterministic local kernel only. There is no
live chain settlement, no production custody, and no external integration
running. See `VERIFICATION.md` and `docs/EVIDENCE.md` for exactly what is and is
not proven — the evidence levels there are load-bearing, not decoration.

Current work is tracked in the shared context itself. Run
`context_digest` to see the live state.
