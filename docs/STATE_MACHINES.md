# State Machines

## Agent
UNREGISTERED → DISCOVERED → CLAIMED → CONTROL_VERIFIED → REGISTERED → AUTHORITY_PENDING → FUNDED → ACTIVE. ACTIVE may transition to SUSPENDED and later REACTIVATED. REVOKED is a distinct terminal identity state absent a governance-controlled replacement process.

## Reservation
REQUESTED → RESERVED → COMMITTED → SETTLING → SETTLED, with RELEASED, CANCELED and EXPIRED branches.

## Authorization
EVALUATING → ALLOW | DENY | REVIEW. ALLOW is executable only while valid and only if the execution guard sees the exact action digest and relevant constraints.

## Agreement
OPEN → FUNDED → EXECUTING → SUBMITTED → ACCEPTED | REJECTED, with refund/cancel/expiry branches according to explicit terms.

## Obligation
PROPOSED → ACCEPTED → ACCRUING → DUE → CLEARED → SETTLING → SETTLED, with DISPUTED and DEFAULTED branches.

## Saga
DECLARED → EXECUTING → RECOVERY_PENDING → RECOVERING → RECOVERED | CONTAINED | ABORTED.

RECOVERED, CONTAINED and ABORTED remain semantically distinct outcomes.

## Clearing epoch
OPEN → FROZEN → CALCULATING → CHALLENGE → FINALIZED → SETTLING → SETTLED.

The finalized input set is immutable. Disputed obligations remain visible and excluded rather than silently netted.
