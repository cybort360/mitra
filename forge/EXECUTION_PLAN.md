# EXECUTION PLAN

The roadmap is the PRD's (§52), not a locally invented one. This file maps work
already done onto that roadmap and names what is next.

## Why this file exists

An earlier `PHASES.md` was written before the PRD was available and used its own
numbering. That created two competing truths about what "Phase 2" means. The PRD
wins; this file is the reconciliation. `PHASES.md` is retained as a historical
record of how the work was actually sequenced.

## Status against the PRD roadmap

| PRD Phase | Exit condition | Build | Evidence | Blocker |
|---|---|---|---|---|
| **0. Ground truth** | Every P0 object has a schema and state transition definition | ✅ schemas, ADRs, machines | `INTEGRATED` | `INTEGRATED` — the registry covers all **8** PRD §6 objects. The old blocker here ("Space was never frozen in `p0-registry.ts`") was itself wrong: §6 has exactly 8 objects and Space is not among them, so the exit condition never required it. Space is a scope, not a §6 economic object (ADR-0010) |
| **1. Core** | Local end-to-end lifecycle passes | ✅ full lifecycle | `E2E_VERIFIED` | — |
| **2. Solana kernel and vault** | Real devnet vault creation, funding, reservation, guarded spend, release/refund, settlement | ✅ raw SBF program | `LIVE_DEMONSTRATED` | — |
| **3. Authority and confidential policy** | Agent cannot execute an out-of-policy transaction | ✅ mandate, authorization, consume-on-spend, amendment, revocation, policy seam, signer abstraction | `LIVE_DEMONSTRATED` (spend leg) | `DEFERRED` — `FR-VAULT-008/009` remain `UNTESTED`. F43 fixed two real circuit bugs (zero-amount actions were ALLOWED; every DENY returned one reason code). F44 found the Anchor program was an unmodified template — it has since been rewritten and compiles, but **no MPC cluster has ever run**, so no decision has been computed |
| **4. Commerce** | Real job opened, funded, submitted, accepted, rejected, refunded | ✅ Space + lifecycle + routes + **ERC-8183 projection** | `TESTED` | `PARTIAL` — Space covers 4 of 10 §13.1 contents (ADR-0010); ERC-8183 is a local projection, not an on-chain job |
| **5. Agent ecosystem** | External agent participates without becoming Mitra-native | ✅ MCP surface + A2A lifecycle + **ERC-8004 projection** + **x402/MPP** | `E2E_VERIFIED` (MCP, local); `LIVE_DEMONSTRATED` (x402 payment) | `BLOCKED_INTERNAL` — the API has no caller identity (F55), so `mitra_fund_agreement` / `mitra_accept_deliverable` / `mitra_reject_deliverable` are withheld from the live MCP server; 6 tools are unbacked (no agent registry, intent store or event-read route); Virtuals marketplace adapter not built; registry projections are local. **Done (sprint item 4):** stdio MCP server, 9 tools served through the API (`npx tsx scripts/mitra-mcp.ts`); x402 V2 gateway (`POST /api/v1/x402`, reference SDK, reservation + execution guard before signing), live via the public facilitator. **CORRECTED:** this row said `BLOCKED_EXTERNAL` for "no live MCP transport" — that was internal work, not an external dependency |
| **6. Recovery** | Deliberately failed job reaches a defined terminal recovery state | ✅ saga persistence (F49) + Layer A coupling (F50) + Layer B routes (`/api/v1/sagas`) | `INTEGRATED` | `PARTIAL` — Full local lifecycle verified: deliverable rejection drives `applyAgreementOpWithSaga` through `EXECUTING -> STEP_FAILURE -> COMPENSATING -> RECOVERED`, releases `space.committed`, persists to repository, and serves via `GET /api/v1/sagas`. Built from §15 directly; on-chain TALOS contract recovery remains for future phase |
| **7. Clearing** | Deterministic netting passes adversarial graph tests | ✅ epoch write path, immutability, challenges, 8 adversarial suites | `TESTED` | `PARTIAL` — **digest FIXED (F45)**, no live epochs. The commitment was FNV-1a over `fields.join("|")`; it is now domain-separated SHA-256 via `typedHash`, and the `join("|")` ambiguity that let two different obligation sets share a digest is gone. **Remaining: no epoch has ever been finalized on a live network** |
| **8. Base** | Same economic intent executes on Base through the common API | ✅ Base + Solana adapters + **EIP-712** + **ERC-1271** + **ERC-4337 envelope** | `LIVE_DEMONSTRATED` (adapter leg; agreement path on Base) | `PARTIAL` — transports settled live on **Base Sepolia** (EOA, `BaseRpcTransport`) and **Solana devnet** (`VaultTransport` on the F51 vault). **Caller wired (sprint item 1):** `POST /api/v1/settlements` pays an `ACCEPTED` agreement through `lib/kernel/settlement.ts` (execution guard re-run against a digest re-derived from the agreement) and a rail from `lib/settlement/rails.ts`; live on Base Sepolia 2026-10-03, see PROOF_LEDGER. **Open:** (1) settlement does not draw down `vault.reserved` (neither does `/reservations/execute`); (2) Solana through the agreement path is not shown live; (3) no paymaster sponsorship or external bundler — the relayer is the bundler. **Done (sprint item 3):** ERC-4337 — a Coinbase Smart Wallet pays through EntryPoint v0.6 (`MITRA_BASE_SETTLEMENT_ACCOUNT=erc4337`), and `RpcSignatureVerifier` checks ERC-1271 and ERC-6492 signatures on chain; both live 2026-10-03. F54 records that the repo's earlier 4337 envelope and script could not reach an EntryPoint. **Done (sprint item 2):** `getEvidence()` builds bundles from the chain on all three rails, live-verified 2026-10-03; settlement receipts are hash-chained but unsigned (F53) |
| **9. Tempo** | A Mitra obligation can target Tempo settlement through the same interface | ✅ Tempo adapter + **MPP** + **payment metadata** + **receipt mapping** | `LIVE_DEMONSTRATED` (adapter leg) | `PARTIAL` — `ModeratoTransport` settles live in TIP-20 via `transferWithMemo`, commitment on chain as the memo; see PROOF_LEDGER. **Caller wired (sprint item 1):** an `ACCEPTED` agreement with `payTo.chain = "tempo"` settles through `POST /api/v1/settlements` when `TEMPO_RPC_URL` is configured — **not yet shown live through that path** (only the adapter leg is). **CORRECTED (F40):** the blocker previously also said mints and decimals were "supplied, not read from chain". They now are — `lib/adapters/tempo.ts` carries only what `name()` returned on Moderato, and `tests/tempo-adapter.test.ts` re-derives every name from a node under `TEMPO_LIVE=1`. Deploy/pay semantics are also established live (`scripts/tempo-pay.mjs`) |
| **10. Production tooling** | A pilot can operate without reading protocol logs | ✅ accounting + reconciliation + `/api/v1/accounting` | `TESTED` | `PARTIAL` — console still a mockup; obligations/settlements still fixture-backed; no webhooks/observability |

