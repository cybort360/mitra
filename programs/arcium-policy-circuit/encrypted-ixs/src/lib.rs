//! The confidential mandate policy circuit (PRD §11).
//!
//! **What is secret and what is not.** The mandate's limits are the thing worth
//! hiding: publishing `max_transaction` on-chain tells every observer how much
//! authority an agent holds, which is exactly the "security or competitive
//! problem" §11.12 exists for. The *identifiers* — policy version, action digest,
//! vault, mandate, decision expiry, execution guard — are not secret. They are
//! the PRD's six binding fields and they travel alongside the encrypted result,
//! which is what "expose commitments and proofs sufficient to establish that a
//! decision occurred under a valid policy, while keeping sensitive policy values
//! private when possible" asks for.
//!
//! So the circuit computes ONLY the decision over secret inputs, and the client
//! binds the six public fields around it. An implementation that put the digest
//! *inside* the circuit would spend MPC cycles on values that are already public
//! on chain.
//!
//! **Why MPC and not ZK here.** §11 says "the enclave MUST NOT be the only
//! enforcement layer". MPC gives us a decision computed over inputs no single
//! node sees, while `validateExecutionBinding` re-derives independently. We need
//! a decision to be *computable*, not *provable in zero knowledge* — and the
//! Arcis comparison primitives give us exactly that.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Encrypted policy inputs. All four are secret: three are mandate/vault
    /// limits, and the action amount is itself commercially sensitive until the
    /// action executes.
    pub struct MandatePolicyInput {
        amount: u64,
        max_transaction: u64,
        budget: u64,
        available: u64,
        /// 1 when the mandate is active and unexpired, 0 otherwise. Computed from
        /// an encrypted flag rather than assumed, so an expired mandate cannot be
        /// passed in as "active" by omitting it.
        mandate_live: u64,
        /// 1 when the chain is on the mandate's approved list, else 0.
        chain_allowed: u64,
    }

    /// The decision, encrypted.
    ///
    /// `allowed` is 1 or 0. `reason` is a PRD-aligned reason code so a DENY can
    /// be attributed without revealing *which limit* was the binding one — the
    /// alternative, returning the offending threshold, would leak the very value
    /// the enclave exists to protect.
    pub struct MandatePolicyOutput {
        allowed: u64,
        reason: u64,
    }

    const REASON_OK: u64 = 0;
    const REASON_MANDATE_NOT_LIVE: u64 = 1;
    const REASON_CHAIN_NOT_ALLOWED: u64 = 2;
    const REASON_AMOUNT_INVALID: u64 = 3;
    const REASON_MAX_TRANSACTION_EXCEEDED: u64 = 4;
    const REASON_BUDGET_EXCEEDED: u64 = 5;
    const REASON_INSUFFICIENT_CAPITAL: u64 = 6;

    /// Evaluates a proposal against a *secret* mandate.
    ///
    /// Every branch executes — MPC circuit structure is fixed at compile time and
    /// cannot depend on secret data — so this is written as a chain of
    /// multiplications rather than early-return `if`s. Each `ok *= cond` zeroes the
    /// flag without branching, and the first failing reason is captured by
    /// overwriting only while the reason is still the "ok" sentinel.
    #[instruction]
    pub fn evaluate_mandate(
        input_ctxt: Enc<Shared, MandatePolicyInput>,
    ) -> Enc<Shared, MandatePolicyOutput> {
        let i = input_ctxt.to_arcis();

        // A zero amount is never valid; a nonzero amount is required to proceed.
        let amount_ok = is_nonzero(i.amount);

        // `amount <= limit` expressed as `!(amount > limit)`, since Arcis gives
        // us a secret boolean from `>`.
        let within_max = not_gt(i.amount, i.max_transaction);
        let within_budget = not_gt(i.amount, i.budget);
        let has_capital = not_gt(i.amount, i.available);

        // Live and allowed are folded in as multiplicative gates: 0 anywhere
        // forces `allowed` to 0.
        let mut allowed = i.mandate_live * i.chain_allowed;
        allowed = allowed * amount_ok;
        allowed = allowed * within_max;
        allowed = allowed * within_budget;
        allowed = allowed * has_capital;

        // Reason attribution, in PRECEDENCE order: only the FIRST failing check
        // sets the reason. `when(is_zero(reason), <failure>, reason)` writes a code
        // only while `reason` is still the OK sentinel, so a later check cannot
        // overwrite an earlier, more fundamental one.
        //
        // F43: both the ordering and the final `when_allowed` were wrong.
        //   - The original ran `when(is_zero(x), CODE, reason)` unconditionally, so
        //     a LATER failure overwrote an earlier one: a dead mandate that also
        //     breached max_transaction reported MAX_TRANSACTION_EXCEEDED.
        //   - `when_allowed(allowed, reason, REASON_AMOUNT_INVALID)` then replaced
        //     `reason` with REASON_AMOUNT_INVALID for EVERY denial, because
        //     `(1 - allowed)` is 1 whenever the decision failed. That made reasons
        //     1, 2, 4, 5 and 6 unreachable — the entire attribution mechanism the
        //     doc comment describes as the point of the circuit.
        let mut reason = REASON_OK;
        reason = when(is_zero(reason), is_zero(i.mandate_live) * REASON_MANDATE_NOT_LIVE, reason);
        reason = when(is_zero(reason), is_zero(i.chain_allowed) * REASON_CHAIN_NOT_ALLOWED, reason);
        reason = when(is_zero(reason), is_zero(amount_ok) * REASON_AMOUNT_INVALID, reason);
        reason = when(is_zero(reason), (1 - within_max) * REASON_MAX_TRANSACTION_EXCEEDED, reason);
        reason = when(is_zero(reason), (1 - within_budget) * REASON_BUDGET_EXCEEDED, reason);
        reason = when(is_zero(reason), (1 - has_capital) * REASON_INSUFFICIENT_CAPITAL, reason);

        input_ctxt.owner.from_arcis(MandatePolicyOutput { allowed, reason })
    }

    // ── helpers written without data-dependent control flow ─────────────────

    fn is_nonzero(x: u64) -> u64 {
        // F43: this was `not_gt(0, x)` with the comment "which is exactly x >= 1".
        // It is not. `not_gt(0, x)` is `!(0 > x)`, which is `x >= 0` — ALWAYS TRUE.
        //
        // So `is_nonzero(0)` returned 1 and a ZERO-AMOUNT action was ALLOWED, the
        // exact opposite of the guard two lines above it. `x != 0` is `x > 0`.
        gt(x, 0)
    }

    fn is_zero(x: u64) -> u64 {
        not_gt(x, 0)
    }

    /// `a > b` as a secret 0/1. Arcis exposes `>` on secret values directly.
    fn gt(a: u64, b: u64) -> u64 {
        if a > b { 1 } else { 0 }
    }

    /// `!(a > b)`, i.e. `a <= b`, as a secret 0/1.
    fn not_gt(a: u64, b: u64) -> u64 {
        let g = gt(a, b);
        1 - g
    }

    fn when(cond: u64, then: u64, other: u64) -> u64 {
        // cond * then + (1 - cond) * other
        cond * then + (1 - cond) * other
    }

    // `when_allowed` was REMOVED in F43. It computed
    // `allowed * reason + (1 - allowed) * fallback`, so every DENY returned the
    // fallback regardless of which check actually failed. It is kept here as a
    // note rather than deleted silently, because "the DENY reason is always
    // AMOUNT_INVALID" is exactly the kind of behaviour that looks intentional.
}
