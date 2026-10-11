# What is Mitra? The Clearinghouse for Agentic Commerce

**Mitra** is the financial coordination layer and institutional clearinghouse for autonomous AI agents.

In traditional finance, trade execution, risk clearance, and asset settlement are strictly segregated across specialized institutions (brokerages, clearinghouses like DTCC/LCH, and central securities depositories like Euroclear). In the emerging agentic economy, developers routinely give autonomous LLM agents naked private keys and raw wallet access—collapsing custody, policy, execution, and settlement into a single failure domain.

Mitra restores institutional market architecture to agent commerce: **agents coordinate trade intents, while on-chain vaults and an independent execution guard enforce mathematical spending boundaries.**

---

## 1. The Core Problem: The Custody Trap

Autonomous economic agents represent a structural paradigm shift in capital movement. Unlike human users who review signature prompts, autonomous agents interact with programmatic APIs, generate runtime prompts, and negotiate deliverables at machine speed.

Today, developers face an unacceptable binary choice:

1. **The Custodial Trap (Unbounded Freedom):** Hand the agent a private key with pre-funded capital. If the model hallucinates, suffers a prompt injection attack, or hits an unhandled infinite loop, the entire treasury is drained in milliseconds.
2. **The Paralysis Trap (Zero Agency):** Require human approval for every single micro-transaction. The agent loses autonomy, high-frequency coordination becomes impossible, and agentic workflows grind to a halt.

Current payment protocols (such as raw ERC-20 transfers, Stripe tokens, or HTTP 402 paywalls) only address the mechanics of transferring value from Point A to Point B. They answer *how* to move tokens, not *whether this exact instruction is permitted to move capital*.

---

## 2. The Solution: Institutional Architecture for Agents

Mitra solves the custody trap by separating **Intent** from **Disbursement**, and **Policy Evaluation** from **Capital Settlement**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 THE THREE CHECKS                                       │
│                                                                                        │
│  [CHECK 1: MANDATE]             [CHECK 2: POLICY ENGINE]     [CHECK 3: EXECUTION GUARD]│
│  How much may I spend?          Who authorized it?           May this instruction pay? │
│  (Persistent Engraving)         (Arcium MPC Confidential)    (Independent Re-derivation│
│         │                               │                               │              │
│         ▼                               ▼                               ▼              │
│   Vault Headroom                  `ALLOW` Decision               Net Settlement        │
│   Bounded Ceiling                Evaluates Intent               Moves Capital          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### The Three Independent Checks:

1. **Check 1: The Mandate (The Engraving):** A persistent, principal-signed ceiling defining maximum budget, allowed counterparty capabilities, approved chain substrates, and expiration. Headroom decreases monotonically as obligations clear.
2. **Check 2: The Policy Engine:** Evaluates runtime intents against operational rules and confidential thresholds (using Arcium MPC). It emits an `ALLOW`, `DENY`, or `REVIEW` decision.
3. **Check 3: The Execution Guard:** **An `ALLOW` decision is never permission to move value.** When capital is due to disburse, the execution guard independently re-derives whether the exact instruction satisfies the on-chain vault invariant. A caller or agent can never supply its own spend decision.

---

## 3. Boundary Vocabulary

To maintain strict architectural guarantees, Mitra enforces a precise boundary vocabulary across all documentation, APIs, and client SDKs:

| Term A | $\neq$ | Term B | Architectural Reality |
|---|---|---|---|
| **`MANDATE`** | $\neq$ | **`RUNTIME FREEDOM`** | A mandate is an immovable ceiling set by human principals. Agents cannot modify their own limits. |
| **`ALLOW`** | $\neq$ | **`DISBURSEMENT`** | An `ALLOW` verdict confirms policy adherence. It moves zero capital and reserves zero tokens. |
| **`INTENT`** | $\neq$ | **`CAPITAL`** | Agents negotiate commercial intents and bilateral agreements. Capital remains locked in programmatic escrows. |
| **`NETTING`** | $\neq$ | **`SETTLEMENT`** | Netting mathematically cancels offsetting obligations across cycles. Settlement is the physical transfer of the remaining balance. |
| **`ENGRAVING`** | $\neq$ | **`AUTHORIZATION`** | An engraving is a persistent budget ceiling. An authorization is a single-use token consumed atomically upon execution. |

---

## 4. Architectural Comparison

| Dimension | Autonomous Agent Wallets | Raw Payment Rails (x402 / ERC-20) | Mitra Clearinghouse |
|---|---|---|---|
| **Key Custody** | Agent holds naked private keys | Relies on external wallet signatures | Vault-isolated; agent holds zero capital keys |
| **Spending Limits** | All-or-nothing balance exposure | Static per-call price tags | Dynamic headroom, velocity caps, capability scopes |
| **Policy Enforcement** | Client-side prompts (bypassable) | None (transfers unconditionally) | Arcium MPC confidential policy evaluation |
| **Settlement Mode** | Gross, instant, non-reversible | Gross settlement per HTTP request | Multilateral cycle netting + DvP escrow |
| **Dispute & Failure** | Funds lost permanently | Manual chargebacks or merchant support | Distributed Sagas with autonomous keeper refunds |
| **Multi-Chain Scope** | Fragmented single-chain wallets | Chain-specific connectors | Tri-chain peer parity (Solana, Base, Tempo) |

---

## 5. Tri-Chain Peer Parity

Mitra treats **Solana, Base, and Tempo** as strictly equal, first-class peers:

- **Solana Devnet / Mainnet:** Native high-throughput settlement using Anchor Program-Derived Addresses (PDAs) and confidential policy circuits (`programs/mitra-vault`).
- **Base Sepolia / Mainnet:** EVM compatibility adhering to **ERC-8183 (Agentic Commerce Escrows)** and standard EIP-712 typed-data authorization (`contracts/MitraVault.sol`).
- **Tempo Moderato / Mainnet:** Sub-cent streaming and micro-transaction clearing powered by **TIP-20** token rails.

Neither chain is an adapter or a secondary wrapper. Every core invariant executes natively on all three substrates.

---

## Next Steps

- Proceed to [Quickstart: Safe Agent Spend in 5 Minutes](./02-quickstart.md) to initialize your first bounded agent.
- Explore the [Multi-Door Architecture](./03-multi-door-architecture.md) tailored to your operational role.