**Reading this table.** `Build` is what exists. `Evidence` is what has been
demonstrated, and for Phases 3–10 that is deliberately `TESTED`, not
`LIVE_DEMONSTRATED`: the local suites are mutation-audited, but nothing in Phases
3–10 has been deployed. Phase 2 is the only phase with on-chain proof.

**Deployment is the closing phase**, deliberately. Every adapter without a
transport throws rather than fabricating, so the code is safe to ship and the
gap is visible rather than hidden.

## The honest position on Phase 2

This is the most important line in the file.

**Phase 2's exit condition is on-chain proof, and it is MET.**

`programs/mitra-vault` is deployed on devnet at
`GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` (upgradeable loader; the real code
lives in ProgramData account `9aUb2ZozqkBsxQwBn59GWWHeJL5kvFXXQAgbK2eLXKon` —
**109,984 bytes**, re-verified against `api.devnet.solana.com` on 2026-02-10), with
vault `5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T`. All six clauses of the exit
condition are demonstrated by `scripts/vault-devnet.mjs`, which is idempotent — run
twice, same result — so the evidence is reproducible rather than a one-shot
observation.

**This section previously said the opposite.** It read:

> The PRD's Phase 2 exit condition is on-chain proof. We do not have it. There
> is no Solana program, no vault controller, no testnet vault, no receipt
> anchoring, no settlement.

That was true when written on 2026-01-10, and stale almost immediately after: the
toolchain and 5 SOL of devnet were `VERIFIED` at that point, and
[ADR-0007](../docs/adr/0007-phase2-builds-a-real-solana-program.md) had already
recorded the decision to build a real program rather than a controller stub. The
build then happened and ran. A reader arriving at that paragraph — which sat
*below* the status table that said the opposite — would conclude the program did
not exist.

The stale text is deleted rather than reconciled, because a paragraph asserting a
negative is more dangerous than a missing one: a reader who finds no Phase 2
section asks, whereas a reader who finds one stops reading.

Five defects surfaced only on a real chain and are recorded as F19. The local
suite passed 18/18 before every one of them; the BPF-VM path is moot now that a
real validator has been used.

**What remains is Phases 3–10, and none of them is blocked externally.** Every
environment is funded and reachable; the eight remaining phases are unbuilt, not
blocked. Per-phase blockers are in `forge/PROOF_LEDGER.md`.

