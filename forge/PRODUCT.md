# PRODUCT

> **Mitra is a coordination, netting, clearing, saga, and vault system for agentic commerce.**

Mitra owns the economic lifecycle between agent intent and final settlement.
It is not a marketplace, messaging protocol, wallet, bridge, blockchain, or
payment transport. It coordinates those systems around a common economic state
model that has to persist when the marketplace, protocol, rail, or chain changes.

```text
capital + authority → coordination → commercial execution → obligations
                    → recovery where required → netting → clearing → settlement
```

## The five system functions

| Function | Question it answers |
|---|---|
| **Coordination** | What is happening, between whom, under which agreement? |
| **Vault** | Which capital is available, reserved, escrowed, and actually spendable? |
| **Saga** | What happens when a multi-step economic workflow fails? |
| **Netting** | Which obligations can be reduced before any asset moves? |
| **Clearing** | Which obligations settle, to whom, after challenge? |

## The load-bearing mechanism

**An ALLOW decision is never itself permission to move value.**

An agent does not receive spending access merely because it can request a
payment. The agent produces *proposals*; a mandate defines what it may do; a
policy engine evaluates; a vault enforces the capital constraint; and an
execution guard re-validates the exact instruction before anything moves.

The authorization must be bound to the mandate version, vault, action, asset,
chain, recipient, amount, expiry, nonce, and reservation. Reachability and
authority are different questions, and conflating them is the failure this
product exists to prevent.

## Product thesis

> Agentic commerce needs a system that controls capital, coordinates economic
> actions, carries obligations through failure, nets what can be netted, clears
> what must be settled, and moves only the residual value required.

Payment is the end of a lifecycle, not the lifecycle itself.

## Boundary

```text
Agent / human / organization
        ↓
A2A / MCP / marketplaces / APIs
        ↓
       MITRA
  ┌─────────┼──────────┐
 Vault  Coordination   Saga
  └─────────┼──────────┘
        ↓
   Obligations
        ↓
Netting / Clearing
        ↓
   Settlement
        ↓
Solana / Base / Tempo
```

## Explicit non-goals

Not an LLM, agent framework, payment protocol, bridge, blockchain, generic
wallet, universal identity system, or consumer marketplace. It coordinates those
systems rather than replacing them.

## Current truth

Mitra is `LOCAL_PASS` for the deterministic local kernel. There is **no** live
chain settlement, no production custody, no external integration running, and no
on-chain vault controller. See `forge/PROOF_LEDGER.md` for what is proven and
`docs/EVIDENCE.md` for the level ladder.

The distinction between *mechanically enforced* and *cryptographically enforced*
is tracked explicitly in `forge/INVARIANTS.md` — a local Postgres row lock
enforces capital correctly but is not a custody boundary.

## Source

Derived from `docs/product/MITRA_PRD.md` §1 and §60.5 (canonical economic
model). Where this summary and the PRD differ, the PRD is normative.
