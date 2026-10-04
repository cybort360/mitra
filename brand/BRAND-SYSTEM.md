# MITRA — Brand & Visual System
Derived from `docs/product/MITRA_0_1_FULL_PRODUCT_SPEC.md` (4,041 lines).
Everything below is traceable to a numbered section of that spec.

---

## A. Brand Core

**Positioning.** Financial coordination infrastructure for autonomous commerce.
Not a payment rail. Not a marketplace. The control plane that makes an economic
interaction — not just a transfer — coherent, recoverable, and auditable.

**The one idea the brand must carry** (§4.3, §59):

> Authority is separate from reasoning.

An agent may decide what it wants. It never decides whether it is *allowed*.
Everything in the identity serves this single distinction. Payment brands sell
speed; Mitra sells **bounded authority**.

**Tagline.** `Authority, commerce, clearing, recovery.`
**Sub-tagline.** `The economic control plane for autonomous agents.`
**Positioning line.** Payments let machines move money. Mitra lets them be
*trusted* with it. (§1.3)

**Emotional hook.** *Permission without panic.* The buyer of an agentic economy
is not a user — they are someone accountable for money moving without a human
watching every transfer. The brand should feel like the moment you stop watching.

**Target users** (§3.3, §27): agent developers, protocol treasury/ops teams,
autonomous-commerce marketplaces, and the principal who signs the mandate.

**Memorable thing.** The collapse. Fourteen obligations between seven parties
resolve into two transfers. That visual *is* the product thesis — §14.1 in one
frame. (See `hero-clearing.svg`.)

---

## B. Naming

**Keep MITRA.** The Indo-Iranian *mitra* means covenant/contract/alliance — the
semantic field is exact for bounded delegated authority. Per spec §1's own note,
trademark/domain/package clearance is still required before launch.

| Alternative | Verdict |
|---|---|
| MITRA | **Keep.** Short, ownable, semantically precise, no crypto-jargon. |
| MITRA CLEARING | Sub-brand for the epoch engine only. Never the company. |
| Clearnet | Generic, collides with clearing-house connotation. Reject. |
| Netra | Reads "network". Too infrastructure-anonymous. Reject. |
| Vouch | Misreads as a credit product. Reject. |

---

## C. Recommended Brand Direction

**"Instrument, not interface."**

The reference is not a crypto dashboard and not a fintech app. It is the visual
language of **precision measurement instruments** — oscilloscopes, bond desks,
clearing-house terminals. Dark field, hairline rules, monospace numerals,
restrained motion. Authority reads as *precision*, not as *power*.

This is a deliberate rejection of the dominant agent-economy aesthetic
(neon-gradient, glassmorphic, glowing-orb). Every AI brand currently looks like
the same landing page. Mitra should look like equipment.

---

## D. Logo Direction

**The Constrained Node.** A hexagonal aperture — the EIP-712/EIP-712-domain
framing of an authorised claim — with an inner ring that does not quite close.
The gap is the mandate boundary: authority granted, but bounded.

- Construction: 6-point aperture, 1 stroke, 45° optical weight. No fills.
- Wordmark: `MITRA`, Inter/Helvetica, tracking +180, uppercase, hairline.
- Never: gradient fills, 3D, drop shadows, mascot-adjacent rounded shapes.

---

## E. Color + Typography

| Token | Hex | Use |
|---|---|---|
| `--obsidian` | `#03050A` | Field |
| `--cobalt-deep` | `#0D1524` | Panel base |
| `--cobalt` | `#4D8DFF` | Structure, edges, live state |
| `--cobalt-dim` | `#2F6BFF` | Inactive obligations |
| `--slate` | `#5F7FB8` | Secondary type |
| `--ice` | `#CFE2FF` | Primary type |
| `--amber` | `#FFB340` | **Settled / capital moved.** Reserved. |
| `--amber-dim` | `#C98F2E` | Settled, low emphasis |

**Amber is rationed.** It appears only where capital has actually settled or a
state is terminal. If amber is everywhere, it means nothing. This mirrors the
repo's own evidence discipline: reserved for proven claims.

**Type.** Display: Inter (or Neue Haas) — 500/600, tracking +180 for wordmark.
Data: IBM Plex Mono for all numerals, hashes, block numbers, state enums.
Rationale: monospace numerals are non-negotiable in a ledger product; mixed
weights let you distinguish *narrative* from *evidence* at a glance.

**Grid.** 96px module. Rules at 5.5% opacity. Swiss discipline: nothing centered
that could be left-aligned, generous negative space, no decorative elements.

