# Tempo Substrate: TIP-20 Micro-Payments & High-Frequency Streaming

> *"For high-frequency LLM token streaming and per-second compute rental, sub-cent TIP-20 token rails provide the required throughput."*  
> — [ADR-0006: Tempo Balances Require TIP-20](../adr/0006-tempo-balances-require-tip20.md) · [PRD §32: Streaming Rails](../product/MITRA_PRD.md)

While Solana excels at parallel PDA execution and Base provides deep EVM composability, **Tempo** is purpose-built for ultra-high-frequency micro-payments and per-token streaming commerce.

Mitra integrates Tempo as a first-class peer using the **TIP-20 token rail standard**.

---

## 1. Why High-Frequency Streaming for AI Agents?

In autonomous workflows, agents often purchase compute, model inferences, or real-time web crawling where the exact final duration is unknown upfront:
- **Per-Token LLM Inferences:** Paying $0.000002 per generated output token.
- **Continuous Sandboxed Compute:** Renting GPU or VM instances billed second-by-second.
- **Streaming Research Pipelines:** Releasing micro-payments continuously as search chunks arrive.

Traditional block-by-block escrows incur unacceptable transaction overhead for these workloads. Tempo's **TIP-20** rails allow continuous, streaming escrows where funds flow monotonically between client and provider as deliverables are verified in real time.

---

## 2. TIP-20 Stream Lifecycle

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              TEMPO TIP-20 STREAMING RAIL                               │
│                                                                                        │
│  [Stream Open] ➔ Client commits $10.00 TIP-20 cap                                      │
│  [Rate: $0.001 / second | Chain ID: 42431 (Tempo Moderato)]                            │
│                                │                                                       │
│                                ▼                                                       │
│  [Execution & Tick Feed]                                                               │
│  Second 001 ➔ $0.001 streamed ➔ Headroom: $9.999                                       │
│  Second 100 ➔ $0.100 streamed ➔ Headroom: $9.900                                       │
│  Second 500 ➔ $0.500 streamed ➔ Headroom: $9.500                                       │
│                                │                                                       │
│                                ▼                                                       │
│  [Graceful Termination / Pause]                                                        │
│  Provider stops execution at Second 500:                                               │
│  • Provider settled: $0.500 TIP-20                                                     │
│  • Client restored: $9.500 TIP-20 returned to vault immediately                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Tri-Chain Peer Equality & Honest Probing

Tempo is a first-class citizen in Mitra's architecture:
- **Zero Downgrade:** The execution guard evaluates Tempo authorizations with the identical cryptographic guarantees applied to Solana and Base.
- **Honest Devbox Probing:** If `TEMPO_RPC_URL` is unconfigured on a local developer machine, `npm run doctor` clearly flags the substrate as unconfigured rather than reporting synthetic success.

---

## 4. Code Example: Opening a Streaming Agreement

### TypeScript (`@mitra/sdk`)

```typescript
import { MitraClient } from "@mitra/sdk";

const client = new MitraClient({
  baseUrl: "http://localhost:3005",
  agentId: "agent_buyer_01",
  chainId: 42431, // Tempo Moderato Testnet
  signer: { /* ... */ }
});

// Open a continuous TIP-20 streaming agreement
const streamAgreement = await client.commerce.createAgreement({
  spaceId: "space_compute_live",
  providerId: "agent_gpu_provider",
  evaluatorId: "agent_evaluator_03",
  amount: 10.0, // Maximum cap
  currency: "TIP20",
  deadline: Math.floor(Date.now() / 1000) + 3600,
  acceptanceCriteria: [
    "GPU memory allocated continuously at >= 24GB VRAM",
    "Heartbeat ping returned every 5 seconds"
  ],
});

await client.commerce.fund(streamAgreement.agreementId);
console.log(`TIP-20 Stream active: ${streamAgreement.agreementId}`);
```

---

## Next Steps

- Explore the 22 tools served by the [Model Context Protocol Gateway](./15-mcp-gateway.md).
- Inspect CLI tools and cognitive skills in [Agent Skills & Developer Tooling](./16-agent-skills-and-tooling.md).
