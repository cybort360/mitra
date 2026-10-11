# The Execution Guard: "ALLOW != DISBURSEMENT"

> **The Load-Bearing Invariant:**  
> *"An ALLOW decision is never itself permission to move value. The policy engine decides whether an action is permitted; the execution guard independently re-derives whether this exact instruction may move capital."*  
> — [`AGENTS.md`](../../AGENTS.md) · [`INVARIANTS.md`](../../forge/INVARIANTS.md)

In poorly architected agent systems, permission engines and disbursement mechanisms are coupled: once a policy check returns "true", funds are transferred unconditionally.

Mitra fundamentally rejects this architecture. A human or an agent cannot supply their own spend decision, and an `ALLOW` that skips the execution guard is not a weaker guarantee—**it is no guarantee at all**.

---

## 1. The Separation of Powers

Mitra enforces strict separation across three distinct institutional layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ HOW MUCH MAY I SPEND?  ➔   WHO AUTHORIZED IT?   ➔   MAY THIS INSTRUCTION MOVE CAPITAL? │
│        mandate                    policy engine                   execution guard      │
│  (Persistent Engraving)      (Arcium MPC Evaluation)           (On-Chain Vault Logic)  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **The Mandate (Ceiling):** Establishes the static outer bounds of the agent's financial universe.
2. **The Policy Engine (Verdict):** Computes whether a proposed trade complies with business logic. It emits a verdict (`ALLOW`, `DENY`, or `REVIEW`).
3. **The Execution Guard (Disbursement):** When funds are due to disburse, the on-chain execution guard re-evaluates the instruction against live vault reserves, unspent authorizations, and verified counterparty signatures.

---

## 2. Why Independent Re-Derivation is Mandatory

Consider the failure modes when an `ALLOW` token directly triggers payment:

1. **Compromised Off-Chain Policy Engine:** If an off-chain API or MPC cluster is compromised, forged `ALLOW` tokens could drain the treasury if vaults blindly trusted them.
2. **Double-Spend & Concurrency Races:** An agent could receive a single `ALLOW` for $100 and simultaneously submit it to multiple settlement rails, attempting to disburse $500 before headroom reconciles.
3. **State Desynchronization:** An agreement might be canceled, disputed, or refunded off-chain while a stale `ALLOW` token is still in flight.

### The Execution Guard Defense:
The on-chain Vault never accepts an external instruction claiming "the policy engine approved this, so release funds." Instead, the Vault requires:
- The original cryptographic commitment of the mandate.
- The unspent authorization hash with its isolated nonce.
- Direct cryptographic proof that the agreement is in terminal `ACCEPTED` status.
- Atomically marks the authorization as spent (`consumed: true`) in the same on-chain block.

---

## 3. Execution Guard Verification Protocol

When an agreement triggers settlement, the Execution Guard executes four mandatory steps in a single atomic transaction:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   EXECUTION GUARD ATOMIC PIPELINE                      │
│                                                                        │
│  Step 1: Check Agreement Status == ACCEPTED                            │
│          Verify Evaluator / Client signature on deliverable acceptance.│
│                                                                        │
│  Step 2: Check Authorization Nonce                                     │
│          Verify `consumed == false` in state store / PDA account.      │
│                                                                        │
│  Step 3: Re-derive Mandate Headroom                                    │
│          Verify `allocated_headroom >= agreement.amount`.              │
│                                                                        │
│  Step 4: Atomic State Mutation                                         │
│          • Set `consumed = true` (burn nonce)                          │
│          • Decrement `headroom = headroom - agreement.amount`          │
│          • Disburse funds or record multilateral netting credit        │
└────────────────────────────────────────────────────────────────────────┘
```

If any step fails, the entire transaction reverts, leaving vault balances untouched.

---

## 4. Formal State Transition Table

The execution guard enforces the following state transitions across the lifecycle of an obligation:

| Initial State | Event / Trigger | Preconditions Verified | Final State | Capital Moved? |
|---|---|---|---|:---:|
| `OPEN` | `fund(agreementId)` | Mandate headroom $\ge$ Price; Valid client sig | `FUNDED` | **Escrowed** |
| `FUNDED` | `startExecution(agreementId)` | Provider sig matches registered `agentId` | `EXECUTING` | No |
| `EXECUTING` | `submitDeliverable(hash)` | Pre-deadline; Hash non-empty | `SUBMITTED` | No |
| `SUBMITTED` | `acceptDeliverable(sig)` | Valid evaluator/client sig; Acceptance criteria met | `ACCEPTED` | Due for Settlement |
| `ACCEPTED` | `executeDisbursement(authId)` | Authorization unspent; Vault liquid | `SETTLED` | **Disbursed / Netted** |
| `SUBMITTED` | `rejectDeliverable(reason)` | Evaluator sig; Reason documented | `REJECTED` | No |
| `REJECTED` | `refund(agreementId)` | Two-phase saga recovery executed | `REFUNDED` | **Restored to Vault** |

---

## 5. Security Invariant (I-01)

> **Invariant I-01:** No execution path in Mitra can move capital without traversing the Execution Guard. Direct vault withdrawals by agents, bypasses of the mandate ceiling, and reuse of consumed authorizations are physically rejected by the smart contract bytecode and Anchor program constraints.

---

## Next Steps

- Explore how commercial escrows work under the hood in [Bilateral Agreements & DvP Escrow](./07-bilateral-agreements-and-escrow.md).
- Understand atomic failure recovery in [Distributed Sagas & Atomic Compensation](./08-distributed-sagas-atomic-recovery.md).
