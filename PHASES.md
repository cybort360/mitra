# Build phases

Work is split so that **each phase has one owner and one verifiable conclusion**.
Nobody starts the next phase until the current one is demonstrated working.

The rule that makes this work: *a phase ends with something you can show, not
something someone describes.* If you cannot demonstrate it, the phase is not
done.

## Where we are

| Phase | Status | Conclusion |
|---|---|---|
| 0. Kernel hardening | ✅ **Done** (PR #2) | 4 holes closed, 23 tests, independently reviewed |
| 1. Wire the kernel | ✅ **Done** | A DENY is reachable over HTTP |
| 2. State machines | ⬜ Next | Illegal transitions are impossible |
| 3. Persistence | ⬜ Blocked by 1 ✅ now unblocked | No seed array; durable event log |
| 4. Console | ⬜ | Pages are components driven by real state |
| 5. Integration | ⬜ | One external system, honestly labelled |

---

## Phase 1 — Wire the kernel into the API

**Owner: one agent.** Why single: it defines the contract everything else consumes.

**The problem today.** `evaluateProposal`, `validateExecutionBinding`,
`reserve`, `releaseReservation` and `consumeReservation` are called by **nothing**
in `app/`. Only `reconcileVault`, `netObligations` and `failureScenarios` are
reachable. The product displays economic state it does not compute. `POST
/api/v1/runs` returns a fabricated id and moves nothing.

**Scope**

- `POST /api/v1/authorizations` — calls `evaluateProposal`, returns decision and reason codes
- `POST /api/v1/reservations` — calls `reserve`, then `validateExecutionBinding`
- `POST /api/v1/runs` — drives the real path instead of returning a fake id
- Zod validation at the boundary; nonces consumed per mutation

**Definition of done — all four must be demonstrable**

1. `curl` a proposal that violates the mandate → `DENY` with reason codes
2. `curl` a valid proposal → `ALLOW` → reservation created
3. Execute against an **expired** reservation → `RESERVATION_EXPIRED`
4. Replay a consumed nonce → `NONCE_ALREADY_CONSUMED`
5. `npm run typecheck && npm test && npm run build` green
6. Tests **fail** if you break a guard (prove they're real)

**Explicitly out of scope:** state machines, Postgres, UI.

---

## Phase 1 — Wire the kernel into the API

**Owner: cline.** ✅ Complete.

**What shipped**

- `POST /api/v1/authorizations` — calls `evaluateProposal`; DENY returns 403 with reason codes
- `POST /api/v1/reservations` — `GET` list, `POST` create; calls `reserve` after policy
- `POST /api/v1/reservations/execute` — the execution guard
- `lib/store/ledger.ts` — process-local capital and nonce state, so nonce replay is
  enforced by the server rather than asserted by the caller

**Demonstrated over HTTP**

| Case | Result |
|---|---|
| Unapproved counterparty | `DENY [COUNTERPARTY_NOT_ALLOWED]` |
| Prohibited capability | `DENY [CAPABILITY_NOT_ALLOWED,CAPABILITY_PROHIBITED]` |
| Valid proposal | `ALLOW` + action digest |
| Reservation | capital moves available → reserved |
| Expired reservation | `RESERVATION_EXPIRED` |
| Tampered digest | `ACTION_DIGEST_MISMATCH` |
| Wrong chain | `CHAIN_MISMATCH` |
| Replayed instruction | `NONCE_ALREADY_CONSUMED` |

**Notes for the next owner**

- The ledger is **in-process**. Restarting loses consumed nonces. That is the
  Phase 3 problem, and it is a real limitation, not a detail.
- `recentSpend` is derived server-side from held reservations, never from the
  request, so a caller cannot under-report it to slip the velocity limit.
- **Bug found during this phase and fixed:** nonces were hardcoded to `1`, so once
  one reservation was spent every later execution on that vault was refused as a
  replay. The ledger now allocates them, with two regression tests.

---

## Phase 2 — State machine enforcement

**Owner: one agent.** `docs/STATE_MACHINES.md` defines 7 machines; none are
enforced. `Run.status` is currently a free string.

**Scope** — one new file, `lib/kernel/machines.ts`, with a transition guard per
machine. Illegal transitions become impossible, not merely discouraged.

| Machine | Terminal states that must stay distinct |
|---|---|
| Reservation | `RELEASED` / `EXPIRED` / `CANCELED` |
| Saga | `RECOVERED` / `CONTAINED` / `ABORTED` |
| Clearing epoch | finalized input set immutable; disputed excluded, not silently netted |
| Agent, Authorization, Agreement, Obligation | per `docs/STATE_MACHINES.md` |

**Definition of done**

1. Every legal transition passes; every illegal one throws with a reason code
2. Phase 1's routes now reject an illegal transition end-to-end
3. A test per machine covering both directions
4. The three saga outcomes are demonstrably not interchangeable

---

## Phase 3 — Persistence

**Owner: one agent.** Now that a real transaction path exists, this makes it
survive a restart.

**Scope** — replace `lib/store/data.ts` (currently `export * from "./seed"`) with
Postgres + an append-only event log. Introduce a repository interface so routes
depend on an interface, not a seed array.

**Definition of done**

1. A run survives process restart
2. `RunEvent` is append-only and the timeline replays from it
3. No route imports `seed.ts` directly
4. Migrations run forward and back

⚠️ **`lib/store/seed.ts` is 411 lines of shared surface and the top merge-conflict
risk.** During this phase, seed changes happen in one place, by one person.

---

## Phase 4 — Console

**Owner: one agent (or split by page group with agreed component contracts).**

The 15 pages total 89 lines of template-literal HTML — `app/policies/page.tsx`
has a 2,496-character single line. It is a mockup, not a product.

**Scope** — convert to real components fed by Phase 3's data.

**Definition of done**

1. No page returns an HTML string
2. Every page renders live state; no hardcoded ids or hashes
3. Empty and loading states handled honestly
4. `context_check_drift` reports healthy

---

## Phase 5 — External integration

Only now does the README's original list make sense. Keep the `docs/EVIDENCE.md`
discipline — it is the most mature thinking in this repo and the reason the
project has been honest about its limits.

**Order:** one marketplace deeply → Solana vault/controller programs → Base and
Tempo → x402 / MPP / MCP → reconciliation, webhooks, observability.

**Definition of done per integration:** a real `EvidenceRecord` with network,
commit, transaction hash and a test command. Anything less is `DESIGN_ONLY` and
labelled as such.

---

## Ownership rules

1. **One owner per phase.** Not a suggestion — the kernel is 170 lines but it is
   the financial core. Two agents reasoning about conservation and action-digest
   binding simultaneously produces conflicting correctness, not speed.
2. **One owner per directory.** `lib/kernel/*`, `app/api/v1/*`, `lib/store/*`.
3. **No phase starts before the previous is demonstrated.** Merge, then advance.
4. **Phases 1→2→3 are strictly sequential.** 3 needs 1's transaction path; 2 needs
   1's routes to enforce transitions through.

## Using shared context across agents

The phases above are also recorded as context entries, so any agent can
`context_digest` and see who owns what.

- **Claiming a phase:** `context_remember` kind=`task` naming yourself as author
- **Starting work:** `context_remember` kind=`decision` — why, and what you rejected
- **Blocked:** kind=`blocker` naming who or what is needed
- **Finishing:** kind=`handoff` — done / next / risk, plus the demonstration
- **Disagreement:** supersede, never silently contradict
