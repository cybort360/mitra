# Colosseum submission — working draft

**This file is a scaffold, not submission copy.** Every claim below is a pointer to evidence
that already exists in this repository, so it can be checked before anyone else checks it.
The prose that goes into the actual submission form should be written by the team in your own
words — a judge reads a pasted paragraph as an artifact, not as an argument, and this
repository has never once won an argument by sounding more confident than its evidence.

Structure follows Section 8 (Winner Determination) of the Crypto World's Fair Official Rules.

---

## (a) Functionality — *How well does this Project Submission work? What is the quality of the code?*

**Reproduce it:**

```
npm install && npm run doctor      # live chain heads, ports, build state — ~2s
npm run typecheck                  # 0 errors
forge test                         # 63/63
cargo test --manifest-path programs/mitra-vault/Cargo.toml   # 147/147
npx vitest run                     # 1,385 passed, 83 skipped
npm run test:postgres              # run with DATABASE_URL set
npm run stack:up && npm run agents:run -- --cycles 2
```

**Evidence to point at:**

| Claim | Where it is verifiable |
|---|---|
| Contracts | `forge test` — 63 cases, `programs/` |
| On-chain program | `cargo test` — 147 cases, `programs/mitra-vault/` |
| Kernel, routes, SDK, MCP | `npx vitest run` — 1,385 cases across `tests/` |
| A full engagement settles, end to end, with three independent parties | `npm run agents:run -- --cycles 2` — buyer funds, provider submits, evaluator accepts; outcome read back from the API, not from the loop's own log |
| Every verdict has evidence | `npm run doctor` — reports chain head block/slot, never a bare "OK" |
| Live settlement on a public testnet | `forge/PROOF_LEDGER.md` — Base Sepolia `0x75dbc742…fb928`, Solana Devnet `jW14aBAb…HWZ` |

**The claim worth making, because it is unusual and it is true:** every figure this
repository reports is read back from the chain or the store *after* the operation, not from
the operation's own return value. A confirmed transaction is not the same claim as "the money
is back" — see F86 in `forge/FAILURES.md`, which is the incident that motivated the rule.

---

## (b) Potential Impact — *How big is the addressable market? Impact on the broader ecosystem?*

**The problem, stated plainly:** an autonomous agent that can spend money is a treasury
risk, and that risk is the main thing stopping businesses from giving agents budget. Every
existing answer either gives the agent the keys (custodial, so the owner has no ceiling) or
gives it nothing (so it cannot act).

**What is actually built:** a mandate is a *ceiling*, not a key. The agent can decide what to
buy; a separate execution guard independently re-derives whether that exact instruction may
move capital.

```
HOW MUCH MAY I SPEND → WHO AUTHORIZED IT → MAY THIS EXACT INSTRUCTION MOVE CAPITAL
     mandate              policy engine           execution guard
```

The second and third are separate on purpose. An `ALLOW` from the policy engine is **not**
permission to move value — it is one input to a decision made by a different component. That
separation is the product.

**Point at:** `forge/INVARIANTS.md` for the property and its status; `AGENTS.md` for the
mechanism in one paragraph.

---

## (c) Novelty — *How unique is the concept?*

Three things that are not standard:

1. **`ALLOW ≠ DISBURSEMENT`.** Policy approval and capital movement are decided by different
   components, and the second re-derives the spend decision from the owner's mandate rather
   than accepting the caller's. A human or an agent cannot supply its own spend decision.
2. **Multilateral cycle netting.** Three parties that owe each other settle only the net
   remainder, rather than moving every leg. `lib/kernel/clearing.ts`.
3. **Failure sagas with durable recovery.** A failure mid-execution leaves a persisted
   record, not an in-memory one — F79 exists because an earlier version reconstructed refund
   routes after the fact and would have invented compensation.

**Point at:** `forge/ARCHITECTURE.md`, `lib/kernel/clearing.ts`, `lib/commerce/saga.ts`.

---

## (d) UX — *How well does it use blockchain to create great UX for downstream users?*