---

## F. Mascot Concept

**Strong recommendation: no mascot for the product.**

Reasoning: the product is a trust-and-verification layer. A cartoon agent
undermines §4.8 ("production-shaped, not falsely production-safe") and reads as
consumer toy. Judges evaluating infrastructure respond to precision, not charm.

**However** — one is needed for social and the hackathon stage, where warmth
converts. So: **the Custodian**, used *only* in non-product brand surfaces.

- Form: a small amber-ringed aperture, like a coin/ledger seal. Geometric, no
  face, no limbs. It reads as a *stamp of record*.
- Behaviour: it appears in the corner of a diagram when capital has settled; it
  never "speaks." Its whole vocabulary is ring-fill and pulse.
- Name: "Mitra" is already the brand. Do not name the mascot. A mascot with a
  name competes with the product name for memory.

---

## G. Product UX Flow

1. **Mandate** — principal sets budget, max tx, counterparty/capability allowlists.
   The first screen should *feel* like signing a cheque: bounded, dated, explicit.
2. **Intent** — agent declares objective + budget + failure policy.
3. **Discovery** — provider found via existing marketplace (Virtuals/Olas/Agentverse).
   Emphasise *portability*, not a walled marketplace (§8.2).
4. **Agreement + Escrow** — terms, acceptance criteria, capital committed.
5. **Execution** — A2A task, x402 micro-payment. Live event stream.
6. **Failure → Recovery** — the differentiator. Show the saga state machine
   visibly; compensation is a *protocol state*, not an error toast (§4.5).
7. **Clearing** — obligations net. This is the wow moment.
8. **Settlement + Receipt** — hash-linked receipt chain (§17.3).

**Key screen — the Economic Timeline (§27.7).** The single most important UI
surface in the product. A vertical event ledger, 10:01→10:21, monospace,
hash-linked. Every row is a receipt. This is what proves the product.

**Microcopy principles.** State names are protocol states, not UI strings —
`COMPENSATING` not "Something went wrong." Never say "safe" or "guaranteed"
(§4.8). Failure copy is calm and factual: `PROVIDER FAILED · ROUTE 2 ARMED`.

**Empty state:** the netting diagram, empty, with `EPOCH NOT FROZEN`. The empty
state teaches the product.

---

## H. Landing Page Direction

Single viewport, 16:9, the hero rendering as live SVG (not video — it should
animate from mesh→net on scroll, 1.4s, ease-out, lines drawing left-to-right).

Above the fold: `MITRA` / tagline / one CTA / the diagram.
Second fold: the four primitives as four ruled rows, not four cards.
Third: the Economic Timeline, running live.
Last: code + real tx hashes. **Real hashes are the brand.**

---

## I. Pitch Deck Visual Direction

- **Slide 3 is the diagram.** Don't bury it.
- Numbers large, monospace, always with a block number or tx hash beneath.
- Amber only on the settlement slide.
- One idea per slide. Text ≤ 12 words.
- Live demo fallback: a recorded 90s run with visible hashes.

---

## J. Image Generation Prompts

**Hero (as executed, `hero-clearing.svg`):**
> Intricate glowing vector lines forming a multilateral network of seven nodes
> collapsing into a minimal central clearing point; dark obsidian and deep cobalt
> grading; subtle amber accents on settled nodes; ultra-clean Swiss design;
> precision technical graphics; 8k; cinematic lighting; octane render --ar 16:9 --style raw

**Mosaic (clearing engine / epoch):**
> Abstract netting lattice, thousands of thin cobalt vectors resolving into four
> larger amber aggregate flows; obsidian field; Swiss typographic grid overlay;
> macro depth of field; no text; 8k --ar 16:9

**Custodian (social only):**
> Small amber-ringed geometric seal, floating on deep obsidian, soft volumetric
> glow, extreme minimalism, product-render quality, no face, no limbs --ar 1:1

**Negative prompt:** no neon purple, no glassmorphism, no glowing orb, no
robot face, no 3D chrome, no lens flare, no busy background.

---

## K. Final Creative Recommendation

**The brand's whole job is to make one technical distinction legible: an ALLOW
decision is not permission to move value.**

Every asset should make the *bound* visible — the aperture that doesn't close,
the ceiling not the amount, the amber that only appears when capital actually
settled. If a design shows money moving freely, it is wrong.

Ship the SVG diagram as the primary brand asset. It is the thesis, it is
animated, it is data-true to §14.1, and it costs nothing to render at any size.
