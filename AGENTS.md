# AGENTS.md — read this first

This repository is under the **FORGE 1.4** control plane. The map lives in [`forge/`](forge/).

## Ground rules (non-negotiable)

- **Repository files are the source of truth.** Prior chat summaries, transcripts, and memories are
  *not* authoritative — when they disagree with the code or the `forge/` docs, the code wins.
- **Do not mark a claim `LIVE_DEMONSTRATED` without a named substrate, a date, and
  executed evidence.** "The code exists" is not evidence.

  Every claim carries **two** fields, not one — see `forge/standards/BUILD_FOUNDRY.md` §2:

  | Field | Permitted values |
  |---|---|
  | `evidence` | `PROPOSED` · `IMPLEMENTED` · `TESTED` · `INTEGRATED` · `E2E_VERIFIED` · `LIVE_DEMONSTRATED` · `LIVE` · `MONITORED` |
  | `blocker` | `PARTIAL` · `BLOCKED_EXTERNAL` · `BLOCKED_INTERNAL` · `DEFERRED` · `REJECTED` · `FAILED` · `REGRESSED` · `—` |

  Read as `evidence: LIVE_DEMONSTRATED, blocker: —`. A single flat status cannot
  express "reached `E2E_VERIFIED`, but the remainder is blocked internally", and
  BUILD_FOUNDRY's own rule — *"claims must never use evidence from a lower state
  to imply a higher one"* — requires both halves to be writable.

  Coherence rules:
  1. `blocker` is required whenever `evidence` is below `LIVE_DEMONSTRATED`, and
     must be `—` when it is not.
  2. `BLOCKED_EXTERNAL` and `BLOCKED_INTERNAL` name the exact dependency or
     repository defect. "Blocked" without a named cause is not a blocker.
  3. `DEFERRED` and `REJECTED` record who decided and why. `FAILED` and
     `REGRESSED` name the test that caught it.

  Record the command that produced the evidence in [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md).
- **Do not weaken a test to make it pass.** Fix the code or record the failure.
- **Do not introduce a mock/fake success path into production code.** Dev adapters must announce
  themselves and must never claim a real settlement, reservation release, or delivery occurred.
- **Do not rebuild Mitra from scratch and do not remove working behavior.**

## Before any meaningful change, read

1. [`forge/PRODUCT.md`](forge/PRODUCT.md) — what Mitra is and the load-bearing mechanism.
2. [`forge/INVARIANTS.md`](forge/INVARIANTS.md) — the properties that must never break, with status.
3. [`forge/ARCHITECTURE.md`](forge/ARCHITECTURE.md) — the real components and their layers.
4. [`forge/EXECUTION_PLAN.md`](forge/EXECUTION_PLAN.md) — the current phase and its scope.
5. [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md) — what is actually proven vs not.

The full specification is `docs/product/MITRA_PRD.md` (normative) and
`docs/product/MITRA_0_1_FULL_PRODUCT_SPEC.md`. Where this repository's older
`docs/*.md` and the PRD disagree, **the PRD wins** and the disagreement belongs
in `forge/FAILURES.md`.

## The one mechanism to protect

**An ALLOW decision is never itself permission to move value.** The policy engine
decides whether an action is permitted; the execution guard independently
re-derives whether *this exact instruction* may move capital:

```
HOW MUCH MAY I SPEND → WHO AUTHORIZED IT → MAY THIS EXACT INSTRUCTION MOVE CAPITAL
       mandate              policy engine           execution guard
```

A human or agent cannot supply their own spend decision, and an `ALLOW` that
skips the execution guard is not a weaker guarantee — it is no guarantee.

Everything else in `INVARIANTS.md` is a consequence of protecting this.

## The `forge` control plane

`PRODUCT · CORE_HYPOTHESIS · INVARIANTS · ARCHITECTURE · EXECUTION_PLAN ·
PROOF_LEDGER · FAILURES` — plus [`forge/forge.json`](forge/forge.json)
(machine-readable manifest).

Standards this plane implements are in [`forge/standards/`](forge/standards/):
`BUILD_FOUNDRY.md` (verification and evidence discipline) and
`Repository-Starter-Virtuous-Build-Cycle.md` (repository construction).

## Working agreement between agents and people

The shared context MCP server is how collaborators coordinate. Full setup and
the working agreement are in `ONBOARDING.md` on the `feat/shared-context`
branch, and are also stored as context entries under `scope: process` — so an
agent reads them from the data rather than being told them in prose.

```
register   context_register_actor   once per session, same id forever
orient     context_digest           before unfamiliar work
recall     context_recall           before editing code you did not write
announce   context_remember         BEFORE the work, not after
hand off   context_remember         kind=handoff, when you stop
verify     context_audit            before calling anything done
```

The working agreement is also stored as context entries under `scope: process`,
so an agent reads it from the data rather than being told it in prose.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
