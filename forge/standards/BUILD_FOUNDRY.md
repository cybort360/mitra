# BUILD_FOUNDRY.md

**Version:** 1.0
**Purpose:** Canonical execution, verification, evidence, and gap-closure standard for repository work.

---

# 0. Mission

Build software that can be:

1. understood;
2. tested;
3. demonstrated;
4. independently verified;
5. defended under criticism;
6. recovered when it fails;
7. extended without silently invalidating prior guarantees.

The Foundry exists to prevent four common failure modes:

```text
implemented ≠ verified
verified locally ≠ proven live
deployed ≠ working
documented ≠ true
```

A repository is not complete because code exists.

A repository is complete to the degree that its admitted claims have evidence, its known gaps have dispositions, and recurring failure classes have guards.

---

# 1. Foundry invariant

The primary invariant is:

> Every meaningful claim must have a gate. Every gate must have evidence. Every discovered gap must have an explicit disposition. Every repeatable failure should strengthen the system that allowed it.

Operationally:

```text
CLAIM
  ↓
EVIDENCE

UNKNOWN
  ↓
ASSUMPTION

FAILURE
  ↓
REPRODUCTION
  ↓
FIX
  ↓
REGRESSION GUARD

BLOCKER
  ↓
MINIMAL REPRODUCER
  ↓
EXTERNAL DEPENDENCY

DEPLOYMENT
  ↓
LIVE VERIFICATION
  ↓
MONITORING
```

No agent, developer, reviewer, or report may silently collapse these distinctions.

---

# 2. Evidence vocabulary

Do not use generic `DONE`.

Every meaningful capability must use one of the following states.

| State | Meaning |
|---|---|
| `PROPOSED` | Design exists. No implementation claim. |
| `IMPLEMENTED` | Code exists. Verification incomplete. |
| `TESTED` | Narrow/local tests prove stated behavior. |
| `INTEGRATED` | Required internal components work together. |
| `E2E_VERIFIED` | Complete intended workflow succeeds in controlled E2E environment. |
| `LIVE_DEMONSTRATED` | Workflow successfully executed at least once against required external/live substrate. |
| `LIVE` | Deployed and currently operational with current evidence. |
| `MONITORED` | Live plus automated runtime verification/alerting. |
| `PARTIAL` | Some behavior works, with explicitly named residual gaps. |
| `BLOCKED_EXTERNAL` | Required external capability prevents progression. |
| `BLOCKED_INTERNAL` | Repository defect prevents progression. |
| `DEFERRED` | Intentionally not being completed in current scope. |
| `REJECTED` | Investigated and deliberately not being built. |
| `FUTURE` | Outside current admitted scope. |

Claims must never use evidence from a lower state to imply a higher one.

Examples:

```text
unit test            ≠ E2E_VERIFIED
mock integration     ≠ LIVE_DEMONSTRATED
contract deployed    ≠ workflow executed
tx submitted         ≠ finalized
HTTP 200             ≠ business success
simulated TEE        ≠ hardware-attested TEE
test wallet          ≠ real user adoption
```

---

# 3. Source-of-truth hierarchy

Every serious repository MUST define its truth ordering.

Default:

```text
1. Verified deployed state / finalized external evidence
2. Canonical upstream protocol/API specifications
3. Repository PRD / protocol specification
4. Accepted ADRs
5. Executable reference model / schemas
6. Tests
7. Implementation
8. Comments
9. README / marketing copy
```

A project may alter this order deliberately.

When two authoritative sources conflict:

```text
STOP
↓
record contradiction
↓
determine impact
↓
create ADR or assumption
↓
resolve with evidence
```

Never silently choose the convenient interpretation.

---

# 4. Pre-build substrate audit

No implementation begins until the underlying substrate has been inspected.

The audit asks:

```text
What already exists?
What behavior is native?
What is merely inconvenient versus actually missing?
What is the residual gap?
Why does our proposed primitive need to exist?
```

Produce:

