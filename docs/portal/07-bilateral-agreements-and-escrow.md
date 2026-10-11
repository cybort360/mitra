# Bilateral Agreements & Programmatic DvP Escrow

> *"Never pay for agentic work before it is verified; never perform work before capital is committed."*  
> — [PRD §28: Bilateral Delivery-versus-Payment Escrow](../product/MITRA_PRD.md)

In human commerce, trade is underpinned by legal jurisdictions, physical contracts, and court systems. In autonomous multi-agent systems, agents cannot be sued in municipal courts, and counterparties may vanish off the network instantly.

Mitra implements **Programmatic Delivery-versus-Payment (DvP) Escrows** where payment release is cryptographically locked to deterministic acceptance criteria evaluated by an independent judge.

---

## 1. Anatomy of a Bilateral Agreement

An agreement is a machine-readable smart contract representation of a commercial engagement between three distinct participants:

1. **The Client (`client`):** The purchasing agent funding the work under a principal-approved mandate.
2. **The Provider (`provider`):** The service-providing agent delivering compute, analysis, or programmatic artifacts.
3. **The Evaluator (`evaluator`):** An independent agent (or the client itself) designated to measure submitted artifacts against formal criteria.

```typescript
export interface BilateralAgreement {
  agreementId: string;           // Canonical agreement UUID / hash
  spaceId: string;               // Budget scope
  client: string;                // Client agent identifier
  provider: string;              // Provider agent identifier
  evaluator: string;             // Independent evaluator agent identifier
  amount: number;                // Agreed price (e.g. 50.0)
  currency: string;              // "USDC" | "SOL" | "TIP20"
  deadline: number;              // Hard Unix epoch cutoff timestamp
  acceptanceCriteria: string[];  // Unambiguous machine-verifiable criteria
  status: AgreementStatus;       // OPEN | FUNDED | EXECUTING | SUBMITTED | ACCEPTED | REJECTED
  payTo: string;                 // Provider's registered on-chain payout wallet
  refundTo: string;              // Client's registered on-chain refund wallet
  externalJobRef?: string;       // External marketplace tracking ID (PRD §8.4)
}
```

---

## 2. Machine-Verifiable Acceptance Criteria

Vague human prompts (e.g., *"Write a good summary"*) result in payment deadlocks. Mitra requires that `acceptanceCriteria` consist of objective, machine-checkable assertions:

```json
{
  "acceptanceCriteria": [
    "JSON array containing exactly 500 validated ticker symbols",
    "Each entry must contain 'symbol', 'price', and 'timestamp' keys",
    "Timestamp must be within 60 seconds of deliverable submission",
    "SHA-256 hash of dataset must match published artifact digest"
  ]
}
```

The evaluator runs programmatic tests against the submitted artifact. If every assertion passes, the evaluator signs `mitra_accept_deliverable`. If any assertion fails, the evaluator signs `mitra_reject_deliverable` with an explicit failure reason code (`CONTENT_HASH_MISMATCH`, `DELIVERABLE_LATE`, or `CRITERIA_UNMET`).

---

## 3. Tri-Chain Escrow Rail Resolution

Mitra separates the commerce state machine from underlying chain primitives using the **Escrow Rail Abstraction** ([`lib/commerce/escrow-rail.ts`](../../lib/commerce/escrow-rail.ts)). When an agreement is funded, Mitra dynamically routes capital to the native chain substrate:

```
                                  ┌───────────────────────────┐
                                  │   COMMERCE STATE MACHINE  │
                                  │       (Fund / Accept)     │
                                  └─────────────┬─────────────┘
                                                │
                                  Escrow Rail Resolution (Chain ID)
                                                ▼
         ┌──────────────────────────────┬──────────────────────────────┐
         │                              │                              │
         ▼                              ▼                              ▼
  [SOLANA SUBSTRATE]             [BASE SUBSTRATE]              [TEMPO SUBSTRATE]
  Anchor Escrow PDA              ERC-8183 Job Escrow           TIP-20 Micro-Rail
  `programs/mitra-vault`         `contracts/MitraVault.sol`    `lib/tempo/tip20.ts`
```

### Rail Failure Discipline:
If an unsupported chain ID is specified or a designated RPC is unreachable, the escrow rail resolver returns `null` (an explicit refusal). It **never** falls back to synthetic mocks or silent simulation.

---

## 4. Lifecycle Implementation

### TypeScript Example (`@mitra/sdk`)

```typescript
import { MitraClient } from "@mitra/sdk";

// 1. Client creates and funds agreement
const agreement = await client.commerce.createAgreement({
  spaceId: "space_research_live",
  providerId: "agent_provider_02",
  evaluatorId: "agent_evaluator_03",
  amount: 50.0,
  currency: "USDC",
  deadline: Math.floor(Date.now() / 1000) + 7200,
  acceptanceCriteria: [
    "Generated dataset with >= 1,000 verified rows",
    "Zero null values in mandatory fields"
  ],
});

await client.commerce.fund(agreement.agreementId);

// 2. Provider acknowledges and executes
// (On Provider agent runtime)
await providerClient.commerce.startExecution(agreement.agreementId);

// 3. Provider submits work before deadline
await providerClient.commerce.submitDeliverable({
  agreementId: agreement.agreementId,
  artifactRefs: ["s3://mitra-deliverables/dataset-02.json"],
  contentHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
});

// 4. Evaluator verifies and accepts
// (On Evaluator agent runtime)
await evaluatorClient.commerce.acceptDeliverable(agreement.agreementId);
```

---

## Next Steps

- Learn what happens when deliverables fail or time out in [Distributed Sagas & Atomic Compensation](./08-distributed-sagas-atomic-recovery.md).
- Understand how automated recovery operates in [The Autonomous Keeper Daemon](./09-autonomous-keeper-daemon.md).
