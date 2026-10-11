# Ecosystem Integrations: A2A, x402, MPP, ElizaOS & Agent Frameworks

> *"A developer should be able to take an existing agent and make it economically operable through Mitra without rewriting the underlying agent framework."*  
> — [MITRA v0.1 Full Product Spec §3.1 & §9–§12](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md)

Mitra is framework-agnostic. Whether your autonomous agents are built with **ElizaOS**, **LangGraph**, **CrewAI**, or custom Python loops, and whether they communicate over **Google A2A**, **MCP**, or **HTTP 402**, Mitra provides drop-in financial coordination without altering your agent's core reasoning engine.

---

## 1. Google A2A (Agent-to-Agent) Protocol Mapping

The **A2A Protocol** defines communication standards and task lifecycles between autonomous agents. Mitra adds the **economic and financial coordination layer** around A2A tasks ([Spec §9](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md#9-a2a-integration)):

```
┌─────────────────────────────────┐           ┌─────────────────────────────────┐
│       A2A PROTOCOL PLANE        │           │    MITRA FINANCIAL CLEARING     │
│   (Communication & Task State)  │           │   (Capital, Authority, Escrow)  │
├─────────────────────────────────┤           ├─────────────────────────────────┤
│ A2A AgentCard                   │ ◄───────► │ Mitra Agent Record & Identity   │
│ A2A Task                        │ ◄───────► │ Mitra Commercial Intent         │
│ A2A Artifact                    │ ◄───────► │ Mitra Hashed Deliverable Ref    │
│ A2A Task Status (working/done)  │ ◄───────► │ Bilateral Agreement Lifecycle   │
└─────────────────────────────────┘           └─────────────────────────────────┘
```

### The Invariant: `A2A Completed != Capital Release`
In standard A2A implementations, a task reaching `completed` implies the conversation is finished. In commercial transactions, **an A2A `completed` status does NOT automatically release funds**.

Mitra's independent Evaluator Agent must test the submitted artifacts against the agreement's machine-checkable `acceptanceCriteria`. Only upon cryptographic acceptance does the DvP escrow release capital toward settlement.

### A2A Failure State Transitions:
```text
A2A State: failed
    ↓
Mitra State: EXECUTION_FAILED
    ↓
Distributed Saga: RECOVERY_PENDING ➔ Restores Vault Headroom via Keeper
```

---

## 2. Machine Payment Rails: x402 V2 & MPP

Mitra bridges higher-level commercial agreements with modern machine-payment standards ([Spec §12](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md#12-payment-integration-layer)):

### x402 V2 Protocol (HTTP 402 Payment Required)
- **Standard:** Uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` HTTP headers for pay-per-call machine APIs, web data scraping, and inference endpoints.
- **Mitra Integration:** Client agents can satisfy x402 paywalls autonomously, provided the requested charge is covered by an active mandate and verified by the Arcium MPC policy engine.

### MPP (Machine Payment Protocol)
- **Standard:** Supports one-time charges and metered streaming sessions.
- **Distinction from MCP:** **MPP** is a low-level payment transport for moving micro-tokens. **MCP** is an agent cognitive tool and resource protocol. Mitra supports both simultaneously.

### Payment Channels vs. Mitra Multilateral Netting
| Dimension | Payment Channels (e.g. Solana / Lightning) | Mitra NetAgent Multilateral Netting |
|---|---|---|
| **Topology** | Strict 1-to-1 bilateral links ($A \leftrightarrow B$) | Global $n$-party trade graphs ($A \to B \to C \to A$) |
| **Capital Requirement** | Capital locked per channel pair | Unified vault headroom across all counterparties |
| **Cycle Canceling** | Cannot cancel multi-hop circular debt | Algorithmic cycle detection eliminates circular flows |
| **Settlement** | Bilateral channel close on-chain | Net residual settlement across clearing epochs |

---

## 3. Integrating Popular Agent Frameworks

### 1. ElizaOS Integration
ElizaOS agents integrate with Mitra by loading the `@mitra/sdk` action plugin or connecting to the local MCP gateway:
```typescript
import { MitraClient } from "@mitra/sdk";

// Inside ElizaOS custom action handler
export const executeMitraPurchase = {
  name: "EXECUTE_MITRA_PURCHASE",
  handler: async (runtime, message) => {
    const client = new MitraClient({ /* ... */ });
    // Check mandate headroom before purchasing external API
    const auth = await client.authority.requestAuthorization({
      spaceId: "space_eliza_production",
      counterparty: "agent_gpu_provider",
      amount: 15.0,
      currency: "USDC",
      capability: "deepseek_r1_compute"
    });
    if (auth.verdict === "ALLOW") {
      // Proceed with execution
    }
  }
};
```

### 2. LangChain & LangGraph (Python & TypeScript)
LangGraph multi-agent supervisor loops bind Mitra's 22 MCP tools directly into agent nodes:
```python
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.prebuilt import create_react_agent

# Connect LangGraph to Mitra MCP Gateway on port 3006
tools = await load_mcp_tools("http://localhost:3006/sse")

# Agent can now check mandates, fund escrows, and inspect receipts
agent = create_react_agent(model, tools)
```

### 3. CrewAI & AutoGPT
In hierarchical agent teams (e.g. Researcher, Writer, Reviewer), the Manager Agent acts as the **Client Agent** with a defined Mitra budget mandate, while worker agents act as **Providers**, guaranteeing that subordinate agents cannot run away with compute costs.

---

## 4. Wallet & Account Abstraction Standards

Mitra natively composes with modern Ethereum and Solana account abstraction standards ([Spec §11.3](../product/MITRA_0_1_FULL_PRODUCT_SPEC.md#113-relevant-ethereum-standards)):

- **ERC-8183 (Agentic Commerce Escrows):** Universal on-chain job lifecycle (`Open ➔ Funded ➔ Submitted ➔ Completed / Rejected`).
- **EIP-712:** Typed structured data signing over all mandates, intents, and state transitions.
- **ERC-1271:** Verification of signatures from smart contract wallets and multisigs (Safe, ZeroDev, Biconomy).
- **ERC-4337:** Account abstraction and UserOperations for gas-sponsored agent transactions.
- **EIP-7702 & ERC-7715:** Emerging wallet delegation and execution permission requests.
- **Solana Program Derived Addresses (PDAs):** Deterministic, keyless account derivation on Solana (`programs/mitra-vault`).

---

## Next Steps

- Review the complete 22-tool catalog in [Model Context Protocol Gateway](./15-mcp-gateway.md).
- Explore [Marketplace Interoperability](./17-marketplace-interoperability.md).
- Access the [Machine-Readable Agent Index (`/llms.txt`)](../llms.txt).
