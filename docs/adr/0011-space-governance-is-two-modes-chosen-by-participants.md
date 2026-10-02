# 0011. Space governance is two modes, chosen by the participants, and this decision is LOCKED

**Status:** Accepted — **LOCKED**. Supersedes the `owner`-based Space in ADR-0010.
**Related:** F33, F37, ADR-0010, PRD §3.2, §13.1, §541 (custody mode)

> **This record is a lock, not a discussion.** The decision below was reached
> deliberately after the reasoning was wrong once. Re-opening it requires evidence
> that the recorded constraints no longer hold — not a new preference.

## Context

ADR-0010 implemented `Space` as a *scope* rather than a container and recorded the
divergence from PRD §13.1. It was correct about denormalisation and wrong about
authority.

The `Space` type carried:

```ts
owner: string;          // one principal
status: "ACTIVE" | "SUSPENDED" | "CLOSED";
```

and the schema made it structural:

```sql
space_id TEXT NOT NULL REFERENCES mitra.spaces(space_id) ON DELETE RESTRICT
```

So **one signature could `SUSPENDED` a commercial context that other agents were
party to**, and every agreement had to exist inside exactly one such tenancy.

PRD §3.2 excludes by name:

> *not* … a custodial wallet provider

and the "not ambition" list names the failure precisely:

> *an opaque custodial wallet system with **unrestricted operator control***

A field called `owner` does not look like operator control in review. It read as
bookkeeping. That is how it passed.

## The constraint that was missed

**Mitra is not a custodian.** The capital boundary had been made trustless — the
vault program enforces mandates on chain, and no operator can widen one without
the holder's signature. But the *commercial* layer above it was centralised by
omission: one deployer authored the refusal vocabulary, the asset registries
(`BASE_ASSETS`, `SOLANA_ASSETS`, `TEMPO_TOKENS` as module constants), and the
suspension switch.

> A trustless control plane cannot ask the operator whether the operator was allowed.

That is the whole reason governance here is **arithmetic over a member set** rather
than a permission check. A permission check asks "is this caller allowed?" and
needs someone to ask. Counting distinct approvers against a recorded threshold can
be done by any holder of the Space record.

## Decision

### 1. Two modes, peers — not tiers

| | `ADMIN` | `QUORUM` |
|---|---|---|
| Chosen by | the Space's own participants | the Space's own participants |
| Binding needs | 1 admin | `threshold` distinct governors |
| Freeze risk | one party, **by agreement** | no single party |
| Intended for | small, fast engagements | anything shared |

`ADMIN` is **not** a fallback or a weaker tier. It is a deliberate arrangement for
participants who could have chosen quorum and chose not to. The failure was
shipping only one mode and letting a single party freeze others — not the
existence of either.

### 2. The mode is not a Mitra setting

It is recorded *in the Space* and was agreed by its participants. Mitra ships both
and defaults to neither.

### 3. A Space cannot advertise governance it does not have

`QUORUM` with `threshold: 1` is **refused at configuration**. It is an admin wearing
a quorum's name, and honouring it would let a Space appear self-governed while one
party still controlled it. An `ADMIN` who is not also a governor is likewise
refused — an off-ledger authority.

### 4. Approvals are arithmetic, deduplicated, and from the member set

- duplicates never increase the count (one governor submitting thrice is not a
  quorum);
- an approval from a non-governor is **invalid**, not weaker;
- the `owner` field is retained as the initiator and **has no authority**.

### 5. Marketplace rules are referenced, not absorbed

Marketplaces have their own rules. Re-implementing them inside Mitra would make
Mitra the authority on someone else's marketplace — the centralisation this design
exists to remove. So an external rule set is bound **by identity and content
hash**:

```ts
rules: { source: "external", ruleSetRef: "erc8183:job-lifecycle:v1", digest: "sha256:…" }
```

and `externalRulesChanged` **surfaces** a digest mismatch rather than adopting the
new terms. Silently applying them would hand the marketplace unilateral power over
every participant.

Mitra binds itself to a digest and does not need to *understand* the rules in order
to comply with them. That is what makes integration-without-absorption possible,
and it is how a Virtuals or ERC-8183 rule set integrates without becoming
Mitra-administered.

### 6. Membership is not tenancy

`spaceId` becomes **optional** and the foreign key nullable. External agents
interoperate without joining a Mitra Space, which §3.3 requires
(*"works with external agent economies rather than requiring agents to migrate"*).
A Space, where present, constrains **Mitra-managed capital inside it** — not what
Mitra may observe.

## Consequences

- The `owner`-alone freeze path is gone; `decide()` is the only way to change
  status, and it counts.
- Governance is verifiable by anyone holding the Space record. No operator is in
  the loop, so there is nothing to audit except the arithmetic.
- Asset registries stop being module constants and become per-Space configuration,
  resolvable on chain. *(Not yet implemented — tracked as an open item below.)*
- Multi-party engagements reference several Spaces rather than being forced into
  one tenancy. *(Not yet implemented.)*

## Open items — implementation, NOT re-decision

These follow from the decision above and are not grounds to reopen it:

1. Make `spaceId` optional and the FK nullable.
2. Move asset registries from module constants into Space configuration.
3. Multi-Space references for multi-party engagements.
4. Surface governance state in `GET /api/v1/spaces`, so a participant can see
   *who can freeze me, on whose authority*.
5. ERC-7715/7710 as the on-chain delegation standard for the same rule, and the
   Virtuals adapter under `rules.source = "external"`.

## Why this is locked

ADR-0010 got the shape of `Space` right and its authority wrong. That cost a full
audit pass and produced F33 and F37, both instances of the same failure — a
constraint applied to the *data* and not to the *authority*.

The rule that follows, and the reason this record exists: **a field named `owner`
is a design claim that a reviewer cannot check by reading its type.** `owner:
string` looks like bookkeeping. It was a kill switch. Anything that grants
authority must be visible as such — in the type, in the schema, and in a test
whose name states what must be impossible.

## Honest limit

A repository that deploys a program **is** that program's governor. Full
self-governance means the program reads its policy from state participants control.

The vault already does: mandates are PDAs, the guard re-derives, and no operator
can widen one. That is proven on devnet. Space governance is now participant-held
off-chain. Bridging the two — putting the Space's rule set on chain — is the
remaining work, and it is the honest boundary of what this ADR claims.
