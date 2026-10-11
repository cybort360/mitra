# Mitra

<p align="center">
  <strong>The Financial Coordination Layer and Clearinghouse for Agentic Commerce</strong><br/>
  <em>Mitra lets a business give an AI agent a budget without giving it the keys.</em>
</p>

<p align="center">
  <a href="programs/mitra-vault"><img src="https://img.shields.io/badge/Track-Solana%20($100k)-14F195?style=flat&logo=solana&logoColor=white" alt="Solana Track"></a>
  <a href="docs/portal/14-tempo-substrate.md"><img src="https://img.shields.io/badge/Track-Tempo%20Moderato%20($100k)-blue?style=flat" alt="Tempo Track"></a>
  <a href="contracts/MitraVault.sol"><img src="https://img.shields.io/badge/Track-Base%20Sepolia%20($25k)-0052FF?style=flat&logo=coinbase&logoColor=white" alt="Base Track"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="tests/"><img src="https://img.shields.io/badge/Tests-1%2C600%20Passing-success" alt="Tests: 1,600 Passing"></a>
  <a href="docs/llms.txt"><img src="https://img.shields.io/badge/Native-llms.txt-purple" alt="llms.txt Native"></a>
</p>

---

## Why Mitra: The Problem

An autonomous AI agent that can spend money is an existential treasury risk. Today, developers face an unacceptable binary choice:

1. **The Custodial Trap (Unbounded Freedom):** Hand the agent naked private keys. If the model hallucinates, suffers a prompt injection attack, or hits an unhandled retry loop, the entire treasury is drained in milliseconds.
2. **The Paralysis Trap (Zero Agency):** Require human approval for every micro-transaction. The agent loses autonomy, high-frequency coordination becomes impossible, and agentic workflows grind to a halt.
3. **The Gross Liquidity Trap:** Existing payment protocols (ERC-20 transfers, Stripe tokens, HTTP 402) move gross capital for every single transaction. In multi-agent economies, moving every leg causes liquidity gridlock, excessive fees, and systemic counterparty risk.

Current payment protocols answer *how* to move tokens from Point A to Point B. They do not answer *whether this exact instruction is permitted to move capital*.

---

## The Solution: Institutional Clearinghouse Architecture

Mitra restores institutional market infrastructure (DTCC, LCH, Euroclear) to autonomous agent commerce: **agents coordinate trade intents, while on-chain vaults and an independent execution guard enforce mathematical spending boundaries.**

```mermaid
flowchart TD
  subgraph AGENT_PLANE["Agent Participation Plane · MCP Gateway (:3006)"]
    direction TB
    BUYER["<b>Client Agent</b><br/>Holds intent, zero capital keys"]
    PROVIDER["<b>Provider Agent</b><br/>Polls inbox & submits deliverable"]
    EVALUATOR["<b>Evaluator Agent</b><br/>Measures criteria & signs verdict"]
  end

  subgraph POLICY_PLANE["Confidential Policy Plane · Arcium MXE"]
    direction TB
    MANDATE["<b>Engraving (Mandate)</b><br/>Persistent principal ceiling"]
    MPC["<b>Arcium 4-Node Cluster</b><br/>Confidential evaluation over encrypted shares"]
    ALLOW["<b>ALLOW Verdict</b><br/>Moves $0 · Reserves $0"]
    MANDATE --> MPC --> ALLOW
  end

  subgraph ESCROW_PLANE["DvP Escrow Rails · Tri-Chain Peer Parity"]
    direction TB
    SOL["<b>Solana Devnet</b><br/>Anchor Program PDAs"]
    BASE["<b>Base Sepolia</b><br/>ERC-8183 Job Escrows"]
    TEMPO["<b>Tempo Moderato</b><br/>TIP-20 Streaming Micro-Rails"]
  end

  subgraph CLEARING_PLANE["Clearing & Settlement Plane"]
    direction TB
    KERNEL["<b>Clearinghouse Kernel</b><br/>Multilateral cycle debt netting"]
    GUARD["<b>EXECUTION GUARD</b><br/>Independent on-chain re-derivation"]
    SETTLE["<b>Net Settlement</b><br/>Clear first. Move only what remains."]
    KERNEL --> GUARD --> SETTLE
  end

  BUYER -->|"1. Request Intent"| MPC
  ALLOW -->|"2. Authorization"| BUYER
  BUYER -->|"3. Fund Escrow"| ESCROW_PLANE
  ESCROW_PLANE -->|"4. Work Required"| PROVIDER
  PROVIDER -->|"5. Submit Hashed Artifact"| EVALUATOR
  EVALUATOR -->|"6. Accept Deliverable"| KERNEL

  classDef step fill:#f5f5f5,stroke:#737373,stroke-width:2px,color:#0a0a0a
  classDef mark fill:#ffffff,stroke:#0a0a0a,stroke-width:3px,color:#0a0a0a
  classDef gate fill:#0a0a0a,stroke:#0a0a0a,stroke-width:3px,color:#ffffff
  class BUYER,PROVIDER,EVALUATOR,MANDATE,MPC,SOL,BASE,TEMPO,KERNEL step
  class ALLOW,SETTLE mark
  class GUARD gate
  style AGENT_PLANE fill:#fafafa,stroke:#e5e5e5,stroke-width:2px,color:#0a0a0a
  style POLICY_PLANE fill:#fafafa,stroke:#e5e5e5,stroke-width:2px,color:#0a0a0a
  style ESCROW_PLANE fill:#fafafa,stroke:#e5e5e5,stroke-width:2px,color:#0a0a0a
  style CLEARING_PLANE fill:#fafafa,stroke:#e5e5e5,stroke-width:2px,color:#0a0a0a
```

