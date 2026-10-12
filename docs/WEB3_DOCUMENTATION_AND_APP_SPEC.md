# Mitra: Web3 Protocol Documentation & In-App Terminal Specification

**Status:** Normative Architecture & UX Specification  
**Version:** 1.0 (Web3 Protocol Standard)  
**Date:** October 2026  
**Governing Documents:** [`MITRA_PRD.md`](./product/MITRA_PRD.md) · [`MITRA_0_1_FULL_PRODUCT_SPEC.md`](./product/MITRA_0_1_FULL_PRODUCT_SPEC.md) · [`INVARIANTS.md`](../forge/INVARIANTS.md) · [`PROOF_LEDGER.md`](../forge/PROOF_LEDGER.md)

---

## 1. Executive Protocol Positioning

Mitra is **The Financial Coordination Layer and Institutional Clearinghouse for Agentic Commerce**.

Mitra is neither a general-purpose L1/L2 blockchain nor a subjective jury protocol. Mitra is dedicated institutional financial market infrastructure—the DTCC, LCH, and Euroclear for autonomous AI agents. 

### Why Mitra Exists: The Agentic Commerce Problem
* **Unbounded Private Keys are Financial Suicide:** Giving an autonomous LLM agent direct custody of a private key or unfettered access to an on-chain wallet allows a single prompt injection or reasoning hallucination to drain an enterprise treasury.
* **Gross Settlement Cripples Capital Efficiency:** Point-to-point payment rails (e.g. standard x402 or raw credit card APIs) settle every individual query or task on-chain. When agents transact thousands of times per hour across multi-party supply chains, liquidity gets fragmented, transaction fees explode, and settlement latency compounds.
* **Failures Must Be State Transitions, Not Exceptions:** When an agent fails to deliver or submits malformed outputs, existing systems require human intervention, out-of-band arbitration, or manual escrow chasing.

### The Mitra Solution
Mitra solves this through four deterministic layers:
1. **The Three-Tier Authority Boundary:** Principals define spend bounds (`Mandates`), policies evaluate permissions (`Policy Engine`), and an independent deterministic contract re-verifies the exact transfer before releasing capital (`Execution Guard`). **An `ALLOW` decision is never permission to move value.**
2. **Positional Vault Accounting:** Collateral is compartmentalized into six reconciled positions ($\text{Total} = \text{Available} + \text{Reserved} + \text{Escrowed} + \text{Encumbered} + \text{Settling} + \text{Frozen}$) on Solana (Anchor PDAs), Base Sepolia (EVM `MitraVault.sol` v2), and Tempo Moderato (TIP-20).
3. **Multilateral Cycle Netting:** Bilateral debts across autonomous agent networks are collected into clearing epochs and compressed through graph reduction ($210 gross volume $\to$ $60 net residuals, achieving 71.4% fee and liquidity compression).
4. **Distributed Saga Recovery (ADR-0012):** Every job pre-commits an on-chain compensation route before execution. If a deliverable is rejected or times out, autonomous keepers execute the compensation path on-chain with zero stranded capital.

---

## 2. Web3 Documentation Architecture (The 4-Tier Standard)

Benchmarked against premier Web3 developer portals (Solana, Base, Arbitrum, Uniswap v4), Mitra’s developer documentation is structured into **four distinct tiers**:

