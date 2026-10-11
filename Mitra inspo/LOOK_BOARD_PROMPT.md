Design a LOOK BOARD for the Mitra landing page — not the full site. The goal is to
lock the visual direction (type, colour, diagram style, figure style, motion) before
anything gets built. 7 artboards.

WHAT MITRA IS (context for you; do not paste this onto the page)
Mitra lets a business give an AI agent a budget without giving it the keys. The agent
can decide what to buy, but it cannot move money on its own say-so. Every payment
passes three checks in order: (1) is it within the budget the owner set, (2) did the
owner's rules approve it, (3) a final, separate check that THIS exact payment
(recipient, amount, which budget, expiry, one-time code) matches what was approved.
Mitra also holds the money while a job is done, sends it back automatically if the
job fails, cancels out what parties owe each other so fewer payments happen, and
settles only what remains, with a receipt.
Audience: someone who has never heard of it. Not wordy, not empty.

COPY
(Revised 2026-10-11: the first headline read as an agent wallet. Mitra is positioned
like DTCC / NIBSS — a clearinghouse — not a wallet.)
Eyebrow: THE CLEARINGHOUSE FOR AGENTIC COMMERCE
Headline: Agents trade. Mitra clears.
Subline: Mitra is the financial coordination layer between AI agents and money. It
holds each budget, checks every payment, carries every deal through failure, and
cancels out what agents owe each other, so only what remains ever moves.
Hero figure: agents, marketplaces and services send what they owe into one clearing
block; a single net payment leaves for settlement. (The budget stack now lives in
the budget section.)
"You stay in control" is the message of the three-checks section, not the hero.
Section names (plain headline + small mono tag):
  01 The budget        [VAULT]         Money set aside for your agent. It sees what's
                                       free, what's on hold and what's committed, and
                                       can never touch the rest.
  02 The deal          [COORDINATION]  Every job is an agreement: who does what, for
                                       how much, by when.
  03 The safety net    [RECOVERY]      If a job fails, the money comes back. No chasing.
  04 Fewer payments    [NETTING]       You owe them $100, they owe you $70. Only $30
                                       moves.
  05 Final payment     [SETTLEMENT]    The remainder is paid, and you get a receipt.

VISUAL DIRECTION
- White background (#FFFFFF; off-white #F4F4F2 for figure panels), black foreground.
  Light theme only — the dark references are for motion, not palette.
- ONE bright accent. Default: electric blue (~#2B4BFF) = approved / active.
  Red (~#FF3B1F) is reserved for a refused/stopped state only, never decoration.
- HUGE typography: tight grotesk for display (e.g. Inter Tight or Geist, 160–220px
  on desktop, tight leading, slight negative tracking). Mono for labels, eyebrows and
  captions (e.g. Geist Mono / JetBrains Mono, uppercase, small, letter-spaced).
  Eyebrows in square brackets: [HOW IT WORKS], [OUR PRINCIPLE].
- Technical-drawing aesthetic: thin 1px strokes, isometric line figures, leader lines
  with arrowheads to mono labels, faint dot-grid inside figure panels, "FIG_01"
  captions rotated in the panel margin, hairline dividers, thin CORNER BRACKETS
  framing each figure (four L-shaped corners, not a full box), and a sparse
  dot-matrix pattern bleeding off the edges of section borders.
- One key phrase in the hero gets bracket highlights drawn around it, like
  ⌜IN CONTROL⌟.
- References: Kern (giant type + mono eyebrow + split hero), Medusa (isometric stacked
  and exploded layers, pale-blue fills), the floppy-disk exploded view (labelled parts
  with dashed alignment lines), UML activity diagrams (start node, decision diamonds,
  labelled branches), Signal (lines flowing into and out of a central node),
  Strategize (an isometric stack that builds itself, chips dropping in from above),
  Zettafleet (corner-bracket figure frames, one figure at a time with a 01/04 counter,
  line figures morphing into each other, text revealed line by line on scroll).

ARTBOARDS
1. HERO — desktop 1440×900. Split layout: giant headline left (words drop into place
   one by one, staggered, slight overshoot; then ⌜IN CONTROL⌟ brackets draw in),
   subline + two buttons right ("Get early access", "See how it works").
   Figure — THE VAULT BUILDS ITSELF (isometric, line-drawn, pale-blue top face):
     a. A base plate draws in, labelled YOUR MONEY.
     b. Three layers rise and stack on it, one at a time, each labelled on a leader
        line: SPENDABLE · ON HOLD · IN ESCROW.
     c. Connector lines draw down from the base to four small isometric tiles in a
        row: YOUR AGENT · YOUR RULES · FINAL CHECK · RECEIPTS.
     d. Payment requests (small flat chips, each with an amount) float in above and
        drop toward the top of the stack. One slots in and fills blue with a check.
        One is changed mid-fall (amount or name flickers), fills red, and is pushed
        back out. Then it idles: slow continuous drops, mostly blue, now and then red.
2. ACCENT TEST — the same hero at ~1/3 scale, three times: electric blue, signal
   red-orange, acid lime (lime as fill only, never as text on white). Static.
3. THE THREE CHECKS — a UML-activity-style diagram, animated in a loop. A dot (the
   payment) leaves "Agent asks to pay", passes three decision diamonds — "Within
   budget?", "Approved by your rules?", "Exact match?" — and reaches "Paid". Every
   second run the recipient changes mid-way: the dot turns red at the third diamond
   and takes a branch to "Stopped". Labels on every branch. This is the most
   important diagram on the site; make it clear enough for a non-technical person.
4. EXPLODED PAYMENT — one isometric figure: a payment card that comes apart vertically
   into labelled layers — WHO GETS PAID · HOW MUCH · WHICH BUDGET · EXPIRES ·
   ONE-TIME CODE · APPROVED BY — with dashed alignment lines and mono labels on leader
   lines. Loop: assembled → comes apart (labels draw in) → each layer gets a check
   mark in the accent → comes back together.
5. THE FIVE FUNCTIONS — a pinned section, Zettafleet style. Left: one isometric line
   figure inside corner brackets. Right: [OUR PRINCIPLE] eyebrow, a "01 / 05" counter
   on a hairline, the plain headline, two lines of explanation. Loop through all five:
   the figure MORPHS into the next one (budget stack → two linked cards for the deal →
   a loop arrow returning a coin for the safety net → crossing arrows collapsing into
   one for fewer payments → a receipt for final payment) while the text cross-fades.
   Above it, a one-paragraph intro ("What Mitra does") that reveals line by line,
   grey to black, as if scrolled.
6. FEWER PAYMENTS, IN DETAIL — the full diagram for one function: three parties with
   arrows of what each owes ($100, $70, $40…); the opposing arrows cancel out into a
   single remaining arrow, and the amount ticks down to what actually moves. Show how
   the other four functions would reuse this section layout.
7. MOBILE HERO — 390×844. Headline still dominant, the vault figure below, 16px side
   gutters, nothing scrolls sideways.

MOTION RULES
Every animation loops on its own artboard so it can be judged without scrolling.
Things BUILD and FALL INTO PLACE: line work draws on, layers rise and stack, chips
drop and slot in. Easing: confident, slightly springy entrances; slow, continuous idle
motion afterwards. No bouncing logos, no parallax gimmicks. Respect
prefers-reduced-motion (show the finished state).

DO NOT
- Invent customers, investor logos, metrics, testimonials or "live on mainnet" claims.
- Use crypto clichés (glowing coins, neon gradients, dark mode, rockets).
- Put the technical words (vault, netting, settlement) in headlines; they belong in
  the small mono tags only.
