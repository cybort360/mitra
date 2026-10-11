# Engravings & Mandates: How Principals Bound Agent Authority

> *"Steering changes intent. Engravings bound authority."*  
> — [ADR-0009: Mandate Semantics Reuse Engraving](../adr/0009-mandate-semantics-reuse-engraving.md)

In autonomous multi-agent systems, agents frequently re-plan, re-prompt, and adapt their execution strategies at runtime. While steering prompts can influence an agent's *intent*, prompts are soft heuristics that offer zero mathematical guarantees against catastrophic loss.

An **Engraving (Mandate)** is a cryptographic spending ceiling permanently set by a human principal. It establishes immutable capital boundaries within which an agent may operate autonomously.

---

## 1. Engravings vs. Authorizations: The Critical Distinction

A foundational architectural design in Mitra is the strict separation between a **Persistent Engraving (The Mandate)** and a **Consumable Authorization (The Execution Token)**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        ENGRAVING (MANDATE) — PERSISTENT CEILING                        │
│                                                                                        │
│  • Set ONCE by the Human Principal                                                     │
│  • Total Budget: $500 USDC | Max Per-Tx: $50 USDC                                      │
│  • Allowed Capabilities: ["data_indexing", "code_review"]                              │
│  • Headroom remaining: Decreases monotonically ($500 ➔ $450 ➔ $400)                     │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                     Generates per-trade    │ atomic checks
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   AUTHORIZATION — SINGLE-USE & CONSUMED ATOMICALLY                     │
│                                                                                        │
│  • Generated per-transaction by the Policy Engine (`ALLOW`)                            │
│  • Amount: $50 USDC | Counterparty: `agent_provider_02`                                │
│  • Burns Single-Use Nonce: `consumed: true` upon settlement                            │
│  • Cannot be replayed. Re-derives against persistent Engraving headroom.               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why the Principal Does Not Need to Create New Engravings Per Transaction:
- **The Engraving is Long-Lived:** The principal creates an engraving once (e.g., granting an agent $1,000 for a 30-day research sprint).
- **Headroom Decreases Monotonically:** As the agent enters bilateral agreements, committed funds decrement the mandate's remaining headroom.
- **Authorizations are Single-Use:** For each agreement, the policy engine issues a discrete authorization with an isolated nonce. Once used in an execution guard settlement, that authorization token is burned (`consumed: true`). The parent engraving remains active until its budget is exhausted or its expiration timestamp is reached.

---

## 2. Nonce Isolation & Anti-Replay Guarantees

Authorizations prevent replay attacks while ensuring that multiple agents funded by the same principal never collide.

Each authorization derives a cryptographically isolated state key:

$$\text{AuthorizationKey} = \text{keccak256}(\text{spaceId} \parallel \text{mandateId} \parallel \text{agentId} \parallel \text{nonce})$$

### Architectural Properties:
1. **Parallel Execution:** Agent A and Agent B operating under separate mandates within the same Space can execute concurrent transactions without nonce contention.
2. **Deterministic Burning:** When an escrow transitions to `FUNDED`, the specific `authorizationId` is atomically marked as consumed in the store. Attempting to use the same authorization on a second agreement returns `409 AUTHORIZATION_CONSUMED`.
3. **Headroom Recovery:** If an agreement is rejected, canceled, or refunded, an atomic recovery saga safely replenishes the available headroom on the parent engraving without requiring principal intervention.

---

## 3. Mandate Anatomy & Cryptographic Schema

A Mandate is defined by the following schema:

```typescript
export interface Mandate {
  mandateId: string;           // Unique identifier (UUIDv4 or hash)
  spaceId: string;             // The budgetary space scope
  principal: string;           // Address of the authorizing principal
  agentId: string;             // The authorized autonomous agent
  currency: string;            // Settled token ("USDC", "SOL", "TIP20")
  totalBudget: number;         // Maximum lifetime spending ceiling
  maxTransaction: number;      // Maximum spend permitted in a single agreement
  headroom: number;            // Current remaining uncommitted budget
  allowedCapabilities: string[]; // Whitelist of admissible service types
  approvedChains: number[];    // Target chain IDs (e.g., 84532, 1399811149, 42431)
  expiresAt: number;           // Unix epoch timestamp (seconds)
  paused: boolean;             // Emergency halt flag
}
```

---

## 4. Configuring an Engraving

Principals create and update engravings using the operator console or the programmatic operator client:

### TypeScript Example

```typescript
import { MitraOperatorClient } from "@mitra/sdk";

const operator = new MitraOperatorClient({
  baseUrl: "http://localhost:3005",
  principalKey: process.env.PRINCIPAL_PRIVATE_KEY!,
});

// Configure a $1,000 research mandate for an autonomous researcher
const mandate = await operator.mandates.create({
  spaceId: "space_research_live",
  agentId: "agent_researcher_01",
  totalBudget: 1000.0,
  maxTransaction: 100.0, // Cap any single purchase at $100
  currency: "USDC",
  allowedCapabilities: [
    "arxiv_paper_search",
    "gpu_fine_tuning",
    "statistical_synthesis"
  ],
  approvedChains: [84532, 1399811149, 42431], // Base, Solana, Tempo
  expiresAt: Math.floor(Date.now() / 1000) + (30 * 86400), // 30 days
});

console.log(`Engraving created: ${mandate.mandateId}`);
```

### Python Example

```python
import httpx
import time

payload = {
    "spaceId": "space_research_live",
    "agentId": "agent_researcher_01",
    "totalBudget": 1000.0,
    "maxTransaction": 100.0,
    "currency": "USDC",
    "allowedCapabilities": [
        "arxiv_paper_search",
        "gpu_fine_tuning",
        "statistical_synthesis"
    ],
    "approvedChains": [84532, 1399811149, 42431],
    "expiresAt": int(time.time()) + (30 * 86400)
}

resp = httpx.post("http://localhost:3005/api/v1/mandates", json=payload)
print(f"Engraving active: {resp.json()['mandateId']}")
```

---

## 5. Security Invariant (I-04)

> **Invariant I-04:** An agent can never modify its own mandate, extend its expiration, or elevate its allowed capabilities. Mandate modification requires the principal's verified signature.

---

## Next Steps

- Explore how privacy is preserved during policy evaluation in [Confidential Policy Evaluation with Arcium MPC](./05-arcium-mpc-confidential-policy.md).
- Learn why policy verdicts differ from disbursements in [The Execution Guard Invariant](./06-execution-guard-and-allow-invariant.md).
