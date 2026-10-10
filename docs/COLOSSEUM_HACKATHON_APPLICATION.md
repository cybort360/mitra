# Colosseum Hackathon Application: Mitra (The Clearinghouse for Agents)

**Project:** Mitra  
**Category:** AI Platforms / Agents  
**Target Deadline:** October 12 at 11:59 PM PDT  

---

## 1. Project Details

### Project Name *(Public)*
`Mitra`

---

### Brief Description *(Public, Max 500 characters)*
> **Character count:** 449 / 500

Mitra is the financial clearinghouse and coordination operating system for autonomous AI agents. We solve the Hot-Key Trap by separating the cognitive authority to reason about spending from the cryptographic authority to move capital. Powered by programmable Solana PDA vaults, ERC-8183 escrows, Model Context Protocol (MCP) tooling, distributed failure recovery sagas, and multi-party cycle netting, Mitra enables agents to safely hire and settle.

---

### Project Website *(Public)*
`https://mitra.exchange` *(or your repository / live demo: `https://github.com/cybort360/mitra`)*

---

### What are you building, and who is it for? *(Max 1,000 characters)*
> **Character count:** 975 / 1,000

Mitra is the financial clearinghouse for agentic commerce, bridging the gap between agent intent and final value movement. Instead of handing LLMs hot keys with direct wallet custody, Mitra enforces a load-bearing invariant: "An ALLOW decision is never permission to move value."

Mitra operates a three-layer capital pipeline:
1. Mandates: Principals define deterministic spending limits (ceilings, token scopes, velocity limits).
2. Policy Engine: Verifies compliance over agent proposals.
3. Execution Guard: On-chain vault logic re-derives cryptographic bindings (recipient, nonce, hash, deadline) before any asset moves.

Mitra provides programmable non-custodial vaults, decoupled 3-party escrows (Client, Provider, Evaluator), TALOS distributed recovery sagas for workflow failure recovery, and multi-party cycle netting to eliminate redundant transactions.

Built for AI agent developers, autonomous agent swarms (Virtuals, Eliza, x402), and treasuries hiring agents.

---

### Why did you decide to build this, and why build it now? *(Max 1,000 characters)*
> **Character count:** 941 / 1,000

AI agents are shifting from chat interfaces to autonomous economic actors that negotiate, hire sub-agents, and purchase APIs. Yet the financial rails underpinning them are fundamentally broken:

1. The Hot-Key Trap: Giving an LLM direct wallet custody is fatal—prompt injections, jailbreaks, or hallucinations drain treasuries instantly.
2. The Walled-Garden Dilemma: Custodial agent platforms lock capital in fragmented, non-interoperable silos.
3. The Payment Fallacy: Crypto rails treat commerce as isolated `transfer()` calls. Real commerce requires agreed deliverables, held escrows, proof of delivery, and failure recovery. When a multi-step agent pipeline fails halfway today, capital is permanently stranded.

Why now: With the explosion of MCP, autonomous swarms, and decentralized agent marketplaces, the missing layer is not another LLM or payment rail—it is the economic clearinghouse that makes autonomous machine commerce safe.

---

### What technologies are you using or integrating with to build your product?
*Please include notable developer tools and AI tools as well.*

* **Solana & Anchor:** Solana Program Derived Address (PDA) non-custodial vaults (`programs/mitra-vault`), Anchor framework, Rust, Ed25519 instruction verification, Solana Devnet deployment.
* **EVM & Smart Contracts:** Solidity, Foundry, ERC-8183 decoupled escrow contracts (`MitraJobEscrow`, `MitraVaultV2`), Base Sepolia, Tempo Moderato, Anvil.
* **Agent Standards & AI Protocols:** Model Context Protocol (MCP) server daemon (21 native tools over Streamable HTTP and SSE), Anthropic Claude, OpenAI, Google Gemini tool use, ElizaOS integration.
* **Agent Marketplaces & Identity:** ERC-8004 Agent Identity Registry, Virtuals Protocol ACP agent discovery (`acpx.virtuals.gg`), x402 payment facilitator integration.
* **Backend, Storage & Tooling:** TypeScript, Node.js, Next.js 14, PostgreSQL 16 (strict relational constraints, row-level locks for concurrent headroom reservation), Viem, Wagmi, Arcium MPC for confidential policy execution.

---

### Which chains does your product use? *(Required)*
Select the following checkboxes:
* [x] **Solana**
* [x] **Base**
* [x] **Tempo**
* [x] **Ethereum L1**
* [x] **Arbitrum**

---

### How does your product use these chains? *(Max 500 characters)*
> **Character count:** 492 / 500

Solana serves as our primary high-performance custody and settlement layer. Our Anchor program (programs/mitra-vault) uses Program Derived Addresses (PDAs) to enforce non-custodial capital boundaries, velocity limits, and cryptographic execution guards with sub-second finality.

Base, Tempo, and EVM chains run our ERC-8183 decoupled escrow contracts (MitraJobEscrow) and cross-chain settlement rails, connecting external agent marketplaces (Virtuals ACP, x402) into a unified clearinghouse.

---

### What category best describes your product? *(Public)*
* Select: **AI Platforms / Agents**

---

### Is your project a mobile-focused dApp?
* Select: **No**

---

## 2. Location and Contact

### Where is your team primarily based? *(Public)*
* Select your country from the dropdown.

### Please share a team Telegram contact *(Required)*
* Enter your handle (e.g. `@your_telegram_username`).

---

## 3. Notes for Judges

### Did anyone not listed on the team here do meaningful work on this project? If so, please explain. *(Max 600 characters)*
> **Character count:** 248 / 600

All architecture, smart contracts (Solana Anchor and EVM), SDK, MCP server daemons, and testing infrastructure were designed and developed directly by the submitting core team. No external contractors or unlisted contributors participated.

---

### Is there anything else judges should know about your project that isn't captured above? *(Max 500 characters)*
> **Character count:** 479 / 500

Mitra is built under strict BUILD_FOUNDRY engineering discipline with zero mock success paths:
- 147 Rust Anchor unit & integration tests passing on Solana
- 63 Foundry Solidity tests passing
- 1,398 TypeScript unit and integration tests passing on PostgreSQL 16
- Live deployments on Solana Devnet & Base Sepolia
- Complete standing daemon architecture: continuous escrow sweep keeper, streaming HTTP/SSE MCP gateway, and autonomous agent runners (Buyer ⇄ Provider ⇄ Evaluator).
