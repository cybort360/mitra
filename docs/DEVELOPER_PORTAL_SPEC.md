# Mitra Developer Portal & Documentation Specification (v0.1)

**Status:** Normative Documentation Blueprint  
**Date:** October 2026  
**Target Delivery:** 18 Institutional Documentation Pages + `/llms.txt` Machine-Readable Index  
**Governing Specs:** [`MITRA_0_1_FULL_PRODUCT_SPEC.md`](./product/MITRA_0_1_FULL_PRODUCT_SPEC.md) · [`MITRA_PRD.md`](./product/MITRA_PRD.md) · [`INVARIANTS.md`](../forge/INVARIANTS.md) · [ADR-0009](./adr/0009-mandate-semantics-reuse-engraving.md)

---

## 1. Executive Vision & Architectural Philosophy

Mitra is the **Financial Coordination Layer and Clearinghouse for Agentic Commerce**. 

The documentation portal must reflect institutional market infrastructure (DTCC, LCH, Euroclear for autonomous agents), not an informal developer toy or a simple crypto wallet.

### 1.1 The "Stripe × Supabase" Hybrid Standard
1. **Developer-First on the Surface:** Clean, frictionless, 3-minute onboarding. Fast copy-paste recipes with side-by-side **TypeScript (`@mitra/sdk`)** and **Python (`httpx` / `requests`)** code snippets.
2. **Institutional High-Assurance Underneath:** Every claim is backed by formal state transition tables, mathematical netting formulas, and cryptographic invariants (`ALLOW != DISBURSEMENT`).
3. **Tri-Chain Equality:** **Solana, Base, and Tempo are first-class peers.** Neither chain is an afterthought; every multi-chain concept features an interactive 3-way substrate toggle.
4. **Machine-Readable Native:** The documentation is built for both human engineers and autonomous agents, providing a dedicated `/llms.txt` endpoint and MCP prompt discovery.

---

## 2. Portal Anatomy & Interactive Design

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [MITRA DOCS]    [Tracks: 🤖 Agent Devs | 🏛️ Treasury Ops | 🔌 Protocol Integrators]    🔍 Cmd+K   /llms.txt│
├─────────────────────┬─────────────────────────────────────────────────────────────┬───────────────────┤
│ SIDEBAR             │ MAIN CONTENT AREA                                           │ ON THIS PAGE      │
│                     │                                                             │                   │
│ ▼ Getting Started   │ # Engravings & Bounded Authority                            │ • Overview        │
│   • Introduction    │ "Steering changes intent. Engravings bound authority."      │ • Persistent vs   │
│   • 5-Min Quickstart│                                                             │   Consumable      │
│                     │ ┌─ Code Switcher ─────────────────────────────────────────┐ │ • Nonce Spaces    │
│ ▼ Core Primitives   │ │ [TypeScript (@mitra/sdk)]  [Python (REST)]  [Raw EIP-712]│ │ • Code Example    │
│   • Authority       │ └─────────────────────────────────────────────────────────┘ │ • Invariant I-04  │
│   • Commerce        │                                                             │                   │
│   • Clearing        │ ┌─ Chain Substrate ───────────────────────────────────────┐ │                   │
│   • Recovery        │ │ ⚙️ [Solana Devnet]       [Base Sepolia]       [Tempo]     │ │                   │
│                     │ └─────────────────────────────────────────────────────────┘ │                   │
│ ▼ Arcium MPC        │                                                             │                   │
│ ▼ Tri-Chain Rails   │ [Interactive Diagram: The 3 Checks — Vault ➔ Policy ➔ Guard]│                   │
└─────────────────────┴─────────────────────────────────────────────────────────────┴───────────────────┘
```

### 2.1 Core Interactive Controls
- **Multi-Door Persona Switcher:** Allows visitors to filter by track:
  - `[🤖 Agent Developers]` ➔ Emphasizes `@mitra/sdk`, Model Context Protocol (MCP), and quickstarts.
  - `[🏛️ Treasury & Risk Operators]` ➔ Emphasizes Vault limits, Engraving policies, velocity controls, and console audit trails.
  - `[🔌 Protocol Integrators]` ➔ Emphasizes ERC-8183 job escrows, clearinghouse netting cycles, and webhooks.
- **Tri-Chain Substrate Toggle:** Code blocks toggle between **Solana Anchor**, **Base Sepolia (EVM)**, and **Tempo (TIP-20)**.
- **Language Switcher:** Dual-tab code blocks for **TypeScript** and **Python**.
- **Under-the-Hood Collapsibles:** High-level one-liners with expandable tabs showing raw EIP-712 typed-data hashes and Anchor PDA derivations.

---

## 3. The 18-Page Information Architecture

```
SECTION 1: GETTING STARTED & OVERVIEW
  Page 01: Introduction & The Core Thesis ("What is Mitra?")
  Page 02: Quickstart: Safe Agent Spend in 5 Minutes (TypeScript & Python)
  Page 03: The Multi-Door Architecture (Agent Devs, Treasury Ops, Protocol Integrators)

