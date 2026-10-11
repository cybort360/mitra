# Multilateral Debt Netting: "Clear First. Move Only What Remains"

> *"Gross settlement moves every leg. A clearinghouse cancels the cycle and moves only the net remainder."*  
> — [`lib/kernel/clearing.ts`](../../lib/kernel/clearing.ts) · [`README.md`](../../README.md)

In traditional blockchain payments, every transaction triggers an individual on-chain transfer. If Agent A pays Agent B $100, Agent B pays Agent C $70, and Agent C pays Agent A $40, a standard payment rail executes three separate transactions, requires $210 in gross capital, and incurs three separate gas fees.

Mitra introduces **Multilateral Cycle Netting**: an algorithmic clearing engine that identifies cyclic obligations and settles only the residual balance.

---

## 1. The Concrete Math: Gross vs. Net Settlement

Consider a simple three-party commerce cycle:

```
               [Agent A]
              /         ▲
       $100  /           \  $40
            ▼             \
        [Agent B] ───────► [Agent C]
                   $70
```

### Gross Payment Rails:
- Transaction 1: $A \to B$ for **$100**
- Transaction 2: $B \to C$ for **$70**
- Transaction 3: $C \to A$ for **$40**
- **Total Gross Capital Required:** **$210.00**
- **Transactions Dispatched:** 3

### Mitra Multilateral Netting:
We calculate each participant's net position ($\text{Inbound} - \text{Outbound}$):

$$\text{Net}(A) = +40 - 100 = -60 \quad (\text{Net Debtor: Owes } \$60)$$
$$\text{Net}(B) = +100 - 70 = +30 \quad (\text{Net Creditor: Receives } \$30)$$
$$\text{Net}(C) = +70 - 40 = +30 \quad (\text{Net Creditor: Receives } \$30)$$

### Net Settlement Outcome:
- Agent A pays $30 to Agent B.
- Agent A pays $30 to Agent C.
- **Total Capital Moved:** **$60.00**
- **Liquidity Savings:** **71.4% reduction** ($\$150$ in canceled circular debt)

---

## 2. Mathematical Vector Reduction

For an arbitrary directed trade graph $G = (V, E)$ with capacity matrix $C \in \mathbb{R}^{n \times n}$, the clearing kernel computes the net obligation vector $\vec{v} \in \mathbb{R}^n$:

$$v_i = \sum_{j=1}^n C_{ji} - \sum_{j=1}^n C_{ij}$$

The kernel satisfies three strict mathematical invariants:
1. **Conservation of Value (Zero-Sum Invariant):**
   $$\sum_{i=1}^n v_i = 0$$
2. **Strict Non-Increase of Gross Volume:**
   $$\sum_{i \in \text{Debtors}} |v_i| \le \frac{1}{2} \sum_{i,j} C_{ij}$$
3. **No Inversion of Positions:** A net creditor ($v_i > 0$) never pays out capital; a net debtor ($v_i < 0$) never receives capital.

---

## 3. Querying Clearing Previews

Agents and operators can preview netting reductions before committing an epoch settlement:

### TypeScript Example (`@mitra/sdk`)

```typescript
import { MitraClient } from "@mitra/sdk";

const client = new MitraClient({ /* ... */ });

// Preview multilateral netting for the current space
const preview = await client.clearing.preview({
  spaceId: "space_research_live",
  currency: "USDC",
});

console.log(`Gross Obligations: $${preview.grossTotal}`);
console.log(`Netted Settlement: $${preview.netTotal}`);
console.log(`Liquidity Compression: ${preview.savingsPercent}%`);

for (const leg of preview.settlementLegs) {
  console.log(`Transfer: ${leg.from} ➔ ${leg.to} ($${leg.amount})`);
}
```

### Over MCP (`mitra_request_clearing`)
An agent calling `mitra_request_clearing` over MCP receives the netting preview. Notice that over MCP, `mitra_request_clearing` **can only ever ask for a preview**—it has no capital-issuing verb, preserving invariant I-01.

---

## Next Steps

- Explore epoch scheduling and batch reconciliation in [Epoch Clearing Algorithms](./11-epoch-clearing-algorithms.md).
- Inspect chain-specific mechanics starting with [Solana Substrate](./12-solana-substrate.md).
