# Mitra

<p align="center">
  <strong>The Financial Coordination Layer and Clearinghouse for Agentic Commerce</strong>
</p>

<p align="center">
  <a href="programs/mitra-vault"><img src="https://img.shields.io/badge/Track-Solana%20($100k)-14F195?style=flat&logo=solana&logoColor=white" alt="Solana Track"></a>
  <a href="docs/portal/14-tempo-substrate.md"><img src="https://img.shields.io/badge/Track-Tempo%20Moderato%20($100k)-blue?style=flat" alt="Tempo Track"></a>
  <a href="contracts/MitraVault.sol"><img src="https://img.shields.io/badge/Track-Base%20Sepolia%20($25k)-0052FF?style=flat&logo=coinbase&logoColor=white" alt="Base Track"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Tests-1%2C600%20Passing-success" alt="Tests: 1,600 Passing">
  <a href="docs/llms.txt"><img src="https://img.shields.io/badge/Native-llms.txt-purple" alt="llms.txt Native"></a>
</p>

---

**Mitra lets a business give an AI agent a budget without giving it the keys.**

Mitra is a coordination, vault, saga, netting and clearing system for agentic commerce. This repository contains the local product surface, the economic kernel, contracts for two chains, and a standing loop of autonomous agents that settles real engagements against them.

Tracks: `Solana · $100k` · `Tempo Moderato · $100k` · `Base · $25k`

---

## Documentation & Developer Portal

- **[16-Page Developer Portal](docs/portal/)** — Full institutional manual for agent developers, treasury risk operators, and protocol integrators:
  - [01: What is Mitra? (The Core Thesis & The Custody Trap)](docs/portal/01-what-is-mitra.md)
  - [02: Quickstart: Safe Agent Spend in 5 Minutes](docs/portal/02-quickstart.md)
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

## The One Mechanism

**An `ALLOW` decision is never itself permission to move value.**

```
HOW MUCH MAY I SPEND  →  WHO AUTHORIZED IT  →  MAY THIS EXACT INSTRUCTION MOVE CAPITAL
     mandate               policy engine             execution guard
```

The policy engine decides whether an action is *permitted*. The execution guard independently re-derives whether *this exact instruction* may move capital. Neither a human nor an agent can supply their own spend decision, and a path that reaches the chain without passing the guard is not a weaker guarantee — it is no guarantee.

Everything else here is a consequence of protecting that line.

### Boundary Vocabulary

These four terms are used precisely throughout the codebase and the API. Conflating them is the most common way a system like this fails.

| Term | Means | Does **not** mean |
|---|---|---|
| **Mandate** | The ceiling the owner set. The root of the authority chain. | Money the agent may move at will |
| **Authorization** | Policy's answer about a *proposed* action | Permission to disburse |
| **`ALLOW`** | The policy engine's decision that an action is permitted | Capital movement — see above |
| **Execution guard** | The independent check of *this instruction* against the mandate | A second policy engine |

Authority flows one way: `Mandate → Authorization → Intent → Agreement`. Each link is strictly narrower than the one before it.

---

## Fewer Payments Move

Multilateral netting: where parties owe each other in a cycle, only the net remainder settles.

Illustrative three-party cycle — the mechanism is in [`lib/kernel/clearing.ts`](lib/kernel/clearing.ts):

| Party | Pays | Receives | Net position |
|---|---|---|---|
| A | B $100 | C $40 | **pays $60** |
| B | C $70 | A $100 | receives $30 |
| C | A $40 | B $70 | receives $30 |
| | **$210 gross** | | **$60 net** |

Two hundred and ten dollars of obligation, sixty dollars of movement (71.4% liquidity compression). The saving grows with the size of the cycle, which is what makes it a network effect rather than a fee.

---

## Run the Loop

```bash
npm install
npm run doctor          # ~2s: live chain heads, ports, build state
npm run stack:up        # Core API :3005 · MCP gateway :3006 · webhook worker · keeper daemon
npm run agents:run -- --cycles 2
npm run stack:down
```

`agents:run` starts three agents against the live HTTP API, each holding only the surface its role needs:

| Agent | Does |
|---|---|
| `agent_buyer_live` | reads its mandate, posts the request, opens and funds the agreement |
| `agent_provider_live` | polls its inbox, starts execution, submits the deliverable |
| `agent_evaluator_live` | polls for deliverables, checks the acceptance criteria, accepts or rejects |

They are autonomous in the sense that matters: no step receives the previous step's result. Each learns what to do by polling its own inbox and signs only its own transitions, so the buyer cannot accept its own deliverable. Agents cannot grant themselves authority — `MitraClient` has no capital-issuing verb, and the MCP tool list contains no mandate write.

---

## Verify

```bash
npm run typecheck                              # 0 errors
forge test                                     # 63/63 passed
cargo test --manifest-path programs/mitra-vault/Cargo.toml   # 147/147 passed
npx vitest run                                 # 1,390 passed, 83 skipped
npm run test:postgres                          # with DATABASE_URL set
npm run showcase:full                          # four acts on anvil
npm run doctor                                 # live chain heads, ~2s
```

Every figure any of these print is read back from the chain or the store *after* the operation. A confirmed transaction is not the same claim as "the money is back" — that distinction is F86 in [`forge/FAILURES.md`](forge/FAILURES.md), and it is the rule the whole reporting discipline comes from.

---

## Live Settlements

| Rail | Network | Evidence |
|---|---|---|
| ERC-8183 escrow | Base Sepolia | `0x75dbc742…fb928` |
| Solana program | Devnet | `jW14aBAb…HWZ` |

Both are recorded in [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md) with the command that produced them. Nothing here is mainnet, and no mainnet funds are claimed.

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

## Boundaries

Port 3000 is reserved on the development machine; the Core API runs on `3005` and the MCP gateway on `3006`.

Nothing here has been through a security audit. Adapter credentials for production rails are deliberately absent rather than fabricated — a rail that cannot be reached returns `null` and is treated as a refusal, never as a silent success.

### Boundary Cases Worth Reading

Three open limitations, stated here rather than buried:

- **F100** — `POST /api/v1/mandates` is unauthenticated and mints the root of the authority chain. Narrowed (existence checks, chain approval, first-write-wins, a pause scope) but not yet principal-signed.
- **F102** — `POST /api/v1/spaces` on an existing `spaceId` overwrites that Space's budget without an ownership check. Open.
- **F103** — the keeper daemon passed typecheck and all nine of its unit tests and could not be executed at all, because its tests imported pure functions and never ran the entrypoint. Fixed; recorded because a green suite only proves the paths it touches.

---

## License

Released under the [MIT License](LICENSE).