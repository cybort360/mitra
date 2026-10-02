# 0009. Mandate semantics reuse Engraving's model and refuse its implementation

**Status:** Accepted
**Related:** F23, PRD §50, ADR-0002

## Context

PRD §50 directs Mitra to reuse semantics from an inherited project:

> **Engraving — Reuse:** versioned mandate semantics · proposal → authorization
> evaluation · ALLOW/DENY boundary · authority receipts · confidential policy
> concept · proposal-to-policy decision separation
>
> Do not blindly copy chain-specific COTI infrastructure into Solana.

The repository exists at `/home/ubuntu/engravings` — 4,041 lines of product
documentation plus `contracts/`, `packages/`, and `tests/`. It was not read during
the first ten days of this work (F23). Having now read
`docs/canonical/PROTOCOL_SPEC.md` and `GROUND_TRUTH.md`, this record states what
is taken and refused, so the decision is a checked artifact rather than a claim
about intent.

Engraving's canonical definition:

> **An Engraving is a persistent, versioned mandate attached to an autonomous
> principal that constrains how compatible runtimes may act.**
>
> **Steering changes intent. Engravings bound authority.**

Its core invariant:

> **Every consequential action must be attributable to a specific proposal
> evaluated against a specific Engraving version.**

## What Mitra already has

Verified against `lib/domain/types.ts` and `lib/kernel/authorization.ts` before
deciding anything. Four of Engraving's five entities already exist:

| Engraving | Mitra | Status |
|---|---|---|
| Engraving | `Mandate` — `version`, `expiresAt`, `status`, `principal`, `agentId` | present |
| EngravingVersion | `Mandate.version` + `policyVersion` | present |
| Proposal | `Intent` (goal) + `Reservation` (concrete action), split differently | shape gap |
| Authorization | `Authorization` — `mandateVersion`, `decision` | present, **not consumable** |
| Consequence | `Receipt` — hash-chained, carries `chainEvidence` | present, richer |
| Evidence | `Receipt` + `previousReceiptHash` | present |

## The one real gap

Mitra's authorization is **computed and discarded** — a return value, with the
record written afterwards as a `Receipt`. Replay defence today is:

```ts
export interface ExecutionContext {
  /** Reservation nonces already consumed on this vault/mandate. */
  consumedNonces?: number[];   // optional, caller-supplied
}
```

Two consequences, both verified in the source:

1. The field is **optional**. A caller that omits it gets no replay refusal —
   `NONCE_ALREADY_CONSUMED` never fires.
2. The namespace is **per `vaultId`**, not per mandate + runtime. One runtime
   holding two mandates shares a nonce space, which is not Engraving's
   granularity.

Engraving instead makes the authorization an object with `consumed: boolean`,
spent atomically with the consequence:

> An ALLOW result is single-use. … Consumption and execution should be atomic
> where practical.

Under that model replay is not *checked*; it is *impossible*, because the
authorization no longer exists to be presented.

## Decision

1. **Authorization becomes a program-owned, consumable on-chain object** carrying
   `actionHash`, `nonce`, `deadline` and `consumed`. This is the one Phase 3
   change that is not cosmetic.
2. **Only the program may author an Authorization.** The kernel may *propose*; an
   `ALLOW` originating off-chain is a hint, not a fact. This is spec §4.3 made
   literal — *"the agent may decide what it wants to propose. It does not become
   the sole authority over whether the action is permitted."*
3. **Nonce namespace becomes `mandateId + agentId`**, matching Engraving's
   `per engraving + runtime`, so revoking one mandate does not consume another
   runtime's nonce space.
4. **Evaluation binds to the version read on chain**, not to a `mandateVersion`
   the caller supplies — otherwise a runtime proposes against a stale but
   favourable version. (`AGENTS.md`: "no caller can supply their own spend
   decision.")

### Refused, with reasons

| Engraving has | Refused because |
|---|---|
| `EngravingStatus` ∈ {ACTIVE, PAUSED, REVOKED, EXPIRED} | `Mandate` already has `status`, and ADR-0002 argues against status-driven state. A second state machine duplicates and conflicts. |
| COTI contracts, `packages/coti/` adapters | COTI was never a Mitra target (project ruling); §50 forbids copying chain-specific COTI infrastructure into Solana. |
| `(0x${string}, bigint)` type shapes | Would break canonical serialization and the digests pinned in F11. |
| `PrivateMessage` entity | Mitra has no messaging surface. The security *property* is preserved by rule 2 — authority is derived by evaluation, never transmitted — which is the anti-social-engineering claim, and needs no message type. |
| Pause/revoke invalidation semantics | `GROUND_TRUTH.md` §19 lists this as an **open unknown** the authors have not settled. Reusing it would import an unresolved question as if decided. |
| Single-party shape (`operator → one runtime`) | Mitra's lifecycle is multi-party. A correctly ported Engraving would give Mitra a governed wallet — satisfying Phase 3's exit condition while violating §1.1. |

### The test that distinguishes reuse from porting

After Phase 3: **an agent holding two counterparty mandates must be able to
reserve against one while the other's budget is exhausted.** If Engraving-derived
structure prevents that, the structure was ported rather than reused.

## Consequences

- Phase 3 is four increments: (a) versioned mandate on chain, (b) proposal
  evaluation emitting a consumable Authorization, (c) consume-on-spend, (d) nonce
  namespace change.
- `Mandate.status` must not acquire Engraving's state machine — asserted by a test,
  so the refusal is machine-checkable rather than promised.
- Confidentiality stays **deferred** behind a single evaluation interface, so an
  Arcium implementation replaces the evaluator rather than the protocol.
  Engraving's confidential-mandate concept informs the interface shape; its COTI
  implementation is not used.

## Alternatives considered

- **Port Engraving wholesale into Solana.** Rejected: multi-party gap, and §50
  forbids it.
- **Reuse nothing; design from the PRD.** Rejected: §50 explicitly names Engraving
  as a source, and four of its five entities are already correctly present in
  Mitra — evidence the model fits.
- **Defer Phase 3 until Arcium is available.** Rejected: the exit condition is
  reachable with the policy in the clear, and §43 requires that *"privacy must not
  destroy auditability"* — so the plain path must work first.

