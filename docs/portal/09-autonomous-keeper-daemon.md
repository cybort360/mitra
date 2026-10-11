# The Autonomous Keeper Daemon

> *"Zero stranded capital through autonomous recovery sweeps."*  
> — [PRD §28.5: Autonomous Escrow Sweeps](../product/MITRA_PRD.md) · [`scripts/keeper-daemon.ts`](../../scripts/keeper-daemon.ts)

In decentralized applications, locked escrows often rely on human users or counterparties to manually initiate dispute or refund transactions. In autonomous agent commerce, if a provider agent goes offline or fails to deliver before a deadline, requiring manual human intervention defeats the entire premise of autonomy.

Mitra operates an autonomous **Keeper Daemon** that monitors all active agreements across supported chains and automatically executes refund sagas the instant an escrow passes its deadline without submission.

---

## 1. Why the Keeper Exists

Consider the UX failure modes without an automated keeper:
1. **The Ghosting Provider:** Client agent funds $100 for a data processing task. The provider crashes halfway through. If the client agent has moved on to another task, the funds sit abandoned in smart contract escrow indefinitely.
2. **Asymmetric Knowledge:** The client agent may not actively poll overdue status to save token compute and API calls.
3. **Deadlock State:** Without an explicit refund instruction, the vault headroom remains decremented, choking the client's future trading capacity.

The Mitra Keeper Daemon turns refund guarantees into an automated invariant: **an overdue agreement is refunded without either party asking.**

---

## 2. Architecture & Operational Loop

The Keeper runs as a persistent service managed by the unified supervisor (`npm run stack:up`) or as a standalone CLI process:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               KEEPER DAEMON SWEEP CYCLE                                │
│                                                                                        │
│   [Query Active Agreements]                                                            │
│   `GET /api/v1/agreements?status=FUNDED,EXECUTING`                                     │
│             │                                                                          │
│             ▼                                                                          │
│   [Filter Overdue] ➔ `now() > agreement.deadline`                                      │
│             │                                                                          │
│             ▼                                                                          │
│   [Verify Escrow Rail Status] ➔ Check on-chain PDA / ERC-8183 contract                 │
│             │                                                                          │
│             ▼                                                                          │
│   [Execute Atomic Refund] ➔ Call `recovery.refundEscrow(agreementId)`                  │
│             │                                                                          │
│             ▼                                                                          │
│   [Durable Persistence] ➔ Transition status to `REFUNDED`; restore vault headroom      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Fail-Closed Discipline (The F103 Lesson)

The Keeper Daemon strictly adheres to BUILD_FOUNDRY discipline:
- **Never Fake a Sweep:** If target chain RPCs or private settlement keys are not configured in the environment, the keeper exits immediately with exit code `2`. It will **never** silently log a synthetic success or simulate an on-chain refund that did not occur.
- **Entrypoint Verification (F103):** As recorded in [`forge/FAILURES.md`](../../forge/FAILURES.md), unit tests that only import pure helper functions can pass while the runtime binary fails. The Keeper Daemon is tested by executing the entrypoint directly (`npm run keeper:once`).

---

## 4. Running the Keeper

### One-Shot Sweep
Run a single sweep pass across all active escrows:
```bash
npm run keeper:once
```

### Standing Service Supervisor
Run the keeper as part of the complete background daemon stack:
```bash
npm run stack:up       # Starts Core API (:3005), MCP (:3006), Worker, and Keeper
npm run stack:status   # Inspects PID attribution and uptime
npm run stack:down     # Safely terminates all supervised daemons
```

---

## Next Steps

- Learn how completed obligations are cleared without gross liquidity in [Multilateral Debt Netting](./10-multilateral-debt-netting.md).
- Dive into the [Epoch Clearing Algorithms](./11-epoch-clearing-algorithms.md).