**The one-line version of what is still missing:** the program proves the boundary,
but the *kernel* still holds capital in Postgres. Phase 2 demonstrates that capital
can be held on-chain without breaking the invariants; it does not yet mean the
product's capital lives there.

What exists is a *local* economic kernel that is correct and well tested:

- policy evaluation and action-digest binding
- capital accounting with `CHECK` constraints and a row lock
- nonce replay protection that survives a restart
- a state machine for reservations, enforced on write
- deterministic netting with conservation proofs

### Phase 1 — Core — `PARTIAL`

Done: canonical serialization and content hashing (`lib/domain/canonical.ts`),
pinned by 18 tests including the float and key-order cases. Receipt chaining per
PRD §17.3. `actionDigestFor` now uses a domain-separated canonical hash instead
of a positional `JSON.stringify`.

**Finding.** Canonicalizing the action digest changed every digest it produces
(F11). Harmless now — nothing durable depends on it yet — but it would have
silently frozen every outstanding reservation at execution time. Recorded with
the old and new values pinned in `tests/digest-compat.test.ts`, so a second
silent change cannot happen.

Not done: PRD §52 Phase 1 also requires a purely local end-to-end lifecycle
across all eight objects. The kernel covers mandate → vault → reservation →
authorization; Agent, Intent, Agreement, Deliverable, Obligation, Saga and
Receipt have schemas and machines but no write path. That is the remaining
Phase 1 work.

That is genuine progress toward the PRD's Phase 1, and a *prerequisite* for
Phase 2, but **it is not Phase 2**. Counting it as Phase 2 progress would be
exactly the "implemented ≠ verified" failure the Foundry exists to prevent.

## Phase 0 — Ground truth — `PARTIAL`

Done: the P0 object registry is data (`lib/domain/p0-registry.ts`), and
`tests/phase0-registry.test.ts` asserts the exit condition against the real types
and transition table, so it can fail. Five ADRs recorded. Evidence levels
defined, including `FAILED` and `REGRESSED`, which were in use but undefined.

The audit found two real gaps a prose checklist would have passed: `clearingEpoch`
had a machine nobody had claimed, and two evidence statuses were undefined.

Not done: canonical *serialization* — required by PRD §4.7 for receipt content
hashes — does not exist yet. That is Phase 1 work, recorded there.

The Postgres repository (previously "Phase 3") falls in the same category. It was
not in the PRD roadmap. It is retained because it makes concurrency and
durability testable, and those properties are required by `FR-VAULT-004` and
`FR-CORE-005`, but it should not be presented as roadmap progress.

## Next

**Phase 2 is closed.** Its six steps are done; the program is deployed at
`GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` and `scripts/vault-devnet.mjs`
demonstrates them idempotently.

**The next steps are closure work, in this order** — chosen by how many `UNTESTED`
invariants each unblocks per unit of effort, not by phase number:

1. **Test `withdraw`.** The code exists at `programs/mitra-vault/src/lib.rs:304`
   and has **zero** tests across all six test files. `FR-VAULT-006` is recorded
   `UNTESTED` on the rationale "no withdrawal path exists to test" — which is
   inaccurate: the path exists and is untested. Cheapest real invariant closure in
   the repository, because the code is already written and only the test is missing.
2. ~~**`FR-COM-001/002/003`**~~ **CLOSED (F42)** — all three are now `VERIFIED`
   against `tests/commerce-escrow.test.ts`, cited to PRD §13.4 (they had been cited
   to §12, which is payment transport and does not define them). Testing them found
   that `space.committed` was never decremented, so a Space's budget behaved as a
   lifetime cap and the eleventh payment was permanently impossible.
3. **Arcium** — start the local MPC cluster and execute `evaluate_mandate`, which
   unblocks `FR-VAULT-008` and `FR-VAULT-009` together.
4. **Wire transports** for Base and Tempo, then upgrade their evidence above `TESTED`.
5. **Finalize a clearing epoch on a live network.** The digest is now
   signature-grade (F45), but no epoch has ever been closed against a real
   participant set, so Phase 7 stays `PARTIAL` on evidence rather than on code.

**The structural item that outranks all four:** `transition()` in
`lib/kernel/machines.ts` has **no callers outside tests**. Six of the seven state
machines are definitions that nothing writes through — including the saga, which is
why "failure is a state transition, not an exception" is `UNTESTED` for want of a
saga that ever runs. A green suite coexists with this because the tests drive the
machines directly. It is not a bug and it is not in the PRD's phase list, but until
the machines sit on the write path the rest of the closure work is recorded against
definitions rather than behaviour.

## Working agreement

One owner per phase. One conclusion per phase — something demonstrable, not
something describable. No phase starts before the previous is demonstrated.
