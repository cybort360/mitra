import { describe, expect, it } from "vitest";

/**
 * Hermetic harness for the Arcium confidential-policy circuit (PK2, F43/F44).
 *
 * ## Why this file exists, and what it is NOT
 *
 * The real circuit is Rust + Arcis, evaluated by an MPC cluster across Docker
 * nodes. Running it needs a localnet, a long build, and a live cluster — none of
 * which can run in CI, and none of which catch a regression until someone
 * remembers to run them by hand.
 *
 * So this is a MIRROR: a TypeScript transcription of
 * `/home/ubuntu/arcium-probe/probe/encrypted-ixs/src/lib.rs`, kept line-for-line
 * with the circuit's structure. It catches the class of defect that actually
 * happened — F43, where two logic errors made the reason-attribution mechanism
 * almost entirely unreachable. It does NOT prove the Rust compiles or that the
 * MPC cluster agrees; the SBF build is what covers that. Claiming this file
 * "verifies the circuit" would be the overclaim this repo exists to prevent.
 *
 * ## The two F43 defects, preserved as regressions
 *
 *  1. `is_nonzero` was `not_gt(0, x)` — i.e. `!(0 > x)` = `x >= 0`, ALWAYS TRUE.
 *     A zero-amount action was ALLOWED, the exact opposite of the guard above it.
 *     Here it is `gt(x, 0)`.
 *
 *  2. The original ran `when(is_zero(x), CODE, reason)` unconditionally, so a
 *     LATER failure overwrote an EARLIER one: a dead mandate that also breached
 *     max_transaction reported MAX_TRANSACTION_EXCEEDED. And a trailing
 *     `when_allowed(allowed, reason, REASON_AMOUNT_INVALID)` replaced `reason`
 *     for EVERY denial, since `(1 - allowed)` is 1 whenever the decision failed.
 *     That made reasons 1, 2, 4, 5 and 6 unreachable.
 *
 * ## Two corrections to the task brief
 *
 * The brief asked for `MANDATE_EXPIRED`, `LIMIT_EXCEEDED` and `INVALID_AMOUNT`
 * reason codes, and for an `expiresAt`/`currentTime` expiry guard. **None of
 * those exist in the circuit.** Expiry is not a time comparison here: it is
 * pre-folded on-chain into the encrypted `mandate_live` flag, and the limit is
 * split across `max_transaction`, `budget` and `available`. The tests below are
 * written against the real reason codes, because a harness asserting reason
 * codes the circuit cannot emit would pass forever while proving nothing.
 */

const REASON_OK = 0;
const REASON_MANDATE_NOT_LIVE = 1;
const REASON_CHAIN_NOT_ALLOWED = 2;
const REASON_AMOUNT_INVALID = 3;
const REASON_MAX_TRANSACTION_EXCEEDED = 4;
const REASON_BUDGET_EXCEEDED = 5;
const REASON_INSUFFICIENT_CAPITAL = 6;

export interface MandatePolicyInput {
  amount: number;
  maxTransaction: number;
  budget: number;
  available: number;
  mandateLive: number;
  chainAllowed: number;
}

export interface MandatePolicyOutput {
  allowed: number;
  reason: number;
}

/** `gt(x, 0)` — the FIXED form. `not_gt(0, x)` would be `x >= 0`, always 1. */
function isNonzero(x: number): number {
  return x > 0 ? 1 : 0;
}

/** Arcis secret-boolean `>` on unsigned values. */
function gt(a: number, b: number): number {
  return a > b ? 1 : 0;
}
function notGt(a: number, b: number): number {
  return 1 - gt(a, b);
}

/** Arcis `when(pred, value, otherwise)` — branchless select. */
function when(pred: number, value: number, otherwise: number): number {
  return pred ? value : otherwise;
}
function isZero(x: number): number {
  return x === 0 ? 1 : 0;
}

/**
 * Transcription of `evaluate_mandate`.
 *
 * MPC circuit structure is fixed at compile time and cannot branch on secret
 * data, so this is a chain of multiplications rather than early returns — the
 * same discipline as the Rust. Writing it with `if` statements would produce a
 * harness that agrees with itself and disagrees with the circuit.
 */
export function evaluateMandate(i: MandatePolicyInput): MandatePolicyOutput {
  const amountOk = isNonzero(i.amount);

  const withinMax = notGt(i.amount, i.maxTransaction);
  const withinBudget = notGt(i.amount, i.budget);
  const hasCapital = notGt(i.amount, i.available);

  let allowed = i.mandateLive * i.chainAllowed;
  allowed = allowed * amountOk;
  allowed = allowed * withinMax;
  allowed = allowed * withinBudget;
  allowed = allowed * hasCapital;

  // Precedence order — the FIRST failing check owns the reason, because each
  // `when` writes only while `reason` is still the OK sentinel.
  let reason = REASON_OK;
  reason = when(isZero(reason), isZero(i.mandateLive) * REASON_MANDATE_NOT_LIVE, reason);
  reason = when(isZero(reason), isZero(i.chainAllowed) * REASON_CHAIN_NOT_ALLOWED, reason);
  reason = when(isZero(reason), isZero(amountOk) * REASON_AMOUNT_INVALID, reason);
  reason = when(isZero(reason), (1 - withinMax) * REASON_MAX_TRANSACTION_EXCEEDED, reason);
  reason = when(isZero(reason), (1 - withinBudget) * REASON_BUDGET_EXCEEDED, reason);
  reason = when(isZero(reason), (1 - hasCapital) * REASON_INSUFFICIENT_CAPITAL, reason);
  return { allowed, reason };
}

