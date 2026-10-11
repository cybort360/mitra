# Mitra

**Mitra lets a business give an AI agent a budget without giving it the keys.**

Mitra is a coordination, vault, saga, netting and clearing system for agentic commerce. This
repository contains the local product surface, the economic kernel, contracts for two chains,
and a standing loop of autonomous agents that settles real engagements against them.

Tracks: `Solana · $100k` · `Tempo Moderato · $100k` · `Base · $25k`

---

## The one mechanism

**An `ALLOW` decision is never itself permission to move value.**

```
HOW MUCH MAY I SPEND  →  WHO AUTHORIZED IT  →  MAY THIS EXACT INSTRUCTION MOVE CAPITAL
     mandate               policy engine             execution guard
```

The policy engine decides whether an action is *permitted*. The execution guard independently
re-derives whether *this exact instruction* may move capital. Neither a human nor an agent can
supply their own spend decision, and a path that reaches the chain without passing the guard is
not a weaker guarantee — it is no guarantee.

Everything else here is a consequence of protecting that line.

### Boundary vocabulary

These four terms are used precisely throughout the codebase and the API. Conflating them is the
most common way a system like this fails.

| Term | Means | Does **not** mean |
|---|---|---|
| **Mandate** | The ceiling the owner set. The root of the authority chain. | Money the agent may move at will |
| **Authorization** | Policy's answer about a *proposed* action | Permission to disburse |
| **`ALLOW`** | The policy engine's decision that an action is permitted | Capital movement — see above |
| **Execution guard** | The independent check of *this instruction* against the mandate | A second policy engine |

Authority flows one way: `Mandate → Authorization → Intent → Agreement`. Each link is strictly
narrower than the one before it.

---

## Fewer payments move

Multilateral netting: where parties owe each other in a cycle, only the net remainder settles.

Illustrative three-party cycle — the mechanism is in `lib/kernel/clearing.ts`:

| Party | Pays | Receives | Net position |
|---|---|---|---|
| A | B $100 | C $40 | **pays $60** |
| B | C $70 | A $100 | receives $30 |
| C | A $40 | B $70 | receives $30 |
| | **$210 gross** | | **$60 net** |

Two hundred and ten dollars of obligation, sixty dollars of movement. The saving grows with the
size of the cycle, which is what makes it a network effect rather than a fee.

---

## Run the loop

```bash
npm install
npm run doctor          # ~2s: live chain heads, ports, build state
npm run stack:up        # Core API :3005 · MCP gateway :3006 · webhook worker · keeper daemon
npm run agents:run -- --cycles 2
npm run stack:down
```

`agents:run` starts three agents against the live HTTP API, each holding only the surface its
role needs:

| Agent | Does |
|---|---|
| `agent_buyer_live` | reads its mandate, posts the request, opens and funds the agreement |
| `agent_provider_live` | polls its inbox, starts execution, submits the deliverable |
| `agent_evaluator_live` | polls for deliverables, checks the acceptance criteria, accepts or rejects |

They are autonomous in the sense that matters: no step receives the previous step's result. Each
learns what to do by polling its own inbox and signs only its own transitions, so the buyer
cannot accept its own deliverable. Agents cannot grant themselves authority — `MitraClient` has
no capital-issuing verb, and the MCP tool list contains no mandate write.

---

## Verify

```bash
npm run typecheck                              # 0 errors
forge test                                     # 63/63
cargo test --manifest-path programs/mitra-vault/Cargo.toml   # 147/147
npx vitest run                                 # 1,385 passed, 83 skipped
npm run test:postgres                          # with DATABASE_URL set
npm run showcase:full                          # four acts on anvil
npm run doctor                                 # live chain heads, ~2s
```

Every figure any of these print is read back from the chain or the store *after* the operation.
A confirmed transaction is not the same claim as "the money is back" — that distinction is F86 in
`forge/FAILURES.md`, and it is the rule the whole reporting discipline comes from.

---

## Live settlements

| Rail | Network | Evidence |
|---|---|---|
| ERC-8183 escrow | Base Sepolia | `0x75dbc742…fb928` |
| Solana program | Devnet | `jW14aBAb…HWZ` |

Both are recorded in `forge/PROOF_LEDGER.md` with the command that produced them. Nothing here is
mainnet, and no mainnet funds are claimed.

---

## What this repository is

- **Operator console** — Next.js App Router over the domain: runs, vaults, agents, policies,
  agreements, obligations, recovery sagas, clearing epochs, settlements, evidence ledger.
- **Economic kernel** — store-free and synchronous, so it is testable without a database:
  policy evaluation, capital enforcement, reservation transitions, action-digest binding,
  deterministic netting.
- **Contracts** — `MitraJobEscrow` (Foundry, Base) and the Solana vault program (Anchor).
- **Surfaces** — REST under `/api/v1`, an SDK (`lib/sdk`), and a 22-tool MCP gateway.
- **Failure discipline** — `forge/FAILURES.md` holds 103 numbered entries, each with a cause
  and a fix or an explicit open status. `forge/PROOF_LEDGER.md` records what is proven versus
  what is not.

### Not this

Mitra is not an LLM, agent framework, payment protocol, bridge, blockchain, generic wallet,
identity system or consumer marketplace. It coordinates those systems around durable economic
state.

---

## Boundaries

Port 3000 is reserved on the development machine; the Core API runs on `3005` and the MCP gateway
on `3006`.

Nothing here has been through a security audit. Adapter credentials for production rails are
deliberately absent rather than fabricated — a rail that cannot be reached returns `null` and is
treated as a refusal, never as a silent success.

## Boundary cases worth reading

Three open limitations, stated here rather than buried:

- **F100** — `POST /api/v1/mandates` is unauthenticated and mints the root of the authority
  chain. Narrowed (existence checks, chain approval, first-write-wins, a pause scope) but not
  yet principal-signed.
- **F102** — `POST /api/v1/spaces` on an existing `spaceId` overwrites that Space's budget
  without an ownership check. Open.
- **F103** — the keeper daemon passed typecheck and all nine of its unit tests and could not be
  executed at all, because its tests imported pure functions and never ran the entrypoint.
  Fixed; recorded because a green suite only proves the paths it touches.