```text
SUBSTRATE:
NATIVE CAPABILITIES:
DEPLOYED / VERIFIED BEHAVIOR:
MISSING BEHAVIOR:
CURRENT WORKAROUNDS:
RESIDUAL GAP:
PROPOSED PRIMITIVE:
ARCHITECTURE DELTA:
WHY A WRAPPER IS INSUFFICIENT:
FALSIFICATION CONDITION:
```

The build MUST stop or change direction when research shows the proposed primitive is merely duplicating substrate-native behavior without a meaningful architecture delta.

---

# 5. Canonical repository control plane

For substantial builds, use:

```text
/
├── BUILD_FOUNDRY.md
├── PRD.md
├── AGENTS.md
├── README.md
│
├── foundry/
│   ├── state.json
│   ├── gaps.jsonl
│   ├── claims.jsonl
│   ├── assumptions.md
│   ├── contradictions.md
│   ├── phases/
│   ├── decisions/
│   ├── evidence/
│   ├── reviews/
│   └── runbooks/
│
├── scripts/
│   ├── verify
│   ├── verify-phase
│   └── check-foundry
│
└── .github/
    ├── PULL_REQUEST_TEMPLATE.md
    └── workflows/
        ├── ci.yml
        └── watchdog.yml       # where runtime/release monitoring is justified
```

For small builds, the mandatory kernel is only:

```text
BUILD_FOUNDRY.md
PRD.md
foundry/state.json
foundry/gaps.jsonl
foundry/claims.jsonl
scripts/verify
```

Do not create ceremonial files with no enforcement value.

---

# 6. Project state

`foundry/state.json` is the canonical machine-readable state.

Example:

```json
{
  "project": "example",
  "version": 1,
  "current_phase": "03",
  "status": "IN_PROGRESS",
  "head": "git-sha",
  "last_verified_head": "git-sha",
  "last_verified_at": "2026-09-13T20:00:00Z",
  "critical_open_gaps": 0,
  "high_open_gaps": 2,
  "external_blockers": 1,
  "live_evidence_current": false
}
```

Rules:

- `last_verified_head` MUST identify the exact commit that passed.
- Verification of commit `A` does not automatically verify commit `B`.
- Dirty worktree verification is not canonical release evidence.
- A project cannot be reported `PASS` when admitted critical gaps remain open.

---

# 7. Phase specification

Every build phase MUST have an explicit phase file:

```text
foundry/phases/03-<name>.md
```

Template:

```text
# Phase 03 — <name>

STATUS:
OWNER:

## Objective

What capability is introduced?

## Why this phase exists

What gap does it close?

## Admitted scope

What is inside this phase?

## Explicitly excluded

What must NOT be built here?

## Preconditions

What must already be true?

## Invariants

I-01:
I-02:

## Deliverables

- ...
- ...

## Required verification

- ...
- ...

## Live verification

Required: YES | NO

If YES:
- target:
- observable:
- success condition:

## Evidence required

- test output
- artifact
- transaction
- screenshot
- trace
- deployment manifest
- etc.

## Exit gate

The phase is PASS only when:

1. ...
2. ...
3. ...

## Stop conditions

Stop if:

- ...
- ...

## Known non-goals

- ...
```

No phase may become `PASS` solely because code compiles.

---

# 8. Gap Closure Ledger

`foundry/gaps.jsonl` is mandatory.

Every known material defect, missing property, contradiction, operational weakness, unsupported claim, or verification hole becomes a gap.

One JSON object per line.

Canonical schema:

```json
{
  "id": "GAP-042",
  "title": "Concise failure description",
  "severity": "CRITICAL",
  "class": "SECURITY",
  "surface": "packages/sdk",
  "status": "REPRODUCED",
  "introduced_by": null,
  "discovered_at": "2026-09-13T20:00:00Z",

  "expected": "Expected behavior",
  "observed": "Observed behavior",

  "evidence": [
    "foundry/evidence/GAP-042/repro.txt"
  ],

  "affected_invariants": [
    "I-07"
  ],

  "root_cause": null,

  "closure_condition": [
    "Malformed persisted state causes execution to fail closed",
    "Atomic persistence prevents partial state",
    "Regression test reproduces historical failure"
  ],

  "required_verification": [
    "unit",
    "integration",
    "full_verify"
  ],

  "live_verification_required": false,

  "regression_guard_required": true,
  "regression_guard": null,

  "blocked_by": null,
  "resolution": null,
  "closed_by_commit": null,
  "closed_at": null
}
```

