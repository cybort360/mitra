# Mitra 0.1 — Full Product Repository

Mitra is a coordination, vault, saga, netting and clearing system for agentic commerce. This repository implements the complete local product surface and a production-shaped economic kernel while explicitly separating what is locally proven from what still requires live external infrastructure.

## What is included

### Operator console
- Overview
- Runs and Run Detail
- Vaults and Vault Detail
- Agents and Agent Detail
- Policies / mandates / authorization decisions
- Commerce / agreements / deliverables
- Obligations
- Recovery / sagas
- Clearing epochs and residual transfer vectors
- Settlements
- Integrations
- Evidence ledger
- Failure Lab
- Settings / authority-boundary notes
- Command-K search
- Responsive layout

### Canonical domain
Typed objects for Agent, Vault, Mandate, Intent, Reservation, Authorization, Agreement, Deliverable, Obligation, Saga, ClearingEpoch, Settlement, Receipt, Run and RunEvent.

### Local economic kernel
- policy evaluation
- available-capital enforcement
- reservation transition logic
- execution action-digest binding
- vault reconciliation
- deterministic obligation netting
- failure scenarios and reason codes

### API
Local REST-shaped routes under `/api/v1` for health, runs, vaults, obligations, clearing and failure-lab simulations.

### Adapter boundaries
Typed marketplace, payment and settlement interfaces plus local/unconfigured adapters. Real Solana/Base/Tempo/Virtuals/x402/MPP credentials are deliberately not fabricated.

### Tests
Invariant-oriented Vitest coverage for overspend prevention, action tampering, reconciliation and deterministic clearing.

## Evidence statement

This repository is `LOCAL_PASS` for the deterministic local kernel only after tests/build pass. It does not claim live testnet settlement, production custody, audited smart contracts, live marketplace access or decentralized clearing. The UI may contain representative IDs/hashes to demonstrate information architecture; the Evidence page labels those limitations.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Zero-dependency visual preview

If you only want to inspect the current console direction without installing packages:

```bash
cd preview-static
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

## Current stack

- Next.js 16 App Router
- React 19
- TypeScript
- Zod
- Lucide React
- Vitest
- dependency-light CSS design system

## Production implementation path

1. Freeze canonical schemas and state machines.
2. Replace seed store with Postgres + durable event log + object storage.
3. Implement/deploy Solana vault/controller, reservation, escrow, obligation commitment, receipt anchoring and settlement programs.
4. Wire signer abstraction and optional confidential policy evaluation.
5. Integrate one external marketplace deeply plus A2A, MCP and x402/MPP.
6. Integrate TALOS recovery routes.
7. Harden deterministic clearing and challenge flows.
8. Add Base and Tempo adapters against current standards/repositories.
9. Add reconciliation, webhooks, observability, incident controls and migrations.
10. Complete audits and production-readiness gates before handling production funds.

## Important product boundary

Mitra is not an LLM, agent framework, payment protocol, bridge, blockchain, generic wallet, universal identity system or consumer marketplace. It coordinates those systems around durable economic state.
