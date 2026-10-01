# ARCHITECTURE

What the code actually is, as distinct from what the specification describes.

## Runtime layers

| Layer | Location | State |
|---|---|---|
| Console | `app/`, `components/` | **Mockup** — 15 pages, 89 lines of template-literal HTML |
| API | `app/api/v1/*` | Real for 3 routes, stub for the rest |
| Domain | `lib/domain/types.ts` | Real — 15 canonical objects |
| Kernel | `lib/kernel/*` | Real, pure, tested |
| Store | `lib/store/*` | Seed array + a Postgres repository, **not yet wired to routes** |
| Adapters | `lib/adapters/*` | Interfaces real, implementations stubbed |
| MCP | `lib/mcp/tools.ts` | 17 tool *names* only — no implementations |

## The capital path

This is the part that is real:

```
POST /api/v1/authorizations       → evaluateProposal        → ALLOW | DENY(reasonCodes)
POST /api/v1/reservations         → policy, then reserve    → Reservation (RESERVED)
POST /api/v1/reservations/execute → validateExecutionBinding → COMMITTED
```

Creating a reservation is **not** execution. The execute route independently
re-derives the binding: exact action digest, amount, asset, chain, expiry, and
a single-use nonce. This separation is the product's core claim, and it is
implemented and tested rather than asserted.

## Kernel

Pure functions. No clock, no IO, no store — time is an injected parameter, which
is what makes expiry deterministically testable.

| Module | Role |
|---|---|
| `authorization.ts` | `evaluateProposal`, `validateExecutionBinding` |
| `vault.ts` | `reconcileVault`, `reserve`, `releaseReservation`, `consumeReservation` |
| `clearing.ts` | `netObligations` — deterministic netting |
| `machines.ts` | Transition tables for 7 machines + Mandate |
| `failure-lab.ts` | Scenario catalogue |

## Storage

`lib/store/repository.ts` defines the interface routes should depend on.
Two implementations:

- **`CapitalLedger`** — in-process. What the routes currently use. Loses consumed
  nonces on restart.
- **`PostgresRepository`** — durable, concurrency-safe, **not yet wired**.

Both satisfy `EconomicRepository`, which is what allows the swap. The intended
end state is that no route imports `lib/store/seed.ts` directly; today some do.

## State machines

Defined for all seven documented machines plus Mandate. Only **Reservation** is
attached to a write path. The others are tested but unwritten, because the
write paths that would use them do not exist yet.

## Development tooling

`shared-context-mcp/` — a shared, auditable memory server giving collaborators
and agents one record of decisions and reasoning. It is a **development
instrument, not part of the product**: it holds notes, never authority, and
cannot move capital.

## Known architectural gaps

1. Routes read the seed array and the in-process ledger, not the repository.
2. The console renders template strings, not components.
3. Adapters are interfaces with a local stub; no external system is called.
4. No on-chain program exists, so the "vault" is a database row rather than an
   enforced account boundary.
5. The saga, obligation, agreement and clearing-epoch machines have no runtime.

Items 3–5 are the substance of PRD Phases 2–7.
