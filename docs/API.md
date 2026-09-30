# API Surface

Implemented local routes:

- GET `/api/v1/health`
- GET/POST `/api/v1/runs`
- GET `/api/v1/vaults`
- GET `/api/v1/obligations`
- GET `/api/v1/clearing`
- POST `/api/v1/failure-lab`

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