---

# 9. Gap state machine

Allowed progression:

```text
DISCOVERED
    ↓
REPRODUCED
    ↓
CLASSIFIED
    ↓
CLOSURE_DEFINED
    ↓
IMPLEMENTED
    ↓
VERIFIED_LOCAL
    ↓
VERIFIED_SYSTEM
    ↓
VERIFIED_LIVE        # where required
    ↓
GUARDED              # where recurrence is automatable
    ↓
CLOSED
```

Alternative dispositions:

```text
BLOCKED_EXTERNAL
BLOCKED_INTERNAL
DEFERRED
REJECTED_NOT_A_GAP
DUPLICATE
```

Rules:

### `DISCOVERED → REPRODUCED`

Must contain evidence of the failure.

### `REPRODUCED → CLOSURE_DEFINED`

Must contain objective closure conditions.

Bad:

```text
Fix the payment bug.
```

Good:

```text
Two concurrent retries with the same settlement key result in
exactly one value-moving settlement and one duplicate rejection.
```

### `IMPLEMENTED → VERIFIED_LOCAL`

Requires appropriate narrow tests.

### `VERIFIED_SYSTEM`

Requires affected integration/system suite.

### `VERIFIED_LIVE`

Required whenever the original claim depends on external infrastructure.

### `GUARDED`

Required when the same class of failure can reasonably be prevented by automated enforcement.

### `CLOSED`

Cannot occur without canonical evidence.

---

# 10. The recurrence rule

After fixing every P0/P1 or architecturally meaningful defect, ask:

> Can this class of mistake be detected automatically next time?

Possible guards include:

```text
unit test
property test
invariant
schema constraint
type relationship
lint rule
CI assertion
deployment check
documentation test
health probe
watchdog
runtime alert
database constraint
state-machine restriction
```

If `YES`, create the guard.

If `NO`, document why.

A repeated human instruction is not a sufficient guard when executable enforcement is feasible.

---

# 11. Claims Ledger

`foundry/claims.jsonl` tracks important product, protocol, security, demo, and submission claims.

Example:

```json
{
  "id": "CLM-017",
  "claim": "A retried settlement cannot cause duplicate payment",
  "category": "SAFETY",
  "state": "E2E_VERIFIED",
  "required_state": "E2E_VERIFIED",
  "evidence": [
    "tests/settlement-idempotency.test.ts",
    "foundry/evidence/phase-05/e2e.log"
  ],
  "limitations": [
    "Not yet verified across multi-region failover"
  ],
  "last_verified_head": "abc123",
  "last_verified_at": "2026-09-13T20:00:00Z"
}
```

Every public-facing technical claim should be traceable to this ledger or an equivalent repository mechanism.

Marketing language must not outrun it.

---

# 12. Assumptions

`foundry/assumptions.md` distinguishes unverified assumptions from facts.

Format:

```text
| ID | Assumption | Status | Impact if false | Evidence needed | Resolution |
|----|------------|--------|-----------------|-----------------|------------|
| ASM-001 | RPC exposes archive state for N days | OPEN | Recovery path breaks | live query | — |
```

Allowed status:

```text
OPEN
RESOLVED
REJECTED
SUPERSEDED
```

A resolved assumption MUST cite evidence.

Never rewrite an unresolved assumption as confirmed capability.

---

# 13. Contradictions

Use `foundry/contradictions.md` for conflicts between:

```text
spec vs implementation
docs vs live behavior
API docs vs actual response
two official sources
tests vs deployed system
README vs code
```

Every contradiction has:

```text
ID:
SOURCE A:
SOURCE B:
CONFLICT:
IMPACT:
CURRENT DECISION:
EVIDENCE:
ADR:
STATUS:
```

Material contradictions must block claims they invalidate.

---

# 14. ADR discipline

