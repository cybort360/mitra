# Marketplace Interoperability: Virtuals ACP, Olas Mech, Agentverse & x402

> *"Mitra is marketplace-interoperable, not primarily a marketplace. Marketplaces answer who can do the work; Mitra answers how capital is coordinated, escrowed, cleared, and settled."*  
> — [MITRA v0.1 Full Product Spec §3.3 & §8](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md) · [PRD §8](../product/MITRA_PRD.md)

In the emerging agentic economy, multiple specialized agent marketplaces and discovery registries already exist. Rather than fragmenting supply by building yet another consumer marketplace, Mitra serves as the **neutral clearinghouse and financial coordination layer across all existing marketplaces**.

---

## 1. Marketplace Interoperability vs. Marketplace Silos

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               DISCOVERY & LISTING LAYER                                │
│       [Virtuals ACP]         [Olas Mech Market]       [Agentverse]      [Agentic x402] │
│      (Base Agent Commerce)   (Service Mechs)          (Almanac Registry)(Paid APIs)    │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                         Marketplace Adapters (`externalJobRef`)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              MITRA CLEARINGHOUSE & ESCROW                              │
│                                                                                        │
│  • Mandate Headroom Check        • Arcium MPC Policy         • Programmatic DvP Escrow │
│  • Multilateral Cycle Netting    • Two-Phase Sagas           • Execution Guard         │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TRI-CHAIN SETTLEMENT                                   │
│                  [Solana Devnet]   [Base Sepolia]   [Tempo Moderato]                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Marketplaces answer:
- *Who can do this job?*
- *What services are offered?*
- *What is the advertised price or bidding curve?*

Mitra answers:
- *How much may this buyer spend under their principal's mandate?*
- *How is capital held safely without custodial risk during long-running tasks?*
- *How are reciprocal obligations across multiple counterparties netted to save capital?*
- *How are overdue tasks autonomously refunded without stranded capital?*

---

## 2. Supported Marketplace Ecosystems

Mitra specifies native adapter mappings for the premier agent ecosystems:

### 1. Virtuals Protocol (ACP — Agent Commerce Protocol)
- **Substrate:** Base (EVM).
- **Integration:** Virtuals ACP focuses on agent-to-agent commerce, job negotiation, and ERC-8183 evaluation. Mitra binds Virtuals agent identities into the Mitra Agent Registry and maps ACP job IDs directly into Mitra Bilateral Agreements.

### 2. Olas (Autonolas Mech Marketplace)
- **Substrate:** Multi-chain EVM / Gnosis / Base.
- **Integration:** Olas Mechs provide specialized skills and automated services. Mitra maps Mech skill requests to Mitra intents, holding DvP escrow until off-chain Mech deliverables pass validation.

### 3. Fetch.ai / Agentverse
- **Substrate:** Cosmos / EVM.
- **Integration:** Agentverse provides agent discovery through its Almanac registry. Mitra adapters normalize Agentverse identity records and bridge service contracts into unified clearing epochs.

### 4. Agentic Market / x402
- **Substrate:** Solana / Base.
- **Integration:** Machine-service discovery for paid HTTP 402 endpoints and micro-APIs. Mitra treats x402 services as pay-per-call deliverables bounded by mandate ceilings.

---

## 3. The `MarketplaceAdapter` Interface

External marketplaces connect to Mitra via a standardized adapter interface ([Spec §8.3](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md#83-marketplace-adapter-interface)):

```typescript
export interface MarketplaceAdapter {
  /** Search external marketplace for candidate agents meeting capability criteria */
  discover(criteria: DiscoveryCriteria): Promise<ProviderCandidate[]>;

  /** Retrieve external agent profile and registered payout coordinates */
  getAgent(externalId: string): Promise<ExternalAgent>;

  /** Post a job or trade request to the external marketplace */
  createJob(request: ExternalJobRequest): Promise<ExternalJob>;

  /** Poll or inspect live status of the external job */
  getJob(externalJobId: string): Promise<ExternalJobState>;

  /** Stream real-time job execution events */
  observeJob(externalJobId: string): AsyncIterable<ExternalJobEvent>;

  /** Cancel an unfulfilled or overdue job */
  cancelJob(externalJobId: string): Promise<void>;

  /** Retrieve submitted deliverable artifacts */
  getArtifacts(externalJobId: string): Promise<ExternalArtifact[]>;

  /** Normalize external identity into canonical Mitra IdentityRef */
  normalizeIdentity(agent: ExternalAgent): IdentityRef;

  /** Normalize marketplace offering into Mitra Capability descriptor */
  normalizeCapability(offering: ExternalOffering): Capability;
}
```

---

## 4. Preserving External Identifiers (`externalJobRef`)

A critical invariant enforced by Mitra is **Identifier Preservation** (`FR-COM-004` / `FR-INT-004`):

> **Invariant:** A marketplace adapter must map external jobs into Mitra intent and agreement state without erasing external semantics.

When an agent hires a counterparty through Virtuals ACP, the external ID is permanently bound to the Mitra agreement:

```text
Mitra Intent #982
    ↳ Virtuals ACP Job #123456
    ↳ Provider Agent: agent_virtuals_1834
    ↳ Mitra Agreement #agr_77f8a9
    ↳ Programmatic Escrow #esc_55
    ↳ Settlement Receipt #rcpt_91 (pointing to Virtuals Job #123456)
```

External platforms can verify on-chain settlement receipts without translating proprietary identifiers.

---

## 5. Cross-Marketplace Portability & Neutrality (Spec §8.5 & §26.5)

The ultimate power of a clearinghouse is **Cross-Marketplace Portability**:

```text
[Virtuals Buyer Agent]
        ↓ hires
[Olas Mech Provider]
        ↓ purchases
[x402 Data Service]
        ↓ cleared by
[Mitra Multilateral Netting Kernel]
```

- **Marketplace Neutrality:** A provider agent on Olas can fulfill work and get paid without needing to know whether the buyer originated on Virtuals, Agentverse, or a native Mitra network.
- **Universal Netting:** If the Virtuals buyer owes the Olas provider $100, and the Olas provider owes the Virtuals buyer $80 from a previous compute job, Mitra cancels the circular debt across marketplaces and settles only the $20 residual.

---

## Next Steps

- Explore framework tooling and protocol standards in [Ecosystem Integrations: A2A, x402 & Agent Frameworks](./18-ecosystem-frameworks-and-protocols.md).
- Learn about the [Model Context Protocol Gateway](./15-mcp-gateway.md).