SECTION 2: THE AUTHORITY ARCHITECTURE (ENGRAVINGS & PRIVACY)
  Page 04: Engravings & Mandates: How Principals Bound Agent Authority (ADR-0009)
  Page 05: Confidential Policy Evaluation with Arcium MPC (PRD §11)
  Page 06: The 3 Checks: The Execution Guard Invariant ("ALLOW != DISBURSEMENT")

SECTION 3: COMMERCE, ESCROWS & ATOMIC RECOVERY (TALOS & SAGAS)
  Page 07: Bilateral Agreements & Programmatic DvP Escrow (PRD §28)
  Page 08: Distributed Sagas & Atomic Compensation (Two-phase recovery)
  Page 09: The Autonomous Keeper Daemon (Zero-stranded-capital sweeps)

SECTION 4: THE CLEARINGHOUSE & NETTING
  Page 10: Multilateral Debt Netting: "Clear First. Move Only What Remains."
  Page 11: Epoch Clearing Algorithms & Obligation Reconciliation

SECTION 5: THE TRI-CHAIN SUBSTRATE PLANE (EQUAL PEERS)
  Page 12: Solana Substrate: Anchor PDAs, Vaults & Program State
  Page 13: Base Substrate: EVM ERC-8183 Escrows & Account Abstraction
  Page 14: Tempo Substrate: TIP-20 Micro-Payments & High-Frequency Streaming

SECTION 6: AGENT & OPERATOR INTEGRATION
  Page 15: Model Context Protocol (MCP) Gateway (22 Tools, SSE on Port 3006)
  Page 16: Cognitive Agent Skills & Developer Tooling (CLI, Doctor & Sandbox)

SECTION 7: MARKETPLACES & ECOSYSTEM FRAMEWORKS
  Page 17: Marketplace Interoperability: Virtuals ACP, Olas Mech, Agentverse & x402 (Spec §3.3 & §8)
  Page 18: Ecosystem Integrations: A2A, x402, MPP, ElizaOS & Agent Frameworks (Spec §9–§12)
```

---

## 4. Comprehensive Page-by-Page Specifications

### Page 01: What is Mitra? (The Clearinghouse for Agentic Commerce)
- **Target Persona:** All audiences.
- **Core Narrative:** Why agent wallets and raw payment rails are financial suicide. The difference between moving tokens and coordinating commerce. Framing Mitra as the clearinghouse and market infrastructure (DTCC / Euroclear) for autonomous agents.
- **Key Visual:** Comparison table: *Agent Wallets vs. Payment Rails vs. Mitra Clearinghouse*.
- **Boundary Vocabulary:**
  - `MANDATE != RUNTIME FREEDOM`
  - `ALLOW != DISBURSEMENT`
  - `INTENT != CAPITAL`
  - `NETTING != SETTLEMENT`

---

### Page 02: Quickstart: Safe Agent Spend in 5 Minutes
- **Target Persona:** AI Agent Developers (TypeScript / Python).
- **Core Narrative:** Zero to first transaction. Initializing a vault budget headroom and executing an agreement in 3 lines of code.
- **Dual-Track Recipes:**
  - **Track A (TypeScript SDK):**
    ```typescript
    import { MitraClient } from "@mitra/sdk";
    const client = new MitraClient({ baseUrl: "http://localhost:3005", chainId: 84532 });
    const agreement = await client.commerce.createAgreement({
      budget: 25,
      provider: "agent_provider_01",
      deliverable: "analysis.json"
    });
    ```
  - **Track B (Python REST / LangChain):**
    ```python
    import httpx
    client = httpx.Client(base_url="http://localhost:3005/api/v1")
    agreement = client.post("/agreements", json={
        "spaceId": "space_research_1",
        "budget": {"asset": "USDC", "amount": 25},
        "provider": "agent_provider_01"
    }).json()
    ```
  - **Track C (MCP No-Code):** Connecting Claude Desktop or Cursor to `http://localhost:3006/sse`.

---

### Page 03: The Multi-Door Architecture
- **Target Persona:** Systems Architects & Platform Leads.
- **Core Narrative:** Navigating Mitra across three distinct operational surfaces:
  1. *The Agent Plane:* Manipulation of intents and deliverables via MCP and SDK (zero capital verbs).
  2. *The Operator Plane:* Vault deposits, Mandate issuance, and emergency pause controls.
  3. *The Clearinghouse Plane:* Epoch netting, obligation graphs, and residual on-chain settlement.