```
docs.mitra.exchange
├── TIER 1: GET STARTED & NETWORK REGISTRY
│   ├── Quickstart (5-Minute Onboarding)
│   ├── Network Registry & Deployments
│   ├── Client SDK & CLI Installation
│   └── Health Diagnostics (npm run doctor)
│
├── TIER 2: SOLUTIONS BY OUTCOME
│   ├── Give an Agent a Budget (Mandates & Headroom)
│   ├── Bilateral Commerce & Escrows (Agreements & DvP)
│   ├── Distributed Sagas & Automated Recovery (ADR-0012)
│   ├── Institutional Netting & Clearing (Epoch Settlement)
│   ├── Confidential Policy Enforcement (Arcium MPC)
│   └── Ecosystem Tooling (ElizaOS, LangGraph, CrewAI, x402 V2, Virtuals ACP)
│
├── TIER 3: CORE PROTOCOL SPECIFICATIONS
│   ├── The 3-Tier Authority Model & Allow Invariant
│   ├── Solana Substrate (Anchor PDAs & Lamport Reconciliation)
│   ├── EVM Substrate (MitraVault.sol v2, ERC-8183, MitraClearing.sol)
│   ├── Tempo Substrate (TIP-20 Memo Settlement & Accounting)
│   └── Netting Mathematics & Cycle Cancellation Formal Proofs
│
└── TIER 4: MACHINE & CODING AGENT INTERFACES
    ├── Machine Documentation Index (/llms.txt & /llms-full.txt)
    ├── Mitra MCP Gateway (22 Tools, stdio & Streamable HTTP)
    ├── Cognitive Role Skills (mitra-core, buyer, provider, evaluator, treasury)
    └── Agent Identity & EIP-712 Cryptographic Attestation
```

---

### Tier 1: Get Started & Network Registry

The entry point provides instant verification and friction-free onboarding.

#### 1.1 Quickstart
A 5-minute guide guiding developers through:
1. Cloning and environment verification via `npm run doctor`.
2. Booting the local coordination supervisor via `npm run stack:up`.
3. Running a 3-agent autonomous loop via `npm run agents:run -- --cycles 1`.

#### 1.2 Multi-Chain Deployments Registry
A live, verifiable registry of canonical smart contracts and programs:

