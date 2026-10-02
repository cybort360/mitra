/**
 * State machine transition guards.
 *
 * `docs/STATE_MACHINES.md` documents seven machines, and until now nothing
 * enforced any of them: `Run.status` and friends were free strings, so an
 * illegal transition was merely discouraged by convention. These tables make
 * illegal transitions impossible to express.
 *
 * Design rules, following the kernel convention:
 *  - Pure. No clock, no IO, no store. A guard takes two states and returns a
 *    decision, so it stays testable and can be reused by any transport.
 *  - Terminal states are explicit and have no outgoing edges. This is what
 *    makes RECOVERED, CONTAINED and ABORTED genuinely distinct rather than
 *    three names for "finished".
 *  - Every rejection carries a machine-readable reason, because these reasons
 *    are what the API and the audit log speak.
 */

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Internal state names, including the ones the domain types fold away. */
export type LifecycleState = string;

const ok: TransitionVerdict = { ok: true };
const deny = (reason: string): TransitionVerdict => ({ ok: false, reason });

/**
 * Allowed transitions per machine. A state absent from a machine's table is
 * terminal.
 */
export const TRANSITIONS: Record<string, Record<LifecycleState, LifecycleState[]>> = {
  agent: {
    UNREGISTERED: ["DISCOVERED"],
    DISCOVERED: ["CLAIMED"],
    CLAIMED: ["CONTROL_VERIFIED"],
    CONTROL_VERIFIED: ["REGISTERED"],
    REGISTERED: ["AUTHORITY_PENDING"],
    AUTHORITY_PENDING: ["FUNDED"],
    FUNDED: ["ACTIVE"],
    ACTIVE: ["SUSPENDED"],
    SUSPENDED: ["REACTIVATED"],
    REACTIVATED: ["ACTIVE"],
    // REVOKED is terminal: a distinct identity state, replaced only by an
    // explicit governance process, not by a transition.
    REVOKED: [],
  },

  mandate: {
    DRAFT: ["ACTIVE"],
    ACTIVE: ["EXPIRED", "SUSPENDED", "REVOKED"],
    SUSPENDED: ["ACTIVE", "REVOKED"],
    EXPIRED: [],
    REVOKED: [],
  },

  reservation: {
    REQUESTED: ["RESERVED", "CANCELED", "EXPIRED"],
    RESERVED: ["COMMITTED", "RELEASED", "CANCELED", "EXPIRED"],
    COMMITTED: ["SETTLING", "RELEASED"],
    SETTLING: ["SETTLED"],
    SETTLED: [],
    RELEASED: [],
    CANCELED: [],
    EXPIRED: [],
  },

  agreement: {
    OPEN: ["FUNDED", "CANCELED", "EXPIRED"],
    FUNDED: ["EXECUTING", "REFUNDED", "CANCELED", "EXPIRED"],
    EXECUTING: ["SUBMITTED", "REFUNDED", "CANCELED"],
    SUBMITTED: ["ACCEPTED", "REJECTED"],
    ACCEPTED: ["REFUNDED"],
    REJECTED: ["REFUNDED"],
    REFUNDED: [],
    CANCELED: [],
    EXPIRED: [],
  },

  obligation: {
    PROPOSED: ["ACCEPTED"],
    ACCEPTED: ["ACCRUING", "DISPUTED"],
    ACCRUING: ["DUE", "DISPUTED", "DEFAULTED"],
    DUE: ["CLEARED", "DISPUTED", "DEFAULTED"],
    DISPUTED: ["DUE", "CLEARED"],
    DEFAULTED: [],
    CLEARED: ["SETTLING"],
    SETTLING: ["SETTLED"],
    SETTLED: [],
  },

  // Aligned to PRD 15.3 on 2026-10-02. The previous table went
  // DECLARED -> EXECUTING -> RECOVERY_PENDING -> RECOVERING, which dropped ARMED,
  // STEP_FAILURE and COMPENSATING entirely.
  //
  // **ARMED was a safety gap, not a naming preference.** PRD 15.5 requires that
  // "a compensation route must be committed before execution when possible", and
  // ARMED is the state in which that commitment exists. Without it the table
  // permitted DECLARED -> EXECUTING directly, so a saga could begin executing with
  // NO committed recovery route - precisely the situation 15.5 forbids. There was
  // now a path to irreversible action with no defined way back.
  saga: {
    DECLARED: ["ARMED", "ABORTED"],
    // ARMED requires at least one committed compensation route. That is enforced by
    // the kernel, not here, because it is a property of the saga's contents rather
    // than of the edge.
    ARMED: ["EXECUTING", "ABORTED"],
    EXECUTING: ["STEP_FAILURE", "RECOVERED", "CONTAINED", "ABORTED"],
    STEP_FAILURE: ["COMPENSATING"],
    COMPENSATING: ["RECOVERED", "CONTAINED", "ABORTED"],
    // Three distinct terminal outcomes. Collapsing them would erase the
    // difference between "recovered the value" and "stopped the loss".
    RECOVERED: [],
    CONTAINED: [],
    ABORTED: [],
  },

  clearingEpoch: {
    OPEN: ["FROZEN"],
    FROZEN: ["CALCULATING"],
    CALCULATING: ["CHALLENGE"],
    CHALLENGE: ["FINALIZED"],
    FINALIZED: ["SETTLING"],
    SETTLING: ["SETTLED"],
    SETTLED: [],
  },
};

export const MACHINES = Object.keys(TRANSITIONS);

/** Is this state final for the machine? Terminal states have no outgoing edges. */
export function isTerminal(machine: string, state: LifecycleState): boolean {
  const table = TRANSITIONS[machine];
  if (!table) return true;
  const next = table[state];
  return next === undefined || next.length === 0;
}

/**
 * May this machine move from `from` to `to`?
 *
 * Self-transitions are rejected. A machine that is already in a state does not
 * need to be told so, and allowing it would let a caller "re-commit" a settled
 * reservation by transitioning it to itself.
 */
export function canTransition(machine: string, from: LifecycleState, to: LifecycleState): TransitionVerdict {
  const table = TRANSITIONS[machine];
  if (!table) return deny(`UNKNOWN_MACHINE: ${machine}`);

  if (from === to) return deny(`NO_OP_TRANSITION: already ${to}`);
  if (isTerminal(machine, from)) return deny(`TERMINAL_STATE: ${from} is terminal for ${machine}`);

  const allowed = table[from];
  if (!allowed) return deny(`UNKNOWN_STATE: ${from} is not a ${machine} state`);

  if (!allowed.includes(to)) {
    return deny(`ILLEGAL_TRANSITION: ${machine} cannot move ${from} -> ${to}`);
  }
  return ok;
}

/**
 * Apply a transition, returning the next state.
 *
 * Throws on an illegal transition rather than returning a verdict, so a caller
 * cannot accidentally ignore the result and write the new state anyway.
 */
export function transition<T extends { status: string }>(
  machine: string,
  entity: T,
  to: LifecycleState,
): T {
  const verdict = canTransition(machine, entity.status, to);
  if (!verdict.ok) throw new Error(verdict.reason);
  return { ...entity, status: to } as T;
}

/** Every state the machine permits from here, for UI affordances. */
export function nextStates(machine: string, from: LifecycleState): LifecycleState[] {
  return TRANSITIONS[machine]?.[from] ?? [];
}
