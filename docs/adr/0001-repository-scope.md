# 0001. Keep development instrumentation in the product repository

**Status:** Accepted

## Context

`shared-context-mcp/` is a collaboration server: a 15-tool MCP server with a
sqlite-backed, tamper-evident shared log. It is not part of Mitra. The PRD never
mentions it, no product code imports it, and `next build` never touches it.

The instinct was to extract it to its own repository so the product repo contains
only what the specification describes. That was proposed, and it was wrong on the
merits.

## Decision

It stays, labelled. Three labels: the package README, `CONTRIBUTING.md` (two
directories that are not the product, safe to ignore), and `ONBOARDING.md`.

## Consequences

- A customer cloning Mitra gets a directory they can ignore, rather than a second
  repository to be granted access to and keep alive.
- The label carries the load-bearing sentence: **it holds notes, not authority.**
  It cannot move capital and is not part of the economic path. Without that, a
  reader could mistake a collaboration tool for a control.
- Reconsider if the server ever serves multiple projects. Then a shared
  infrastructure component genuinely belongs outside any single product — but
  that is a future fact, not the present one.