Create an ADR when changing:

```text
trust model
authority model
state ownership
custody
settlement semantics
chain/network choice
protocol message format
security boundary
upgrade model
storage durability model
canonical source of truth
irreversible architectural decision
```

Do not create ADRs for ordinary implementation details.

Each ADR must state:

```text
Status
Context
Decision
Alternatives
Why rejected
Consequences
New invariants
Migration implications
Evidence
Supersedes / Superseded by
```

---

# 15. Implementation method

Before editing:

```text
1. read PRD;
2. read BUILD_FOUNDRY;
3. inspect current phase;
4. inspect open gaps affecting the phase;
5. inspect assumptions/contradictions;
6. inspect existing implementation and tests;
7. identify exact exit gate;
8. implement only admitted scope.
```

During implementation:

- smallest coherent change;
- no TODO pretending to satisfy required behavior;
- no swallowed errors;
- no fake-success external branches;
- no security check disabled without explicit waiver;
- no hidden mutation outside expected state transitions;
- no unsafe retry without idempotency reasoning;
- no duplicate canonical definitions when one source can be shared;
- no behavior claims based solely on code inspection.

---

# 16. The read-back rule

An edit is not a fix until the resulting code has been inspected.

After modifying critical behavior:

```text
edit
↓
git diff
↓
read changed code path
↓
run narrow verification
↓
run affected integration verification
↓
only then report implementation
```

This is mandatory for automated/code-agent edits.

Do not assume a patch applied merely because an editing command exited successfully.

---

# 17. Failure classification before explanation

When an external or distributed workflow fails, classify before theorizing.

Example classes:

```text
APPLICATION_BUG
CONTRACT_REVERT
RPC_STATE_LAG
RPC_ARCHIVE_UNAVAILABLE
PREREQUISITE_NOT_FINAL
PREREQUISITE_STATE_MISMATCH
AUTHORIZATION_FAILURE
EXTERNAL_POLICY_REFUSAL
NETWORK_FAILURE
RATE_LIMIT
SCHEMA_DRIFT
DEPLOYMENT_DRIFT
UNKNOWN
```

Avoid diagnosing a protocol defect when stale infrastructure state could explain the observation.

For dependent transactions:

```text
submit prerequisite
↓
await receipt
↓
require success
↓
require sufficient finality
↓
read resulting state
↓
assert expected delta
↓
execute dependent action
```

“Transaction confirmed” is not always equivalent to “all readers can observe the resulting state.”

---

# 18. Verification ladder

Run the minimum appropriate subset during development, but canonical PASS requires the entire phase gate.

Default ladder:

```text
V0  format / static syntax
V1  typecheck / compile
V2  narrow unit
V3  property / invariant
V4  package/module test
V5  integration
V6  repository verification
V7  controlled E2E
V8  target-network/live
V9  runtime monitoring
```

A project should expose stable commands such as:

```bash
make verify
make verify-phase PHASE=03
```

or:

```bash
pnpm verify
pnpm verify:phase 03
```

Do not make reviewers reconstruct twenty undocumented commands.

---

# 19. Canonical `verify`

`scripts/verify` should aggregate the checks that define repository health.

Typical serious repository:

```text
toolchain
format
lint
typecheck
unit
property/invariant
integration
contracts
security scans
secret scan
schema/drift checks
build
e2e
foundry consistency
```

Only include checks that matter to the repository.

A small frontend should not run Slither.

A Solidity settlement protocol probably should.

The Foundry optimizes for **sufficient evidence**, not maximum ceremony.

---

# 20. Foundry consistency check

`scripts/check-foundry` should fail when control-plane invariants break.

At minimum:

```text
- every phase has a legal status
- no CLOSED gap lacks evidence
- no CLOSED gap lacks closed_by_commit
- no RESOLVED assumption lacks evidence
- no LIVE claim references only local evidence
- no current PASS phase contains admitted CRITICAL open gaps
- current state head matches repository expectations
```

Recommended additional checks:

