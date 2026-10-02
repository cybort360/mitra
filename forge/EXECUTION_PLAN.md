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
| **0. Ground truth** | Every P0 object has a schema and state transition definition | ✅ schemas, ADRs, machines | `INTEGRATED` | `PARTIAL` — Space was never frozen in `p0-registry.ts` (ADR-0010) |
| **1. Core** | Local end-to-end lifecycle passes | ✅ full lifecycle | `E2E_VERIFIED` | — |
| **2. Solana kernel and vault** | Real devnet vault creation, funding, reservation, guarded spend, release/refund, settlement | ✅ raw SBF program | `LIVE_DEMONSTRATED` | — |
| **3. Authority and confidential policy** | Agent cannot execute an out-of-policy transaction | ✅ mandate, authorization, consume-on-spend, amendment, revocation, policy seam, signer abstraction | `LIVE_DEMONSTRATED` (spend leg) | `DEFERRED` — Arcium circuit COMPILES but has not run on an MPC cluster (F31 removed the false blocker; the real one is unexecuted) |
| **4. Commerce** | Real job opened, funded, submitted, accepted, rejected, refunded | ✅ Space + lifecycle + routes + **ERC-8183 projection** | `TESTED` | `PARTIAL` — Space covers 4 of 10 §13.1 contents (ADR-0010); ERC-8183 is a local projection, not an on-chain job |
| **5. Agent ecosystem** | External agent participates without becoming Mitra-native | ✅ MCP surface + A2A lifecycle + **ERC-8004 projection** + **x402/MPP** | `TESTED` | `BLOCKED_EXTERNAL` — no live MCP transport; Virtuals marketplace adapter not built; registry projections are local |
| **6. Recovery** | Deliberately failed job reaches a defined terminal recovery state | ✅ saga kernel, ARMED gate, three distinct outcomes | `TESTED` | `BLOCKED_EXTERNAL` — TALOS absent from disk (F24); built from §15 directly, no TALOS reuse claimed |
| **7. Clearing** | Deterministic netting passes adversarial graph tests | ✅ epoch write path, immutability, challenges, 8 adversarial suites | `TESTED` | `PARTIAL` — no live epochs; digest is FNV-1a, not signature-grade |
| **8. Base** | Same economic intent executes on Base through the common API | ✅ Base + Solana adapters + **EIP-712** + **ERC-1271** + **ERC-4337 envelope** | `TESTED` | `DEFERRED` — no transport wired; no bundler/EntryPoint/paymaster deployed; nothing here has touched Base |
| **9. Tempo** | A Mitra obligation can target Tempo settlement through the same interface | ✅ Tempo adapter + **MPP** + **payment metadata** + **receipt mapping** | `TESTED` | `DEFERRED` — no transport wired; TIP-20 mints and decimals are supplied, not read from chain |
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

**The PRD's Phase 2 exit condition is on-chain proof.** We do not have it. There
is no Solana program, no vault controller, no testnet vault, no receipt
anchoring, no settlement.

**What changed on 2026-01-10:** the toolchain and the funds are now both
`VERIFIED` — Solana CLI 4.3.0, `cargo-build-sbf` proven by compiling a real
eBPF ELF, and **5 SOL** on devnet (`err=None` signature). [ADR-0007](../docs/adr/0007-phase2-builds-a-real-solana-program.md)
records the decision to build a real program rather than a controller stub. The
exit condition is still unmet; the gap is now a *build*, not a *blocker*.

**And then the build happened, and ran on devnet.** `programs/mitra-vault` is
deployed at `GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY` with vault
`5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T`.

**Phase 2 is `VERIFIED`.** All six clauses of the exit condition are demonstrated
on devnet by `scripts/vault-devnet.mjs`, which is idempotent — run twice, same
result — so the evidence is reproducible rather than a one-shot observation.

Five defects surfaced only on a real chain and are recorded as F19. The local
suite passed 18/18 before every one of them; the BPF-VM path is moot now that a
real validator has been used.

**What remains is Phases 3–10, and none of them is blocked externally.** Every
environment is funded and reachable; the eight remaining phases are unbuilt, not
blocked. Per-phase blockers are in `forge/PROOF_LEDGER.md`.

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

**Phase 2 exit condition, in dependency order:**

1. Vault controller program on Solana devnet
2. Signer abstraction so no principal key is held by an agent
3. Escrow and release/refund on-chain
4. Receipt anchoring for every capital movement
5. Settlement against the anchored obligation
6. A test run whose evidence is recorded in `PROOF_LEDGER.md`

Steps 4 and 5 are where the product stops being a simulation, and they are the
first point at which any claim above `LOCAL_PASS` becomes available.

## Working agreement

One owner per phase. One conclusion per phase — something demonstrable, not
something describable. No phase starts before the previous is demonstrated.
