# Mitra 0.1 Architecture

Mitra is a financial coordination control plane for agentic commerce. It owns the durable economic state between intent and settlement while integrating external identity, marketplace, communication, payment and chain systems through adapters.

## Canonical lifecycle

Principal → Vault → Mandate → Agent → Intent → Discovery → Commercial Agreement → Authority Check → Spend Reservation → Escrow / Payment Session / Capital Commitment → Execution → Deliverables → Verification / Acceptance → Obligations → Recovery if required → Netting → Clearing → Settlement → Receipt / Accounting / History.

## Capital control path

Vault → Mandate → Policy Evaluation → Authorization → Reservation → Execution Guard → Capital Movement.

The core safety rule is that an ALLOW decision is not itself permission to move arbitrary value. The exact execution instruction must remain bound to the evaluated action digest, mandate version, vault, amount, asset, chain, recipient constraints, expiry, nonce and reservation.

## Runtime layers

1. Console: human operations and proof surface.
2. API: structured resources and mutations.
3. Core domain: canonical objects and state semantics.
4. Kernel: authorization, reservations, reconciliation, sagas, obligations, deterministic netting and settlement binding.
5. Adapters: A2A, MCP, marketplaces, x402, MPP, identity standards, Solana/Base/Tempo.
6. Evidence: receipts, hashes, adapter versions, test commands and chain evidence where actually available.

## Target networks

The PRD (§34) names three chains but specifies no endpoints, so these were
established by probing vendor documentation and then the nodes themselves.
Confirmed live 2026-01-10.

| Chain | Network | Chain ID | RPC |
|---|---|---|---|
| Solana | devnet | — | `https://api.devnet.solana.com` |
| Base | Sepolia | 84532 | `https://sepolia.base.org` |
| Tempo | **Moderato** (testnet) | `42431` | `https://rpc.moderato.tempo.xyz` |

Tempo mainnet is chain ID `4217` at `https://rpc.tempo.xyz`. It is **not** a
test target; `scripts/phase2-readiness.mjs` hard-fails if `TEMPO_RPC_URL` points
there, so a misconfigured endpoint cannot be mistaken for a testnet.

Tempo is EVM-compatible (Osaka) with **no native gas token** — fees are paid in
TIP-20 stablecoins. A consequence for adapters: `eth_getBalance` returns a
large constant identical for every address, not a balance, so it must never gate
a funding decision. See [ADR-0006](../docs/adr/0006-tempo-balances-require-tip20.md)
and `forge/FAILURES.md` F12.

## Storage plan for production

- Relational database: canonical objects, versions, state transitions, indexes, reconciliation state.
- Durable event log: economic timeline and replayable projections.
- Object storage: large artifacts, signed payloads, evidence and external documents.
- Onchain: critical commitments, escrow, settlement, revocation and receipt anchors.
- Cache: marketplace discovery, external metadata and capability lookups with explicit freshness semantics.

The repository currently uses an in-repo deterministic seed store so the complete product surface can be exercised without pretending a database or chain deployment exists.