```text
- claim evidence paths exist
- ADR statuses are legal
- security waivers have expiry
- phase IDs are unique
- gaps have closure conditions
- LIVE claims carry recent enough verification where freshness matters
```

---

# 21. External blocker protocol

Use `BLOCKED_EXTERNAL` only when the repository cannot proceed without an external capability.

A valid blocked report MUST contain:

```text
BLOCKER:
DEPENDENCY:
EXACT REQUEST / TRANSACTION:
EXPECTED:
ACTUAL:
REDUCED REPRODUCER:
RESPONSE / REVERT:
WHAT HAS BEEN RULED OUT:
EXACT QUESTION FOR DEPENDENCY OWNER:
SAFE FALLBACK:
AFFECTED CLAIMS:
AFFECTED PHASE:
```

Do not use “blocked” for ordinary bugs that remain under repository control.

---

# 22. Live evidence

For anything that depends on a chain, external API, protocol, model provider, payment rail, database, cloud runtime, browser wallet, or other live substrate, ask:

```text
Does the claim require live behavior?
```

If yes, local tests are insufficient.

Store evidence under:

```text
foundry/evidence/<phase-or-gap>/
```

Possible evidence:

```text
transaction hashes
block/ledger numbers
request/response transcripts
deployment manifests
signed receipts
traces
screenshots
browser recordings
RPC reads
database state snapshots
hashes of externally retrieved artifacts
```

Sensitive credentials must never be included.

---

# 23. Evidence freshness

Some evidence decays.

Examples:

```text
live endpoint health
deployment compatibility
contract address assumptions
API behavior
external model behavior
market-data compatibility
dependency versions
```

Claims based on such evidence should include:

```text
last_verified_at
last_verified_head
target/environment
```

Do not treat six-month-old live evidence as current operational truth where drift is possible.

---

# 24. Product surface completeness

Protocol correctness is not sufficient for a user-facing build.

A capability is not product-complete until the user can reach it.

For each primary capability, define:

```text
ENTRY POINT
EXPLANATION
ACTION
LOADING STATE
SUCCESS STATE
FAILURE STATE
EMPTY STATE
RECOVERY PATH
VISIBLE PROVENANCE
NEXT ACTION
```

Every serious product additionally considers:

```text
information architecture
first-run onboarding
wallet/account/authentication flow
primary workflow
history
proof/evidence inspection
responsive behavior
accessibility
demo journey
```

Three incomplete states:

```text
protocol with no usable workflow
dashboard that merely dumps internal state
landing page with no route into the product
```

The UI may simplify protocol complexity.

The protocol must not weaken its guarantees merely to make the UI easier.

---

# 25. Demo completeness

A convincing demo must have a deterministic journey.

Target:

```text
2–4 minutes
```

The demo should establish:

```text
1. problem;
2. primary action;
3. system decision/state transition;
4. meaningful external integration;
5. evidence/proof;
6. failure/recovery or safety property;
7. resulting user value.
```

Anything critical to judging must not require:

```text
private credentials
manual database edits
hidden terminal commands
unexplained pre-seeded state
oral explanation of invisible behavior
```

unless the evaluator explicitly expects developer tooling.

---

# 26. Demo vs production

Every repository report must separate:

## Necessary for the primitive

What must exist for the architecture to be coherent?

## Necessary for a convincing demo

What proves the mechanism to an evaluator?

## Production requirements

What is necessary before real economic/security-critical use?

## Can wait

What adds polish or scale but does not validate the thesis?

This prevents both underbuilding and premature production engineering.

---

# 27. Security posture

Security-sensitive projects should explicitly model:

```text
identity
authority
permissions
credentials
scope
budget
replay
state transitions
trust boundaries
external dependencies
upgrade authority
recovery
revocation
settlement/finality
auditability
```

Agent systems additionally require:

```text
principal
delegate
mandate
allowed actions
allowed targets
asset/value limits
expiry
rate limits
evidence requirements
revocation
human intervention boundary
```

Wallet access is not equivalent to authority.

Authentication is not equivalent to authorization.

Identity is not equivalent to a mandate.

---

# 28. Threat-to-invariant binding

Material threat-model entries should reference the invariant they threaten.

