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

## Storage plan for production

- Relational database: canonical objects, versions, state transitions, indexes, reconciliation state.
- Durable event log: economic timeline and replayable projections.
- Object storage: large artifacts, signed payloads, evidence and external documents.
- Onchain: critical commitments, escrow, settlement, revocation and receipt anchors.
- Cache: marketplace discovery, external metadata and capability lookups with explicit freshness semantics.

The repository currently uses an in-repo deterministic seed store so the complete product surface can be exercised without pretending a database or chain deployment exists.
