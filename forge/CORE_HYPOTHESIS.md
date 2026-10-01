# CORE HYPOTHESIS

The single claim this product rests on. If it is false, most of the engineering
is wasted; if it is true, the rest follows.

---

## The hypothesis

> **Autonomous agents can participate in real commerce safely if, and only if,
> the authority to move value is separated from the ability to reason about
> spending — and if that separation is enforced cryptographically rather than
> asserted by the parties involved.**

## Why it is a hypothesis and not a principle

It is falsifiable. Three observable predictions follow, and all three are
currently **unproven**:

1. **Coordination collapses without it.** Agent commerce today reduces to
   isolated payments because there is no object that holds obligations across
   failure. If a coordination layer adds no value once obligations are netted
   and cleared, the product is unnecessary.
2. **A local enforcement boundary is insufficient.** Our kernel enforces
   capital correctly in Postgres. If that is *good enough* — if operators never
   circumvent it and no attacker targets it — then the on-chain vault controller
   in PRD Phase 2 is over-engineering.
3. **Confidential policy evaluation is optional, not load-bearing.** If agents
   can be trusted with policy reasoning, Arcium (PRD Phase 3) is a luxury.

**Prediction 2 is the one to watch**, because it is the largest piece of
unspent work and the easiest to talk yourself out of. The honest position today
is that we do not know.

## What is already demonstrated

Not the full hypothesis, but its mechanical core:

- An `ALLOW` decision is **not** sufficient to move value; a separate execution
  guard re-derives the binding. `VERIFIED`
- Concurrent intents cannot consume the same capital. `VERIFIED`
- Replay of a consumed instruction is refused, and survives a restart.
  `VERIFIED`
- Netting reduces reciprocal obligations deterministically. `VERIFIED`

## What is not demonstrated

- That any of this survives a real counterparty who does not want it to.
- That an on-chain boundary adds enforcement a database cannot.
- That an agent economy will route economic state through a coordination layer
  at all.

## How this gets resolved

Not by argument. PRD Phase 2 — a real testnet vault with guarded spend, release,
and anchored receipts — is the first evidence that would move prediction 2 from
speculation to measurement. Until then, this file is a belief with a price tag
attached, and the price is Phase 2.

---

## Adjacent claim worth naming

The PRD's §60 "One Product Test" and §61 "One Demo Test" are the intended
resolution mechanism. They are not restated here because they are the PRD's
formulation, and this repository does not improve on them by paraphrasing.