---

### Page 04: Engravings & Mandates: How Principals Bound Authority (ADR-0009)
- **Target Persona:** Security Auditors, Enterprise Risk Leads, Agent Developers.
- **Core Narrative:** *"Steering changes intent. Engravings bound authority."* How human principals grant persistent spending rulebooks without giving agents private key custody.
- **The Critical Distinction:**
  - **Engraving (The Mandate):** **PERSISTENT.** Set once by the principal. Holds total budget ($10,000), transaction limits ($500), allowed capabilities, and expiration. Headroom decreases as payments clear.
  - **Authorization:** **SINGLE-USE & CONSUMED ATOMICALLY.** Generated per transaction. Burns single-use nonces (`consumed: true`) to make replay cryptographically impossible.
- **Nonce Namespace Isolation:** `mandateId + agentId` ensuring revoking one mandate never consumes or interferes with another.

---

### Page 05: Confidential Policy Evaluation with Arcium MPC (PRD §11)
- **Target Persona:** Enterprise Treasury, Institutional Quants, Cryptographers.
- **Core Narrative:** Why public blockchains leak sensitive procurement strategies. How Arcium's 4-node MPC cluster evaluates policies over encrypted inputs without revealing numbers on-chain.
- **MPC vs. Zero-Knowledge (ZK):** Why Multi-Party Computation is superior to ZK when neither the buyer, the seller, nor the validator should see confidential budget limits.
- **Circuit Architecture ([`programs/arcium-policy-circuit`](../programs/arcium-policy-circuit)):**
  - Secret Inputs inside MPC: `amount`, `max_transaction`, `budget`, `available_headroom`.
  - Public Binding Fields on-chain: `policyVersion`, `actionDigest`, `vaultId`, `mandateId`, `expiresAt`.

---

### Page 06: The 3 Checks: The Execution Guard Invariant
- **Target Persona:** Smart Contract Engineers & Security Auditors.
- **Core Narrative:** **AN `ALLOW` VERDICT IS NEVER PERMISSION TO MOVE VALUE.**
- **The Load-Bearing Flow:**
  ```
  1. THE BUDGET (Vault) ──▶ 2. THE POLICY (Engraving) ──▶ 3. THE EXECUTION GUARD (On-Chain)
  ```
- **Calldata Binding:** The on-chain contract re-computes `keccak256(recipient, amount, nonce, expiry)`. If calldata drifts by 1 byte between evaluation and settlement, the blockchain reverts.

---

### Page 07: Bilateral Agreements & Programmatic DvP Escrow (PRD §28)
- **Target Persona:** Agent Developers & Marketplace Integrators.
- **Core Narrative:** Moving beyond speculative upfront transfers. Establishing Delivery-versus-Payment (DvP) escrows where funds are locked conditionally on Solana PDAs or Base ERC-8183 contracts until evaluators submit cryptographic acceptance proofs.

---

### Page 08: Distributed Sagas & Atomic Compensation (TALOS Model)
- **Target Persona:** Distributed Systems Engineers & Backend Architects.
- **Core Narrative:** Crash-proofing multi-agent pipelines.
- **Saga Invariants:**
  - *Committed Refund Routes (F76/F80):* `routeCommitment = keccak256(refundRoute)` is committed before funds move.
  - *Fund Order Invariant (F77):* Agreement writes precede Saga writes to prevent orphan armed sagas.
  - *Two-Phase Unwinds:* Programmatic rollback routes if intermediate pipeline steps fail.

---

### Page 09: The Autonomous Keeper Daemon (PRD §28.5)
- **Target Persona:** Operators, Validators, DevOps.
- **Core Narrative:** **The Zero-Stranded-Capital Guarantee.**
- **The Mechanism ([`scripts/keeper-daemon.ts`](../scripts/keeper-daemon.ts)):**
  - The on-chain clock is the sole authority.
  - When an escrow deadline expires (`block.timestamp >= timeout`), any keeper node can call `refundJob` to sweep capital back to the vault.
  - No human dispute filings, no chasing dead bots.

---

### Page 10: Multilateral Debt Netting: "Clear First. Move Only What Remains."
- **Target Persona:** Economists, Treasury Leads, DeFi Protocols.
- **Core Narrative:** The clearinghouse engine that collapses circular debt.
- **The Netting Vector Example:**
  | Measure | Amount | Description |
  |---|---:|---|
  | **Gross Contracted Obligations** | **$100,000 USDC** | Bilateral agreements across network agents |
  | **Multilateral Clearing Reduction** | **$42,000 USDC** | Circular debt canceled across epoch netting |
  | **Residual On-Chain Settlement** | **$58,000 USDC** | Actual capital moved on-chain |
  | **Capital & Liquidity Preserved** | **42.0%** | 90%+ gas savings, zero credit risk |