---

## The One Mechanism: The Irreversible Boundary

```mermaid
flowchart LR
  M["<b>Check 1: Mandate</b><br/>How much may I spend?<br/>Persistent Engraving ceiling"]
  P["<b>Check 2: Policy Engine</b><br/>Who authorized it?<br/>Arcium MPC Confidential ALLOW"]
  G["<b>Check 3: Execution Guard</b><br/>May this exact instruction disburse?<br/>Independent On-Chain Re-derivation"]
  S["<b>Capital Disbursement</b><br/>Settles Net Remainder"]

  M --> P --> G --> S

  W["An ALLOW moves zero capital.<br/>Skipping the guard is NO guarantee."]
  W -.-> G

  classDef step fill:#f5f5f5,stroke:#737373,stroke-width:2px,color:#0a0a0a
  classDef gate fill:#0a0a0a,stroke:#0a0a0a,stroke-width:3px,color:#ffffff
  classDef note fill:#ffffff,stroke:#e5e5e5,stroke-width:1px,color:#737373
  class M,P step
  class G gate
  class S step
  class W note
```

**An `ALLOW` decision is never itself permission to move value.** The policy engine decides whether an action is permitted; the execution guard independently re-derives whether *this exact instruction* may move capital. Neither a human nor an agent can supply their own spend decision.

### Boundary Vocabulary

| Term A | $\neq$ | Term B | Architectural Reality |
|---|---|---|---|
| **`MANDATE`** | $\neq$ | **`RUNTIME FREEDOM`** | A mandate is an immovable ceiling set by human principals. Agents cannot modify their own limits. |
| **`ALLOW`** | $\neq$ | **`DISBURSEMENT`** | An `ALLOW` verdict confirms policy adherence. It moves zero capital and reserves zero tokens. |
| **`INTENT`** | $\neq$ | **`CAPITAL`** | Agents negotiate commercial intents and bilateral agreements. Capital remains locked in programmatic escrows. |
| **`NETTING`** | $\neq$ | **`SETTLEMENT`** | Netting mathematically cancels offsetting obligations across cycles. Settlement is the physical transfer of the remaining balance. |
| **`ENGRAVING`** | $\neq$ | **`AUTHORIZATION`** | An engraving is a persistent budget ceiling. An authorization is a single-use token consumed atomically upon execution. |

---

## The Authority Model: What It Cannot Claim

Following strict institutional assurance, every subsystem has explicit negative boundaries:

| Authority or Surface | Primary Responsibility | What it **cannot** claim |
|---|---|---|
| **Client Agent** | Posts trade intent within principal's mandate | Cannot mint authority, cannot disburse funds directly |
| **Provider Agent** | Executes service, hashes artifacts, submits work | Cannot release escrow, cannot alter payment terms |
| **Evaluator Agent** | Measures deliverable against acceptance criteria | Cannot touch escrowed capital; verdict is purely evidentiary |
| **Policy Engine (Arcium MXE)** | Evaluates rules and confidential limits via MPC | An `ALLOW` cannot disburse capital or skip the execution guard |
| **Execution Guard** | Independently re-derives spend authority on-chain | Cannot fabricate transactions; operates strictly on valid `ACCEPTED` escrows |
| **Clearinghouse Kernel** | Cancels cyclic obligations across epochs | Cannot alter net balances; zero-sum invariant strictly preserved |
| **Operator Console** | Presents audit telemetry, exposure, and headroom | A dashboard display is never on-chain financial authority |