const live = {
  amount: 10,
  maxTransaction: 100,
  budget: 1_000,
  available: 1_000,
  mandateLive: 1,
  chainAllowed: 1,
};

describe("Arcium confidential policy circuit (hermetic mirror)", () => {
  it("ALLOWs a proposal inside every bound", () => {
    const r = evaluateMandate(live);
    expect(r.allowed).toBe(1);
    expect(r.reason).toBe(REASON_OK);
  });

  describe("F43 defect 1 — is_nonzero was always true", () => {
    it("REFUSES a zero amount (the defect made this ALLOW)", () => {
      const r = evaluateMandate({ ...live, amount: 0 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_AMOUNT_INVALID);
    });
  });

  describe("boundaries", () => {
    it("ALLOWs amount exactly equal to max_transaction", () => {
      const r = evaluateMandate({ ...live, amount: 100, maxTransaction: 100 });
      expect(r.allowed).toBe(1);
      expect(r.reason).toBe(REASON_OK);
    });

    it("ALLOWs amount exactly equal to budget and to available", () => {
      const r = evaluateMandate({ ...live, amount: 1_000, maxTransaction: 5_000, budget: 1_000, available: 1_000 });
      expect(r.allowed).toBe(1);
    });

    it("REFUSES one unit over max_transaction", () => {
      const r = evaluateMandate({ ...live, amount: 101 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_MAX_TRANSACTION_EXCEEDED);
    });

    it("REFUSES over budget", () => {
      const r = evaluateMandate({ ...live, amount: 2_000, maxTransaction: 5_000, budget: 1_000, available: 10_000 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_BUDGET_EXCEEDED);
    });

    it("REFUSES when the vault cannot cover it", () => {
      const r = evaluateMandate({ ...live, amount: 200, maxTransaction: 5_000, budget: 10_000, available: 100 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_INSUFFICIENT_CAPITAL);
    });
  });

  describe("expiry", () => {
    // Expiry arrives as the pre-folded `mandate_live` flag, NOT a time
    // comparison — the client cannot pass an expired mandate in as live.
    it("REFUSES when the mandate is not live", () => {
      const r = evaluateMandate({ ...live, mandateLive: 0 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_MANDATE_NOT_LIVE);
    });

    it("REFUSES a disallowed chain", () => {
      const r = evaluateMandate({ ...live, chainAllowed: 0 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_CHAIN_NOT_ALLOWED);
    });
  });

  describe("F43 defect 2 — reason precedence and reachability", () => {
    it("a dead mandate outranks a breached max_transaction", () => {
      // The defect reported MAX_TRANSACTION_EXCEEDED here, hiding that the
      // mandate was dead — the far more fundamental failure.
      const r = evaluateMandate({ ...live, mandateLive: 0, amount: 10_000 });
      expect(r.allowed).toBe(0);
      expect(r.reason).toBe(REASON_MANDATE_NOT_LIVE);
    });

    it("a bad chain outranks a zero amount", () => {
      expect(evaluateMandate({ ...live, chainAllowed: 0, amount: 0 }).reason).toBe(REASON_CHAIN_NOT_ALLOWED);
    });

    it("a zero amount outranks an exceeded max_transaction", () => {
      expect(evaluateMandate({ ...live, amount: 0, maxTransaction: 1 }).reason).toBe(REASON_AMOUNT_INVALID);
    });

    it("max_transaction outranks budget, which outranks capital", () => {
      expect(evaluateMandate({ ...live, amount: 5_000, maxTransaction: 100, budget: 200, available: 100 }).reason)
        .toBe(REASON_MAX_TRANSACTION_EXCEEDED);
      expect(evaluateMandate({ ...live, amount: 500, maxTransaction: 5_000, budget: 200, available: 100 }).reason)
        .toBe(REASON_BUDGET_EXCEEDED);
    });

    // The trailing `when_allowed(...)` bug made every non-zero reason
    // unreachable. Assert each one is reachable, not just the first.
    it("every reason code the circuit defines is reachable", () => {
      const seen = new Set<number>([
        evaluateMandate({ ...live, mandateLive: 0 }).reason,
        evaluateMandate({ ...live, chainAllowed: 0 }).reason,
        evaluateMandate({ ...live, amount: 0 }).reason,
        evaluateMandate({ ...live, amount: 101 }).reason,
        evaluateMandate({ ...live, amount: 2_000, maxTransaction: 5_000 }).reason,
        evaluateMandate({ ...live, amount: 200, maxTransaction: 5_000, budget: 10_000, available: 100 }).reason,
        evaluateMandate(live).reason,
      ]);
      expect(seen).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    });
  });
});
