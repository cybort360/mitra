# State Machines

**These are enforced in code** by `lib/kernel/machines.ts`. `canTransition`
returns a verdict; `transition` throws on an illegal move. The reservation
machine is wired into `lib/store/ledger.ts`, so writes go through the guard
rather than merely being described here. The remaining six are defined and
tested but not yet attached to a write path — that is Phase 2 follow-up.

Two properties hold across every table:

- **Terminal states have no outgoing edges.** Nothing moves out of `SETTLED`,
  `RELEASED`, `EXPIRED`, `REVOKED`, `DEFAULTED` or `REFUNDED`.
- **Self-transitions are rejected.** A settled reservation cannot be
  "re-committed" by transitioning it to the state it is already in.

## Agent
UNREGISTERED → DISCOVERED → CLAIMED → CONTROL_VERIFIED → REGISTERED → AUTHORITY_PENDING → FUNDED → ACTIVE. ACTIVE may transition to SUSPENDED and later REACTIVATED. REVOKED is a distinct terminal identity state absent a governance-controlled replacement process.

## Mandate
Not in the original document but present in the domain types and the API surface, so it is enforced too. DRAFT → ACTIVE, with EXPIRED / SUSPENDED / REVOKED branches; EXPIRED and REVOKED are terminal.

## Reservation
REQUESTED → RESERVED → COMMITTED → SETTLING → SETTLED, with RELEASED, CANCELED and EXPIRED branches. **Enforced end-to-end.**

## Authorization
EVALUATING → ALLOW | DENY | REVIEW. ALLOW is executable only while valid and only if the execution guard sees the exact action digest and relevant constraints.

## Agreement
OPEN → FUNDED → EXECUTING → SUBMITTED → ACCEPTED | REJECTED, with refund/cancel/expiry branches according to explicit terms.

## Obligation
PROPOSED → ACCEPTED → ACCRUING → DUE → CLEARED → SETTLING → SETTLED, with DISPUTED and DEFAULTED branches. A disputed obligation may return to DUE or proceed to CLEARED; DEFAULTED is terminal.

## Saga
DECLARED → ARMED → EXECUTING → STEP_FAILURE → COMPENSATING → RECOVERED | CONTAINED | ABORTED.

PRD §15.3, verbatim. Corrected 2026-10-02 (F34): the previous table omitted ARMED,
STEP_FAILURE and COMPENSATING, and `docs/STATE_MACHINES.md` restated the
implementation without noting that §15.3 said otherwise.

**ARMED is load-bearing.** PRD §15.5 requires a compensation route to be committed
*before* execution; ARMED is the state in which it is committed. Without it the
table permitted DECLARED → EXECUTING — a path to irreversible action with no
defined way back, and on failure exactly the situation §15.5 forbids, where the
recovery engine must invent compensation calldata.

RECOVERED, CONTAINED and ABORTED remain semantically distinct outcomes, and the
guard treats them as such: none is reachable from another, and all three are
terminal. Collapsing them would erase the difference between "recovered the
value" and "stopped the loss".

## Clearing epoch
OPEN → FROZEN → CALCULATING → CHALLENGE → FINALIZED → SETTLING → SETTLED.

The finalized input set is immutable. Disputed obligations remain visible and excluded rather than silently netted.

## Rejection reasons

`ILLEGAL_TRANSITION`, `TERMINAL_STATE`, `NO_OP_TRANSITION`, `UNKNOWN_STATE`,
`UNKNOWN_MACHINE`. Machine-readable because the API and the audit log both
speak them.
