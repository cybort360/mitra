# API Surface

Implemented local routes:

- GET `/api/v1/health`
- GET/POST `/api/v1/runs`
- GET `/api/v1/vaults`
- GET `/api/v1/obligations`
- GET `/api/v1/clearing`
- POST `/api/v1/failure-lab`
- POST `/api/v1/authorizations` — policy evaluation
- GET/POST `/api/v1/reservations` — capital commitment
- POST `/api/v1/reservations/execute` — the execution guard

## The capital path

`POST /runs` is a local contract only. The path that actually evaluates
authority and moves capital is:

```
POST /authorizations      -> evaluateProposal -> ALLOW | DENY(reasonCodes)
POST /reservations        -> reserve           -> Reservation (RESERVED)
POST /reservations/execute-> validateExecutionBinding -> COMMITTED
```

Creating a reservation is **not** execution. The execute route re-derives the
binding independently: exact action digest, amount within the reservation,
asset, chain, expiry, and a nonce that can be spent once. A DENY at any step
reserves nothing.

### Example: authorize

```json
{
  "mandateId": "mandate_research_v7",
  "vaultId": "vault_sol_primary",
  "amount": 5,
  "asset": "USDC",
  "chain": "solana",
  "counterparty": "virtuals:research-agent-18",
  "capability": "market_research",
  "intentId": "intent_501",
  "runId": "run_501"
}
```

`201` with an `ALLOW`; `403` with `reasonCodes` on `DENY`; `409` if the mandate
does not cover the requested vault. The optional `now` field (ISO 8601) injects
the clock for deterministic testing.

### Example: execute

```json
{
  "reservationId": "res_54aefa161f024832",
  "amount": 9,
  "asset": "USDC",
  "chain": "solana",
  "actionDigest": "sha256:…"
}
```

`200` commits the reservation. `409` returns a specific `reason`:
`RESERVATION_EXPIRED`, `ACTION_DIGEST_MISMATCH`, `AMOUNT_EXCEEDS_RESERVATION`,
`ASSET_MISMATCH`, `CHAIN_MISMATCH`, `INVALID_AMOUNT`, `NONCE_ALREADY_CONSUMED`
or `RESERVATION_NOT_EXECUTABLE`.

Responses carry `evidenceLevel: "LOCAL_PASS"`. **No chain transaction and no
value movement occurs** — this is a local simulation.

## Known limitation

Capital and nonce state live in a process-local ledger (`lib/store/ledger.ts`).
Restarting the process loses consumed nonces, so replay protection does not
survive a restart. That is Phase 3 work; until then this is a single-process
system and should not be treated as durable.

Production resource model:

`/agents`, `/mandates`, `/vaults`, `/reservations`, `/authorizations`, `/intents`, `/agreements`, `/deliverables`, `/escrows`, `/obligations`, `/clearing/epochs`, `/sagas`, `/settlements`, `/receipts`, `/accounting`, `/events`.

Every consequential mutation should return a stable object ID, resulting state and receipt reference. Replay-sensitive mutations require idempotency keys/nonces and expiries.

### Example create intent

```json
{
  "agentId": "agent_buyer_07",
  "mandateId": "mandate_research_v7",
  "objective": "Research 100 crypto projects",
  "budget": { "asset": "USDC", "amount": 50 }
}
```

A create-intent response is not proof of authorization and does not move capital. Reservation and execution remain downstream protocol steps.