- An operator console (`app/`) and a 22-tool Model Context Protocol gateway on `:3006`
  (`lib/mcp/`), so an agent integrates with a capability it already speaks.
- `npm run doctor` answers "does this actually work, here, now" in about two seconds.
- **Zero lost funds through autonomous recovery** — the keeper refunds an overdue escrow
  without any party asking (`scripts/keeper-daemon.ts`). This is the strongest UX claim
  available, because it is the one users notice when it fails.

**Honest framing:** the console is a working operator surface, not a polished product. The
agent-facing surface is the more developed half, deliberately — that is what composes.

---

## (e) Open-source — *Is it open-source? How well does it compose?*

> **Gap to close before submitting.** This repository currently has **no `LICENSE` file and
> no `license` field in `package.json`**. Public on GitHub is not the same as licensed: with
> no grant, there is no permission to use, modify or redistribute, and an open-source
> criterion answered "yes, MIT" on the strength of an absent file would be a false claim.
> Add the license file (and the `package.json` field) before this section is submitted, and
> state the actual license.

**Composability, which is already true:** composes with Solana PDAs, Base ERC-8183 job
escrows, Tempo TIP-20, the Model Context Protocol, and Virtuals ACP. It consumes escrow rails
rather than reimplementing them — `lib/commerce/escrow-rail.ts` resolves a rail per chain and
returns `null` (a refusal) when it cannot service one, rather than degrading quietly.

---

## (f) Business Plan — *Is there a viable business? How adept is the team?*

The commercial shape is an institutional clearinghouse: a clearing fee on netted volume plus
a vault security fee. Netting is what makes it defensible — the more participants in a
cycle, the more legs cancel and the less moves, so the value scales with the network rather
than with the volume Mitra intermediates.

**Team evidence, stated without embellishment:** the repository carries a proof ledger with
per-claim evidence, a failures register with 103 numbered entries, and a rule that a test may
not be weakened to make it pass. That process is the best available answer to "how adept is
the team", and it is checkable rather than asserted.

**Do not claim** revenue, users, pilots, or investors. None exist.

---

## Known limitations — disclose these

Stating these costs nothing and protects everything above them, because a judge who finds
one of them themselves stops trusting the rest.

1. **Mandate creation is unauthenticated (F100).** `POST /api/v1/mandates` mints the root of
   `Mandate → Authorization → Intent → Agreement`. It is narrowed — the vault and agent must
   exist, the mandate must approve the chain of its own vault, creation is first-write-wins,
   and `authority` is a pause scope — but **not yet principal-signed**. It should not be
   exposed beyond the operator plane. Agents structurally cannot do it: `MitraClient` has no
   capital-issuing verb and the MCP tool list contains no mandate write.
2. **`POST /api/v1/spaces` is a partial upsert (F102).** Posting an existing `spaceId`
   overwrites that Space's budget with a `201`, without checking ownership or governance.
   Unauthenticated budget inflation, open. The runner avoids it by owning its own Space.
3. **No mainnet funds are claimed.** Base Sepolia and Solana Devnet only. Tempo Moderato is
   unconfigured. Nothing here has been through a security audit, and no testnet token here
   is money.
4. **`mitra doctor` proves an endpoint answered, not that Mitra is live.** A ✓ means that
   specific probe returned a chain head just now. It is not a deployment claim and not a
   security audit — the command says so in its own footer.
5. **A passing test suite proves only the paths it executes.** F103 is the recorded instance:
   the keeper daemon passed typecheck and all 9 of its unit tests and could not be run at
   all, because the tests imported pure functions and never executed the entrypoint. Running
   the binaries is part of the verification protocol for exactly this reason.

---

## Before submitting — checklist

- [ ] Add `LICENSE` and `package.json` `license` field, then answer (e) truthfully
- [ ] Rewrite each section in the team's own words; this file is the evidence, not the copy
- [ ] Re-run the verification block above and paste the **fresh** numbers, not these
- [ ] Confirm every live hash in the submission appears in `forge/PROOF_LEDGER.md`
- [ ] No metric, user count, or "live on mainnet" claim anywhere in the final text