Example:

```text
I-07: A settlement key produces at most one value-moving execution.

T-12:
Concurrent retries reach separate workers before idempotency record creation.

Mitigation:
Database uniqueness + reservation-before-execution.

Verification:
Concurrent integration test.
```

This is better than a threat model that merely lists scary scenarios.

---

# 29. Security waivers

A security check may be waived only with:

```text
ID
STATUS
SCOPE
REASON
OWNER
CREATED
EXPIRES
COMPENSATING CONTROL
REMOVAL CONDITION
```

No permanent anonymous suppressions.

Expired waivers make verification fail until renewed or removed.

---

# 30. Pull request contract

Every PR should answer:

```text
What was wrong?
What changed?
What invariant/capability does this affect?
How was it verified?
What evidence exists?
What remains unfinished?
Does this close a gap?
What regression guard was added?
```

Recommended template:

```text
Closes GAP-___ / Issue #___

## Change

...

## Why

...

## Verification

Paste actual output or link canonical evidence.

## Claims affected

CLM-___

## Regression guard

...

## Remaining work

...

## External operations still required

...
```

“Tests pass” is insufficient when the actual proof can be shown.

---

# 31. Git discipline

Default:

```text
one coherent capability/fix per branch
one comprehensible commit sequence
no unrelated refactor mixed into critical behavior
```

For autonomous phase-based builds:

```text
one dedicated build branch
one coherent commit per passing phase
```

Canonical evidence should reference commit SHAs.

Do not report a verification result from commit `A` as evidence for commit `B` unless the relevant paths are demonstrably unchanged.

---

# 32. Dependency and workflow integrity

For security/economic systems:

- commit lockfiles;
- avoid unnecessary floating dependencies;
- pin privileged CI actions where appropriate;
- secret-scan repository/history;
- validate workflow configuration;
- keep privileged release/deploy workflows under explicit review.

When a specific workflow property has already regressed, add an executable guard for it.

---

# 33. Runtime watchdogs

Use watchdogs for high-value paths whose failure occurs outside normal PR verification.

Candidates:

```text
release pipeline
deployed API
critical cron/reconciliation
indexer
provider registry
payment enforcement
signed manifest validity
cross-chain relay
database migration compatibility
```

Pattern:

```text
schedule
↓
probe actual semantic behavior
↓
if healthy → exit
↓
if unhealthy:
    preserve evidence
    find existing incident
    update or create issue
    alert
    fail watchdog
```

Do not monitor only process uptime when semantic health matters.

Example:

```text
/health returns 200
```

may still be broken if:

```text
registry disconnected
manifest unsigned
paid endpoint no longer returns 402
schema version incompatible
```

Probe the property users actually depend on.

---

# 34. Autonomous coding-agent protocol

An agent operating under this Foundry MUST:

### Before work

```text
1. inspect current repository state;
2. read BUILD_FOUNDRY.md;
3. read PRD.md;
4. read current phase;
5. inspect open critical/high gaps;
6. inspect affected claims;
7. inspect existing tests;
8. identify exact closure/exit condition.
```

### During work

```text
1. stay within admitted scope;
2. implement smallest complete change;
3. add/update tests with behavior;
4. inspect diff;
5. verify narrow path;
6. verify affected system;
7. record newly discovered gaps immediately;
8. do not silently downgrade requirements.
```

### Before reporting PASS

```text
1. canonical verify passes;
2. phase gate passes;
3. required live evidence exists;
4. no admitted critical gap remains;
5. claims ledger updated;
6. gap ledger updated;
7. assumptions/ADRs updated when necessary;
8. evidence stored;
9. worktree status recorded;
10. exact HEAD reported.
```

---

# 35. Agent stop conditions

Do NOT stop merely because:

```text
implementation is difficult
tests initially fail
a refactor is needed
an unknown bug appears
the expected API shape was wrong
```

Continue until the gap is either closed or legitimately blocked.

Stop only for:

```text
required credential unavailable
required funding unavailable
external network/API capability absent
authoritative sources materially conflict
central thesis falsified
action would violate explicit safety/deployment boundary
user-owned irreversible action is required
```

