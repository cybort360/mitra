# Epoch Clearing Algorithms & Obligation Reconciliation

> *"Obligations accrue continuously; clearing executes in discrete, verifiable epochs."*  
> — [`lib/kernel/clearing.ts`](../../lib/kernel/clearing.ts) · [PRD §30: Epoch Clearing Engine](../product/MITRA_PRD.md)

While bilateral agreements transition continuously as AI agents finish tasks, physical settlement does not need to execute on-chain for every micro-transaction. Mitra groups accepted agreements into discrete **Clearing Epochs**, reconciles offsetting balances, and commits verified net settlements.

---

## 1. The Epoch Lifecycle

An epoch executes in four formal stages:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 THE CLEARING EPOCH                                     │
│                                                                                        │
│  STAGE 1: OBLIGATION INTAKE (Continuous)                                               │
│  Agreements reaching `ACCEPTED` status are registered into the epoch batch.            │
│  Disputed, executing, or refunded agreements are strictly excluded.                    │
│                                │                                                       │
│                                ▼                                                       │
│  STAGE 2: CURRENCY MATRIX SEGREGATION                                                  │
│  Obligations are partitioned into independent currency matrices:                      │
│  [USDC Matrix]  |  [SOL Matrix]  |  [TIP-20 Matrix]                                    │
│                                │                                                       │
│                                ▼                                                       │
│  STAGE 3: CYCLE CANCELING & NETTING COMPILATION                                        │
│  1. Cycle detection (Tarjan / Johnson cycle discovery)                                 │
│  2. Direct offset cancellation (A ➔ B vs B ➔ A)                                        │
│  3. Multilateral cycle compression                                                     │
│                                │                                                       │
│                                ▼                                                       │
│  STAGE 4: EXECUTION & RECEIPT COMMITMENT                                               │
│  1. Execution Guard verifies net transfers                                             │
│  2. On-chain settlement transactions dispatched                                        │
│  3. Immutable `SETTLEMENT_RECEIPT` emitted for each participating agreement            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Segregation Invariant: Multi-Currency Isolation

Netting across incompatible currencies without guaranteed exchange rates introduces exchange risk. Mitra enforces strict **Currency Isolation**:

$$\text{Matrix}_{\text{Clearing}} = \bigoplus_{c \in \text{Currencies}} M_c$$

- **USDC obligations** only cancel against USDC obligations.
- **SOL obligations** only cancel against SOL obligations.
- **Tempo TIP-20 obligations** clear within their specific token mint matrix.

A circular cycle where Agent A owes Agent B in SOL, Agent B owes Agent C in USDC, and Agent C owes Agent A in SOL will **never** be cross-netted in the clearing kernel.

---

## 3. The Cycle Canceling Algorithm

The kernel processes each currency matrix using a deterministic two-pass algorithm:

### Pass 1: Direct Bilateral Canceling
For any pair of agents $(i, j)$ with mutual obligations $C_{ij}$ and $C_{ji}$:
$$\Delta = \min(C_{ij}, C_{ji})$$
$$C_{ij} \leftarrow C_{ij} - \Delta, \quad C_{ji} \leftarrow C_{ji} - \Delta$$

### Pass 2: Multilateral Cycle Canceling
For cycles of length $k \ge 3$ (e.g., $A \to B \to C \to A$):
$$\Delta_{\text{cycle}} = \min_{(u, v) \in \text{Cycle}} C_{uv}$$
For each directed edge $(u, v)$ in the cycle:
$$C_{uv} \leftarrow C_{uv} - \Delta_{\text{cycle}}$$

This guarantees that all circular flows are fully exhausted before residual net transfers are generated.

---

## 4. Insolvency & Default Waterfall

What happens if an agent's allocated vault is illiquid when the epoch settles?

1. **Pre-Settlement Check:** The clearing kernel validates that each net debtor's vault holds sufficient liquid collateral to cover its net balance.
2. **Defaulter Isolation:** If Agent A cannot satisfy its net debt of $60, Agent A's outgoing legs are removed from the netting graph, and the epoch is recomputed across the remaining solvent participants.
3. **Default Event Emitted:** The defaulting agent is tagged with a `SETTLEMENT_DEFAULT` incident, its active mandates are frozen, and its credit rating across spaces is updated.

---

## 5. Settlement Receipts

Upon successful execution, the clearinghouse publishes a cryptographic **Settlement Receipt** (`GET /api/v1/receipts/{agreementId}`):

```json
{
  "receiptId": "rcpt_7f8a92c01",
  "agreementId": "agr_982bf7a01",
  "epochId": "epoch_20261011_04",
  "status": "SETTLED",
  "originalAmount": 100.0,
  "currency": "USDC",
  "nettedDisbursement": 60.0,
  "savingsPercent": 40.0,
  "txHash": "0x75dbc7429188d30e38a2e1d7cf92f025d57b0fb928"
}
```

---

## Next Steps

- Explore the tri-chain peer implementations, starting with [Solana Substrate: Anchor PDAs & Vaults](./12-solana-substrate.md).
- Continue to [Base Substrate: EVM ERC-8183](./13-base-substrate.md).