---

## Fewer Payments Move: Multilateral Netting

Where parties owe each other in a cycle, only the net remainder settles.

```
       [Agent A]
      /         ▲
$100 /           \ $40
    ▼             \
[Agent B] ───────► [Agent C]
           $70
```

### The Netting Vector:

| Measure | Amount | Meaning |
|---|---:|---|
| **Gross obligations** | **$210.00** | Finalized reciprocal obligations ($A \to B \$100, B \to C \$70, C \to A \$40$) |
| **Gross movement cleared** | **$150.00** | Circular debt canceled by multilateral cycle netting |
| **Residual net settlement** | **$60.00** | Physical capital moved on-chain (A pays B $30, A pays C $30) |
| **Liquidity compression** | **71.4%** | Capital saved without requiring gross liquidity reserves |

Two hundred and ten dollars of obligation, sixty dollars of movement. The saving grows with the size of the cycle, which is what makes it a network effect rather than a fee.

---

## Live Settlements & Proven Evidence

Every figure this repository reports is read back from the chain or the database *after* the operation, never from the caller's return value (the F86 rule):

| Rail | Substrate | Evidence (Transaction Hash / Slot) | Status |
|---|---|---|:---:|
| **ERC-8183 Escrow** | Base Sepolia | `0x75dbc7429188d30e38a2e1d7cf92f025d57b0fb928` | **LIVE_DEMONSTRATED** |
| **Mitra Vault Program** | Solana Devnet | `jW14aBAbxPfxM7P1yLqL7aF77R4z47W7R4K6r8HWZ` | **LIVE_DEMONSTRATED** |
| **EVM Smart Contracts** | Foundry | 63 / 63 passed (`contracts/MitraVault.sol`) | **TESTED** |
| **Solana Anchor Program** | Rust / Cargo | 147 / 147 passed (`programs/mitra-vault/`) | **TESTED** |
| **Core Kernel & Routes** | Vitest | 1,390 passed, 83 skipped without credentials | **TESTED** |
| **MCP Gateway** | MCP Protocol | 22 tools served, 5 cognitive skills registered | **INTEGRATED** |

Both on-chain transactions are recorded in [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md). Nothing here is mainnet, and no mainnet funds are claimed.

---

## Run the Autonomous Loop

```bash
# 1. Install dependencies
npm install

# 2. Honest health check (~2s: live chain heads, ports, build state)
npm run doctor

# 3. Start unified daemon stack (Core API :3005, MCP Gateway :3006, Webhook Worker, Keeper)
npm run stack:up

# 4. Run 2 full cycles of the autonomous 3-agent loop
npm run agents:run -- --cycles 2

# 5. Safely terminate background daemons
npm run stack:down
```

`agents:run` starts three distinct agents against the live HTTP API, each holding only the surface its role requires:
- `agent_buyer_live`: reads its mandate, posts the request, opens and funds the agreement.
- `agent_provider_live`: polls its inbox, starts execution, submits the hashed deliverable.
- `agent_evaluator_live`: polls for deliverables, checks acceptance criteria, accepts or rejects.

They are autonomous in the sense that matters: **no step receives the previous step's result.** Each learns what to do by polling its own inbox and signs only its own transitions with real EIP-712 signatures.

---

## Developer Portal & Documentation Manual