When blocked, produce the blocker report defined earlier.

---

# 36. Forbidden agent behavior

An agent MUST NOT:

```text
claim PASS because code compiles
claim LIVE from local mocks
claim deployment success without verifying deployed behavior
hide skipped tests
silently weaken assertions to make tests green
delete failing tests without justification
convert real errors into default-success states
swallow exceptions at trust boundaries
invent external API behavior
invent deployed addresses
invent transaction hashes
silently change architecture to bypass a hard requirement
mark an assumption resolved without evidence
close a gap with no closure proof
report another commit's test result as current HEAD evidence
```

---

# 37. Independent review

For security/economic/protocol phases, use two conceptual review roles.

## Security Reviewer

Attempts to falsify:

```text
authority
authentication
permissions
replay
concurrency
double execution
state transitions
failure recovery
secret handling
upgrade/admin paths
economic invariants
```

Output:

```text
PASS
REVISE
BLOCK
```

with findings.

## Evidence Auditor

Asks:

```text
Does the evidence actually prove the claim?
Is this the correct commit?
Was the correct environment used?
Were steps skipped?
Is a mock being presented as live?
Is deployed state actually observable?
Are limitations stated?
```

A green test suite does not replace either review perspective.

For small hackathon builds, one adversarial review can cover both roles.

---

# 38. Gap discovery sweep

Before finalization, perform an explicit sweep across:

```text
architecture
state machine
auth/authority
storage
durability
concurrency
retry/idempotency
external APIs
chain/network behavior
contracts
indexing
observability
deployment
CI
secrets
dependencies
frontend
mobile/responsive
error states
recovery
documentation
demo
submission requirements
```

Ask for each:

```text
What could be silently false?
What has no test?
What exists but has no caller?
What is written but never read?
What is read but never validated?
What is configured but never exercised?
What can fail outside CI?
What depends on an unstated ordering?
What has only mock evidence?
What would an evaluator try and discover is broken?
```

Every meaningful result becomes a GAP entry.

---

# 39. Dead-path audit

Explicitly detect:

```text
implemented but never called
state written but never consumed
cron/reconciler defined but never scheduled
config defined but never read
manifest fields emitted but never consumed
API documented but unreachable
frontend control with no backend behavior
backend capability with no product entry point
migration written but never applied
monitor written but never scheduled
```

“Exists in repository” is not equivalent to “participates in the system.”

---

# 40. Drift audit

Before release/submission compare:

```text
docs ↔ code
schema ↔ consumers
SDK ↔ MCP/tools
frontend ↔ backend
local ↔ deployed
package release ↔ deployed services
contract ABI ↔ client
deployment manifest ↔ chain
environment examples ↔ runtime
PRD ↔ implementation-status
```

Where two surfaces duplicate a concept, prefer a shared canonical definition over synchronized copies.

---

# 41. Final release gate

A serious release/submission may be marked `PASS` only when:

```text
[ ] exact target commit identified
[ ] clean canonical verification
[ ] admitted phase gates pass
[ ] no critical admitted gaps
[ ] high gaps explicitly dispositioned
[ ] required live evidence exists
[ ] claims ledger matches evidence
[ ] blockers are named
[ ] docs match current behavior
[ ] secrets scan passes
[ ] deployment state verified
[ ] primary user flow demonstrated
[ ] failure/recovery behavior understood
[ ] evaluator-visible evidence is accessible
[ ] known limitations are explicit
```

---

# 42. Required completion report

Every substantial execution session ends with:

```text
PHASE:
STATUS: PASS | FAIL | BLOCKED

HEAD:
BRANCH:
WORKTREE:

OBJECTIVE:

DELIVERED:

FILES CHANGED:

GAPS DISCOVERED:
GAPS CLOSED:
GAPS REMAINING:

CLAIMS PROMOTED:
CLAIMS INVALIDATED:

TESTS:
- unit:
- property/invariant:
- integration:
- e2e:
- live:

SECURITY CHECKS:

DEPLOYMENTS:

LIVE TRANSACTIONS / EXTERNAL EVIDENCE:

REGRESSION GUARDS ADDED:

KNOWN LIMITATIONS:

EXTERNAL BLOCKERS:

NEXT PHASE:
```

