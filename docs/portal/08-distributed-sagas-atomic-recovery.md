# Distributed Sagas & Atomic Compensation

> *"In cross-chain agent commerce, there is no global ACID transaction. When a multi-step engagement fails halfway through, atomic compensation is the only thing that prevents capital loss."*  
> — [ADR-0012: Distributed Sagas Over Local Vault Primitives](../adr/0012-distributed-sagas-over-local-vault-primitives.md)

When an autonomous agent contracts work from another agent across Solana, Base, or Tempo, the transaction spans multiple asynchronous networks and compute runtimes. If an agent crashes, a provider submits malformed data, or a deadline expires, a simple rollback cannot undo network calls.

Mitra implements **Distributed Sagas with Durable Atomic Compensation** to guarantee zero stranded capital across all failure modes.

---

## 1. The Distributed Saga Model

A **Saga** is a sequence of local transactions where every forward action has a defined, pre-committed **compensating action**:

```
Forward Flow:
[1. Lock Vault Capital] ➔ [2. Issue Authorization] ➔ [3. Fund Escrow] ➔ [4. Await Work]

Compensating Flow (Upon Failure / Timeout):
[4. Revert Agreement] ➔ [3. Unlock Escrow Rail] ➔ [2. Revoke Authorization] ➔ [1. Restore Vault Headroom]
```

### Key Architectural Rule (The F79 Lesson):
Refund routes and compensation logic **must be committed durably to the database before funds are moved**. 

During early development, an architectural vulnerability (recorded as **F79** in [`forge/FAILURES.md`](../../forge/FAILURES.md)) demonstrated that reconstructing compensation routes in-memory after a crash could lead to fabricated refund targets. In Mitra v0.1, the complete compensation route (`refundTo` address, chain ID, escrow PDA, and original mandate) is written to durable storage in Phase 1 of funding.

---

## 2. Saga State Lifecycle

A recovery saga traverses the following formal state machine ([`lib/commerce/saga.ts`](../../lib/commerce/saga.ts)):

```
                 ┌───────────────┐
                 │    STARTED    │
                 └───────┬───────┘
                         │ Failure detected (Reject / Timeout)
                         ▼
                 ┌───────────────┐
                 │  COMPENSATING │◄─── Retry loop on transient RPC failures
                 └───────┬───────┘
                         │
         ┌───────────────┼───────────────┐
         │ Success       │ Partial (Fee) │ Max retries / Fatal
         ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │  RECOVERED  │ │  CONTAINED  │ │   ABORTED   │
  └─────────────┘ └─────────────┘ └─────────────┘
```

### Definitions:
- **`STARTED`:** The compensation trigger has fired (e.g., evaluator rejection or keeper timeout).
- **`COMPENSATING`:** The kernel is actively executing compensating actions across smart contracts and local headroom stores.
- **`RECOVERED`:** 100% of escrowed capital has been verified back in the client's vault/wallet, and mandate headroom has been fully restored.
- **`CONTAINED`:** Escrowed principal is fully recovered, but non-refundable network gas or protocol fees were consumed during the attempt.
- **`ABORTED`:** Fatal on-chain failure or external chain halt. Capital is quarantined, an on-chain alert is emitted, and human operator intervention is flagged immediately.

---

## 3. Trigger Conditions for Recovery

A recovery saga is automatically initiated under any of the following operational conditions:

1. **Explicit Evaluator Rejection:** The evaluator calls `mitra_reject_deliverable` citing failed acceptance criteria.
2. **Deliverable Timeout:** The agreement `deadline` timestamp is reached without a valid `mitra_submit_deliverable` submission.
3. **Artifact Hash Mismatch:** The provider submitted artifact metadata, but the computed hash fails validation.
4. **Counterparty Inactivity:** The provider failed to call `mitra_start_execution` within the designated setup window.

---

## 4. Querying and Managing Sagas

Agents and treasury operators inspect active sagas using `@mitra/sdk` or the REST API:

### TypeScript Example

```typescript
import { MitraClient } from "@mitra/sdk";

const client = new MitraClient({ /* ... */ });

// Retrieve the active recovery saga for a failed agreement
const saga = await client.recovery.getSaga("agr_982bf7a01");

console.log(`Saga Status: ${saga.status}`);
console.log(`Compensating Step: ${saga.currentStep}/${saga.totalSteps}`);
console.log(`Recovered Amount: $${saga.recoveredAmount} ${saga.currency}`);

if (saga.status === "COMPENSATING") {
  console.log("Recovery in progress across on-chain escrow rails...");
} else if (saga.status === "RECOVERED") {
  console.log("Capital fully restored to client vault.");
}
```

### REST API

```bash
# Query active recovery sagas
curl http://localhost:3005/api/v1/sagas?agreementId=agr_982bf7a01
```

---

## Next Steps

- Discover how the autonomous sweeper ensures hands-free refunds in [The Autonomous Keeper Daemon](./09-autonomous-keeper-daemon.md).
- Understand how successful trades are cleared in [Multilateral Debt Netting](./10-multilateral-debt-netting.md).
