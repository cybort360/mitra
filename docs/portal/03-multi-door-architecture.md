# The Multi-Door Architecture

Mitra is built with a **Multi-Door Architecture**: a single unified clearinghouse and policy kernel accessed through three specialized, role-tailored entry doors.

Whether you are an engineer scripting autonomous LLMs, a CFO managing enterprise capital limits, or a DeFi protocol architect integrating job escrows, Mitra provides dedicated abstractions for your domain.

```
                                 ┌─────────────────────────────┐
                                 │     MITRA CLEARINGHOUSE     │
                                 │       & VAULT KERNEL        │
                                 └──────────────┬──────────────┘
                     ▲                          │                          ▲
                     │                          │                          │
         ┌───────────┴───────────┐  ┌───────────┴───────────┐  ┌───────────┴───────────┐
         │        DOOR 1         │  │        DOOR 2         │  │        DOOR 3         │
         │   🤖 AGENT BUILDERS   │  │  🏛️ TREASURY & RISK   │  │  🔌 PROTOCOL & RAILS  │
         │                       │  │                       │  │                       │
         │ • @mitra/sdk          │  │ • Operator Console    │  │ • ERC-8183 Escrows    │
         │ • 22 MCP Tools (:3006)│  │ • Mandate Engravings  │  │ • Multilateral Netting│
         │ • Cognitive Skills    │  │ • Velocity Controls   │  │ • Webhook Callbacks   │
         │ • REST API (:3005)    │  │ • Audit Ledger        │  │ • Tri-Chain Adapters  │
         └───────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

---

## Door 1: 🤖 Agent Developers (Runtime Agency)

Agent developers build autonomous actors that procure services, sell compute, and collaborate in multi-agent workflows.

### Primary Touchpoints:
- **`@mitra/sdk`:** Lightweight TypeScript client providing cryptographic signing helpers and type-safe method bindings.
- **Model Context Protocol (MCP) Gateway:** Streamable HTTP and Server-Sent Events (SSE) server running on `PORT=3006`. Exposes 22 standardized tools natively compatible with Claude, Cursor, and custom agent runtimes.
- **Cognitive Agent Skills:** Pre-packaged system prompts in `skills/` (`mitra-core`, `mitra-buyer`, `mitra-provider`, `mitra-evaluator`, `mitra-treasury`) registered directly on the MCP server.

### Key Invariant for Agent Devs:
**No agent holds capital keys.** An agent never interacts with raw private keys for treasury disbursement. Every spend request is an intent signed with an agent-specific operational key (`agentId`), bound to an existing space and mandate.

---

## 2. Door 2: 🏛️ Treasury & Risk Operators (The Capital Boundary)

Treasury managers, risk committees, and human enterprise principals define the rules of engagement before agents are given spending autonomy.

### Primary Touchpoints:
- **Operator Console:** Intuitive administrative dashboard for monitoring live exposures, active agreements, and agent balances.
- **Engravings (Mandates):** Cryptographic spending bounds that set maximum budget, per-transaction velocity limits, allowed counterparties, and valid expiration windows.
- **Space Scopes:** Budget boundaries that group related agents and enforce collective spending constraints without restricting agent mobility.
- **Emergency Circuit Breakers:** System-wide or Space-specific pause scopes that freeze capital disbursement without locking agent communications.

### Key Invariant for Treasury Ops:
**Unbounded spend is mathematically impossible.** An agent cannot exceed its allocated headroom even if it generates an infinite loop of requests. If headroom drops to zero, the execution guard rejects further authorizations fail-closed (`SPACE_BUDGET_EXCEEDED`).

---

## 3. Door 3: 🔌 Protocol & Marketplace Integrators (Clearing Infrastructure)

Protocol architects and decentralized marketplaces consume Mitra as an institutional settlement clearinghouse.

### Primary Touchpoints:
- **ERC-8183 Job Escrows:** Standardized EVM smart contracts supporting programmatic milestone payments, third-party evaluation, and automatic timeout refunds.
- **Anchor PDAs & Program State:** Native Solana program (`programs/mitra-vault`) providing microsecond execution and sub-cent transaction fees.
- **Tempo TIP-20 Streams:** Continuous streaming micro-payments designed for high-frequency agent compute and token-by-token metering.
- **Multilateral Netting Engine:** An automated cycle-canceling algorithm that computes net settlement vectors across complex trade graphs, eliminating gross liquidity requirements.

### Key Invariant for Integrators:
**Composability without custody risk.** Mitra integrates directly with existing escrow standards and agent protocols (including Virtuals ACP, Autonolas, and ElizaOS) without requiring partners to surrender smart contract ownership.

---

## 4. Role & Permission Matrix

| Role | Open Agreement | Fund Escrow | Start Execution | Submit Work | Evaluate & Accept | Reject & Refund | Edit Mandate |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Client Agent** | ✓ | ✓ | — | — | ✓ | ✓ | — |
| **Provider Agent** | — | — | ✓ | ✓ | — | — | — |
| **Evaluator Agent** | — | — | — | — | ✓ | ✓ | — |
| **Treasury Principal** | — | — | — | — | — | ✓ (Emergency) | ✓ |

---

## Next Steps

- Learn how human principals configure bounded ceilings in [Engravings & Mandates](./04-engravings-and-mandates.md).
- Dive into [Confidential Policy Evaluation with Arcium MPC](./05-arcium-mpc-confidential-policy.md).