Do not substitute prose such as:

```text
Everything looks good.
```

---

# 43. Lightweight mode

For a short hackathon or prototype, the Foundry kernel is:

```text
PRD
↓
phase gate
↓
gap ledger
↓
claims ledger
↓
tests
↓
one verify command
↓
live/demo evidence
↓
final gap sweep
```

Minimum required files:

```text
BUILD_FOUNDRY.md
PRD.md
foundry/state.json
foundry/gaps.jsonl
foundry/claims.jsonl
scripts/verify
```

Minimum required checks:

```text
build/compile
typecheck where applicable
core behavior tests
critical invariant tests
secret scan
demo/E2E
Foundry ledger consistency
```

Do not add production machinery that does not strengthen the demo or validate the primitive.

---

# 44. Full mode

Production-sensitive infrastructure additionally considers:

```text
property testing
fuzzing
differential/reference-model testing
static analysis
dependency scanning
workflow integrity
migration tests
storage-layout checks
load/concurrency tests
chaos/recovery tests
runtime watchdogs
incident runbooks
key rotation
revocation
backup/recovery
release provenance
deployment drift
monitoring/alerting
```

These are introduced because the threat model requires them, not because the template contains them.

---

# 45. Closure standard

A gap is truly closed only when all applicable layers are satisfied.

```text
          discovered
              ↓
          reproduced
              ↓
      closure specified
              ↓
         implemented
              ↓
         narrow proof
              ↓
         system proof
              ↓
          live proof
        where required
              ↓
        recurrence guard
        where possible
              ↓
            CLOSED
```

The important question is not:

> Did we fix it?

The important questions are:

```text
How do we know it is fixed?

How do we know the actual target system contains the fix?

How do we know the same class of defect will not silently return?

What evidence would convince an independent reviewer?
```

---

# 46. Canonical build loop

All serious work converges on:

```text
RESEARCH
   ↓
SUBSTRATE AUDIT
   ↓
PROBLEM
   ↓
PRIMITIVE
   ↓
SPEC
   ↓
INVARIANTS
   ↓
PHASE
   ↓
IMPLEMENT
   ↓
TEST
   ↓
ADVERSARIAL REVIEW
   ↓
EVIDENCE AUDIT
   ↓
LIVE PROOF
   ↓
GAP SWEEP
   ↓
GUARDS
   ↓
DEMO
   ↓
RELEASE / SUBMISSION
   ↓
WATCH
   ↓
INCIDENT
   └──────────────────────→ GAP LEDGER
```

The system is intentionally recursive.

Failures are not exceptions to the process.

Failures are inputs that improve the process.

---

# 47. Root agent directive

`AGENTS.md` may simply contain:

```text
# Agent Directive

This repository is governed by BUILD_FOUNDRY.md.

Before modifying behavior:

1. Read BUILD_FOUNDRY.md.
2. Read PRD.md.
3. Read foundry/state.json.
4. Read the current phase.
5. Inspect open gaps and affected claims.

Do not report PASS unless the current phase exit gate is satisfied at the exact reported HEAD.

Do not conflate implemented, tested, deployed, live, and monitored behavior.

Any material newly discovered defect or unknown must become a gap or assumption before continuing.

Every meaningful fix must consider whether a regression guard can make recurrence machine-detectable.

When blocked externally, provide the smallest reproducer and exact dependency rather than approximating success.

Evidence outranks confidence.
```

---

# 48. Final principle

The Foundry should make it easier to tell the truth than to accidentally overclaim.

The repository should continuously transform:

```text
unknown
→ explicit assumption

bug
→ reproducible gap

fix
→ verified behavior

incident
→ permanent guard

implementation
→ evidence

evidence
→ defensible claim

live system
→ observable system
```

That is the standard.

**No hidden gaps. No unverifiable PASS. No claim without proportional evidence. No repeated failure without learning.**