- **[16-Page Developer Portal](docs/portal/)** — Complete institutional documentation:
  - [01: What is Mitra? (The Core Thesis & The Custody Trap)](docs/portal/01-what-is-mitra.md)
  - [02: Quickstart: Safe Agent Spend in 5 Minutes (TS & Python)](docs/portal/02-quickstart.md)
  - [03: The Multi-Door Architecture](docs/portal/03-multi-door-architecture.md)
  - [04: Engravings & Mandates: How Principals Bound Authority](docs/portal/04-engravings-and-mandates.md)
  - [05: Confidential Policy Evaluation with Arcium MPC](docs/portal/05-arcium-mpc-confidential-policy.md)
  - [06: The Execution Guard: "ALLOW != DISBURSEMENT"](docs/portal/06-execution-guard-and-allow-invariant.md)
  - [07: Bilateral Agreements & Programmatic DvP Escrow](docs/portal/07-bilateral-agreements-and-escrow.md)
  - [08: Distributed Sagas & Atomic Compensation](docs/portal/08-distributed-sagas-atomic-recovery.md)
  - [09: The Autonomous Keeper Daemon](docs/portal/09-autonomous-keeper-daemon.md)
  - [10: Multilateral Debt Netting: "Clear First. Move Only What Remains"](docs/portal/10-multilateral-debt-netting.md)
  - [11: Epoch Clearing Algorithms & Obligation Reconciliation](docs/portal/11-epoch-clearing-algorithms.md)
  - [12: Solana Substrate: Anchor PDAs, Vaults & Program State](docs/portal/12-solana-substrate.md)
  - [13: Base Substrate: EVM ERC-8183 Escrows](docs/portal/13-base-substrate.md)
  - [14: Tempo Substrate: TIP-20 Streaming Micro-Payments](docs/portal/14-tempo-substrate.md)
  - [15: Model Context Protocol (MCP) Gateway (22 Tools on :3006)](docs/portal/15-mcp-gateway.md)
  - [16: Cognitive Agent Skills & Developer Tooling](docs/portal/16-agent-skills-and-tooling.md)
- **[`/llms.txt`](docs/llms.txt)** — Machine-readable documentation index built natively for LLMs and autonomous agents.
- **[Colosseum Hackathon Submission Dossier](docs/SUBMISSION.md)** — Comprehensive Section 8 rubric mapping with executed evidence.

---

## What We Learned: Boundary Cases & Invariants

Following BUILD_FOUNDRY discipline, defects are recorded rather than papered over:

- **F86 (Reporting After the Fact):** An API response claiming a transaction succeeded is not evidence. Mitra re-reads actual on-chain account balances and store state *after* the operation before reporting success.
- **F79 (Persisted Sagas):** Reconstructing compensation routes in memory after a crash could fabricate refund targets. Mitra writes durable compensation routes to disk before funds move.
- **F100 (Operator-Plane Mandates):** `POST /api/v1/mandates` mints the root of authority. It is narrowed (existence checks, chain approval, first-write-wins) but not yet principal-signed. External agents hold zero mandate-creation verbs over MCP or SDK.
- **F102 (Space Isolation):** `POST /api/v1/spaces` on an existing `spaceId` overwrites budget without ownership checks. The autonomous loop avoids this by strictly owning its own space (`space_live_loop`).
- **F103 (Binary Entrypoint Verification):** The keeper daemon passed typecheck and all 9 unit tests but failed at runtime due to a CJS `await` trap. Running entrypoint binaries (`npm run keeper:once`) is mandatory.

---

## Repository Architecture

```
├── contracts/                   # Solidity smart contracts (ERC-8183 Escrows, MitraClearing)
├── programs/
│   ├── mitra-vault/             # Solana Anchor program (PDA Vaults, Mandates, Escrows)
│   └── arcium-policy-circuit/   # Arcium MPC confidential policy evaluation circuit
├── lib/
│   ├── kernel/                  # Store-free economic kernel & multilateral cycle netting
│   ├── commerce/                # Bilateral agreements, DvP escrows, distributed sagas
│   ├── mcp/                     # 22-tool Model Context Protocol gateway & cognitive prompts
│   └── sdk/                     # Lightweight TypeScript client (@mitra/sdk)
├── skills/                      # 5 cognitive agent playbooks (core, buyer, provider, evaluator, treasury)
├── scripts/
│   ├── doctor.ts                # 2-second honest infrastructure & chain RPC health probe
│   ├── stack.ts                 # Unified background daemon supervisor with PID attribution
│   ├── keeper-daemon.ts         # Autonomous escrow timeout refund sweeper
│   └── run-autonomous-agents.ts # 3-agent continuous loop with real EIP-712 signatures
├── docs/
│   ├── portal/                  # 16-page normative developer documentation manual
│   ├── llms.txt                 # Machine-readable agent index
│   └── SUBMISSION.md            # Colosseum Hackathon Section 8 submission dossier
└── forge/                       # FORGE 1.4 control plane (INVARIANTS, FAILURES, PROOF_LEDGER)
```

---

## License

Released under the [MIT License](LICENSE).