| Network | Substrate | Contract / Program ID | Explorer Verification | Revision |
|---|---|---|---|---|
| **Base Sepolia** | EVM (84532) | `MitraVault.sol` v2: `0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489` | [Basescan](https://sepolia.basescan.org/address/0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489) | F61 (Token-scoped) |
| **Base Sepolia** | EVM (84532) | `MitraClearing`: `0xaacba512ba6dc726cb6cafdc2799198dbddb1c4c` | [Basescan](https://sepolia.basescan.org/address/0xaacba512ba6dc726cb6cafdc2799198dbddb1c4c) | F64 (Challenge epochs) |
| **Solana Devnet** | Anchor | `mitra-vault`: `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` | [Solana Explorer](https://explorer.solana.com/address/GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY?cluster=devnet) | LP-4 (Escrow PDAs) |
| **Tempo Moderato**| TIP-20 (42431) | `MitraVault.sol` v2: `0x85409dfc30fa0671b06f98cc56c5b04eb921b568` | Tempo Explorer | F61 (PathUSD native) |
| **Tempo Moderato**| TIP-20 (42431) | `MitraClearing`: `0xd03d91c3ae594c6b1163d89a5cee622c3c1f8688` | Tempo Explorer | F64 (Batch netting) |

---

### Tier 2: Solutions by Outcome

Organized around what developers and institutional operators are building:

1. **"Give an Agent a Budget"**
   * How a human or treasury principal issues an engraved `Mandate` to an autonomous agent.
   * Hard spend limits per transaction, cumulative ceilings, versioning, and instant revocation.
   * Inspecting dynamic headroom through the `@mitra/sdk` and `/api/v1/headroom`.

2. **"Execute Bilateral Commerce & Escrows"**
   * Publishing Request-For-Quotes (RFQs) and discovering intents.
   * Bilateral agreements with locked terms (price, deliverable criteria, deadline).
   * Programmatic Delivery-versus-Payment (DvP) escrow locking on Base Sepolia (ERC-8183) and Solana (Program-Derived Accounts).

3. **"Automate Escrow Recovery & Distributed Sagas"**
   * Implementing PRD §4.5: *Failure is a state transition, not an unhandled exception.*
   * Committing the compensation route hash *before* executing (`ARMED` $\to$ `EXECUTING` $\to$ `STEP_FAILURE` $\to$ `COMPENSATING` $\to$ `RECOVERED`).
   * Automated keeper timeout sweeps refunding locked collateral back to available balances with zero value leakage.

4. **"Clear Institutional Volume via Multilateral Netting"**
   * Aggregating high-frequency agent commerce obligations into clearing epochs.
   * Computing deterministic cycle cancellation ($A \to B \to C \to A$).
   * Publishing Merkle roots on-chain, challenge window mechanics, and finalizing residual settlements.

5. **"Protect Enterprise Strategy with Confidential Policy (Arcium MPC)"**
   * Evaluating private corporate spend rules inside an Arcium 4-node multi-party computation cluster.
   * Evaluating encrypted parameters on-chain without revealing sensitive budgets, supplier pricing, or business logic.

6. **"Connect Multi-Agent Frameworks"**
   * Integrating ElizaOS, LangGraph, CrewAI, AutoGen, and Python agents.
   * Interoperating with marketplace standards: Virtuals Protocol ACP, Olas Mech Marketplace, Agentverse, and Coinbase x402 V2.

---

### Tier 3: Core Protocol Specifications & Formal Invariants

The rigorous mathematical and technical foundation of the protocol:

1. **The Three-Tier Authority Invariant:**
   $$\text{Mandate (Budget)} \longrightarrow \text{Policy Engine (Permission)} \longrightarrow \text{Execution Guard (Settlement)}$$
   * Formal proof that an `ALLOW` authorization token is mathematically distinct from execution authority. The contract independently verifies that the exact recipient, asset, amount, and one-time nonce match the authorized digest.

2. **The Positional Accounting Invariant:**
   $$\text{Total} = \text{Available} + \text{Reserved} + \text{Escrowed} + \text{Encumbered} + \text{Settling} + \text{Frozen}$$
   * Implemented in Rust Anchor on Solana and Solidity on EVM. Positional changes are atomic and conserve total collateral balance ($\Delta \text{Total} = 0$).

3. **Multilateral Netting Mathematical Conservation:**
   $$\sum_{i=1}^{N} \text{NetBalance}_i = 0$$
   * For every clearing cycle, gross bilateral transaction volume is mapped to a directed graph $G = (V, E)$. Cycle elimination cancels circulatory debt, producing an optimal residual transfer set $E^* \subset E$ where $|E^*| \ll |E|$.

---

### Tier 4: Machine & Coding Agent Interfaces

Native capabilities built specifically for autonomous agents and coding assistants:

1. **Machine-Readable Documentation Index (`/llms.txt` & `/llms-full.txt`):**
   * Complete, structured Markdown documentation index following the LLMs.txt standard for instantaneous consumption by AI assistants.

2. **Mitra Model Context Protocol (MCP) Gateway:**
   * 22 standard tools served over stdio (`bin/mitra-mcp.mjs`), SSE, and Streamable HTTP (`:3006`).
   * Provides agents with high-level intent verbs: `mitra_create_intent`, `mitra_fund_agreement`, `mitra_start_execution`, `mitra_submit_deliverable`, `mitra_accept_deliverable`, and `mitra_get_inbox`.

3. **Cognitive Role Skills:**
   * Five verified system prompts and operational guides:
     * `skills/mitra-core`: Fundamental protocol mechanics and signing discipline.
     * `skills/mitra-buyer`: RFQ posting, agreement funding, and deliverable verification.
     * `skills/mitra-provider`: Inbox scanning, execution state transitions, and deliverable submission.
     * `skills/mitra-evaluator`: Independent verification and deliverable acceptance/rejection.
     * `skills/mitra-treasury`: Mandate drafting, budget headroom monitoring, and vault audit trails.

4. **Cryptographic Identity & Attestation:**
   * EIP-712 wallet registration proofs (`mitra_register_agent`).
   * Counterparty authorization checks guaranteeing that providers cannot self-accept deliverables and unauthorized keys cannot instruct capital movements.

---

## 3. The In-App Terminal Architecture (Institutional Console UX)

*(Note: Implementation belongs to Purple and the UI agent; this specification defines layout hierarchy, state machines, and visual systems).*

### 3.1 Design Language: Swiss Technical Drafting Standard
Following [`Mitra inspo/LOOK_BOARD_PROMPT.md`](../Mitra%20inspo/LOOK_BOARD_PROMPT.md):
* **Background:** Crisp White (`#FFFFFF`) with Off-White (`#F4F4F2`) panel containers.
* **Foreground:** High-contrast Black (`#0A0A0A`) with neutral grays (`#707070`, `#D4D4D0`).
* **Accent Colors:** 
  * Electric Blue (`#2B4BFF`) $\to$ Active, Verified, Approved, Reconciled.
  * Signal Red (`#FF3B1F`) $\to$ Refused, Paused, Stepped Failure, Halted.
  * Amber (`#FF9500`) $\to$ Compensating, Pending Timeout, Challenge Window.
* **Typography:**
  * Primary Display: Tight Grotesk (Inter Tight / Geist) with negative tracking.
  * Eyebrows & Data Labels: Letterspaced Monospace in brackets (`[FIG_01]`, `[RECONCILED]`, `[EPOCH_PROPOSED]`).
* **Technical Motifs:** 1px hairline dividers, faint dot-matrix backgrounds inside cards, leader lines with arrowheads, and **thin corner brackets** (`⌜` `⌟`) framing data modules.

---

### 3.2 Screen-by-Screen Layout Specifications

#### Screen 1: Command Overview (`/overview`)
The command center provides real-time multi-chain telemetry and live capital reconciliation:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [MITRA CONSOLE]   Base Sepolia #47.9M   Solana Devnet #510M   Tempo #39.1M   [7/7 PROBES GREEN]  │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  ⌜ FIG_01: POSITIONAL CAPITAL WATERFALL ────────────────────────────────────────────────────── ⌝ │
│  │                                                                                             │ │
│  │  TOTAL ASSETS: $124,500.00 USDC        [✓ RECONCILED TO THE ATOMIC UNIT]                   │ │
│  │  ┌──────────────────────┬─────────────┬─────────────┬─────────────┬───────────┬──────────┐  │ │
│  │  │ AVAILABLE            │ RESERVED    │ ESCROWED    │ ENCUMBERED  │ SETTLING  │ FROZEN   │  │ │
│  │  │ $72,000.00 (57.8%)   │ $15,000.00  │ $22,500.00  │ $10,000.00  │ $5,000.00 │ $0.00    │  │ │
│  │  └──────────────────────┴─────────────┴─────────────┴─────────────┴───────────┴──────────┘  │ │
│  │  (Solana: 11,093,706 lamports · Base: 104,500 USDC · Tempo: 20,000 PathUSD)                 │ │
│  ⌞─────────────────────────────────────────────────────────────────────────────────────────────⌟ │
│                                                                                                  │
│  ⌜ FIG_02: REAL-TIME COMMERCE STREAM (SSE) ─────────────────────────────────────────────────── ⌝ │
│  │  [18:04:12] ag_live_9f2...  OPEN ➔ FUNDED       25 USDC locked in ERC-8183 escrow          │ │
│  │  [18:04:14] ag_live_9f2...  EXECUTING ➔ SUBMIT  Deliverable hash sha256:7b49... attached    │ │
│  │  [18:04:15] ag_live_9f2...  SUBMIT ➔ ACCEPTED   Evaluator agent signed EIP-712 approval    │ │
│  │  [18:04:16] ag_live_9f2...  ACCEPTED ➔ SETTLED  Relayer confirmed on Base Sepolia blk 47.9M│ │
│  ⌞─────────────────────────────────────────────────────────────────────────────────────────────⌟ │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Screen 2: Vaults & Mandate Authority Matrix (`/vaults`)
Institutional governance for collateral accounts and agent spend limits:
* **Collateral Breakdown:** Segmented views for Base Sepolia, Solana Devnet, and Tempo Moderato.
* **Mandate Authority Card:**
  * Displays Principal $\to$ Agent Holder $\to$ Policy Engine triplet.
  * Shows single-spend limit, cumulative ceiling, and dynamic remaining headroom.
  * Provides an instant `Version Bump` button (invalidating old permits) and an `Emergency Freeze` toggle.

#### Screen 3: The Multi-Agent Commerce Floor (`/commerce` & `/agents`)
A real-time coordination matrix monitoring autonomous trading:
* **Agent Matrix:** Cards displaying each registered agent with its verified cryptographic address, assigned cognitive role (`Buyer`, `Provider`, `Evaluator`), and active inbox tasks.
* **Agreement Inspector Drawer:** Clicking an agreement opens an interactive right drawer displaying:
  * Lifecycle state stepper (`OPEN` $\to$ `FUNDED` $\to$ `EXECUTING` $\to$ `SUBMITTED` $\to$ `ACCEPTED` $\to$ `SETTLED`).
  * Deliverable URI and hash proof.
  * Pre-committed compensation route hash (PRD §15.5).
  * Direct blockchain explorer receipt links.

#### Screen 4: Multilateral Netting & Clearinghouse Terminal (`/clearing` & `/obligations`)
The clearing floor displays graph-based cycle cancellation in action:
* **The Cycle Elimination Graph:**
  * Visualizes bilateral agent debt obligations as a directed graph.
  * Shows three or more parties in a debt cycle (e.g., Buyer owes Data Provider $30, Data Provider owes Evaluator $20, Evaluator owes Buyer $5).
  * Collapses the gross cycle into minimal residual settlement transfers ($210 gross $\to$ $60 net, 71.4% compression).
* **Clearing Epoch Stepper:**
  * Tracks epoch progression: `[OPEN]` $\to$ `[RECORD]` $\to$ `[FREEZE]` $\to$ `[PROPOSE]` $\to$ `[CHALLENGE WINDOW]` $\to$ `[SETTLED]`.
  * Displays the on-chain Merkle root (`inputsRoot`) and residual payment receipts.

#### Screen 5: Distributed Saga Failure & Recovery Lab (`/recovery` & `/failure-lab`)
Interactive inspection demonstrating PRD §4.5 (*Failure is a state transition, not an unhandled exception*):
* **Saga Lifecycle Visualizer:**
  * Visualizes failure workflows: `ARMED` $\to$ `EXECUTING` $\to$ `STEP_FAILURE` $\to$ `COMPENSATING` $\to$ `RECOVERED`.
* **Keeper Sweep Countdown:**
  * A live countdown timer tracking block-clock timeout expiration.
  * Demonstrates how an unfulfilled job can be refunded by an autonomous keeper with zero stranded capital.

#### Screen 6: Cryptographic Evidence & Verification Portal (`/evidence`)
Institutional verification interface allowing auditors and judges to independently verify transactions:
* Accepts any Settlement ID or on-chain transaction hash.
* Reconstructs and displays the complete audit bundle:
  * Signed EIP-712 permit payload.
  * Calldata suffix verification on Base or Memo program verification on Tempo/Solana.
  * Raw RPC receipt proving exact debit/credit amounts and block confirmations.

---

## 4. Implementation Alignment & Roadmap

1. **Documentation Portal Integration:**
   * Align the 18 developer portal pages in [`docs/portal/`](./portal/) with the 4-tier structure outlined above.
   * Ensure `/llms.txt` and `/llms-full.txt` index all pages by outcome and technical reference.
2. **In-App Console Alignment:**
   * Support Purple and the UI agent with verified API endpoints, SSE streams (`/api/v1/events/stream`), and test fixtures matching this Swiss technical-drawing specification.
3. **Institutional Assurance:**
   * Preserve all 63 Foundry tests, 147 Rust Anchor tests, and 1,390 Vitest integration tests to ensure continuous verification across all tiers.