---

### Page 11: Epoch Clearing Algorithms & Obligation Reconciliation
- **Target Persona:** Core Protocol Engineers & Quants.
- **Core Narrative:** Mathematical formulation of cycle cancellation. Directed debt graphs, double-entry T-account ledger invariants, and settlement vector generation implemented in [`lib/kernel/clearing.ts`](../lib/kernel/clearing.ts).

---

### Page 12: Solana Substrate: Anchor PDAs, Vaults & Program State
- **Target Persona:** Solana Developers (Rust / Anchor).
- **Core Narrative:** High-speed, sub-second execution on Solana Devnet.
- **Key Artifacts ([`programs/mitra-vault`](../programs/mitra-vault)):**
  - 147 passing Cargo tests.
  - 154-byte `JobEscrow` PDAs (`[b"escrow", vault, job_id]`).
  - Anchor instructions: `initialize_vault`, `reserve`, `release`, `lock_escrow`, `release_escrow`, `refund_escrow`.

---

### Page 13: Base Substrate: EVM ERC-8183 Escrows & Account Abstraction
- **Target Persona:** Ethereum / EVM Developers (Solidity / Viem).
- **Core Narrative:** EVM institutional interoperability on Base Sepolia.
- **Key Artifacts ([`contracts/src/MitraJobEscrow.sol`](../contracts/src/MitraJobEscrow.sol)):**
  - 63 passing Foundry tests.
  - ERC-8183 standard alignment (Client, Provider, Evaluator).
  - ERC-4337 smart account & Coinbase Smart Wallet compatibility.

---

### Page 14: Tempo Substrate: TIP-20 Micro-Payments & High-Frequency Streaming
- **Target Persona:** FinTech & High-Frequency Agent Developers.
- **Core Narrative:** Sub-cent recurring payment streams on Tempo Moderato.
- **Key Artifacts ([`lib/tempo/`](../lib/tempo/)):**
  - TIP-20 stablecoin streaming without standard gas friction.
  - Sub-cent micro-debt resolution for prompt-by-prompt agent interaction.

---

### Page 15: Model Context Protocol (MCP) Gateway
- **Target Persona:** AI Agent Developers & LLM Engineers.
- **Core Narrative:** Connecting agents to Mitra via Anthropic's Model Context Protocol.
- **Gateway Architecture ([`scripts/mcp-server-daemon.ts`](../scripts/mcp-server-daemon.ts)):**
  - Runs on `PORT=3006` over Streamable HTTP (`/mcp`) and Server-Sent Events (`/sse`).
  - Exposes 22 served tools (inbox polling, agreement creation, deliverable submission).
  - Loopback binding, DNS rebinding guards, and strict exclusion of capital-minting verbs (F100).

---

### Page 16: Cognitive Agent Skills & Developer Tooling
- **Target Persona:** Agent Prompt Engineers, DevOps, Hackathon Builders.
- **Core Narrative:** Pre-built cognitive skill bundles in [`skills/`](../skills/):
  - `mitra-buyer` · `mitra-provider` · `mitra-evaluator` · `mitra-treasury` · `mitra-core`.
  - System prompt templates for Cursor, Windsurf, and Claude.
- **Tooling Suite:**
  - `npm run doctor` — 2-second live substrate inspector (`scripts/doctor.ts`).
  - `npm run sandbox` — Time-travel simulation engine for zero-gas local testing.
  - `npm run agents:run` — 3-agent continuous autonomous loop.

---

## 5. Machine-Readable Documentation Layer (`/llms.txt`)

To ensure autonomous AI agents and IDE assistants can consume Mitra's documentation autonomously:

1. **Root `/llms.txt` Endpoint:**  
   A standardized, high-density markdown summary providing:
   - High-level protocol thesis and core invariant rules.
   - List of all 22 MCP tools with parameter schemas and return types.
   - Core REST API endpoints (`/api/v1/mandates`, `/api/v1/agreements`, `/api/v1/inbox`, `/api/v1/clearing`).
   - Standard TypeScript and Python invocation patterns.
2. **MCP Prompt Registration:**  
   Exposing `prompts/list` on the MCP Gateway (`PORT=3006`) so connecting LLMs can dynamically pull the 5 cognitive skill instructions on boot.

---

## 6. Implementation Checklist & Verification

When constructing the documentation pages:
- [ ] Every on-chain code example must support the 3-way substrate toggle (Solana, Base, Tempo).
- [ ] Every developer recipe must feature dual TypeScript and Python tabs.
- [ ] Invariant callouts must cite exact repository files and ADR references.
- [ ] The fee model must remain abstract and protocol-configurable for v0.1.
- [ ] The `/llms.txt` file must be generated directly from the canonical schemas.
