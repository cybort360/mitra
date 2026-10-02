/**
 * The policy evaluation seam (PRD §11, §11.11).
 *
 * Two implementations will exist behind ONE interface:
 *
 *   PublicPolicyEvaluator  — today's `evaluateProposal`. Deterministic, local,
 *                            already covered by 165 tests.
 *   ArciumPolicyEvaluator  — the same evaluation inside an MXE enclave, so the
 *                            mandate's limits are never disclosed on-chain.
 *
 * **Why a seam rather than a branch.** PRD §11.11 requires that if the enclave is
 * unavailable, confidential-policy actions *fail closed* and "no component may
 * silently downgrade a confidential policy into an unrestricted approval." That
 * rule is only enforceable if "is this confidential?" is a property of the
 * evaluation request rather than an `if` scattered at call sites. Here it is one
 * flag on one type, and the executor cannot route around it.
 *
 * **And §11.10: "The enclave MUST NOT be the only enforcement layer."** Both
 * implementations return an `EnclaveOutput` that is bound to exactly the six
 * fields the PRD names, and `validateExecutionBinding` re-derives against them
 * independently. Swapping in Arcium changes *where* policy is computed; it does
 * not weaken the guard.
 */

import type { AuthorizationDecision, Mandate, Vault } from "@/lib/domain/types";
import type { ActionProposal, PolicyContext, PolicyResult } from "@/lib/kernel/authorization";

/**
 * PRD §11.10's binding list, as a type. An enclave output MUST carry all six.
 *
 * Written as a required-field interface rather than a checked object so that a
 * new binding cannot be added to the list in the PRD without also being added
 * here — and so an implementation cannot omit one and compile.
 */
export interface DecisionBinding {
  /** Which policy version produced this decision. */
  policyVersion: number;
  /** The action digest — ties the decision to ONE exact action. */
  actionDigest: string;
  /** The vault this decision is scoped to. */
  vaultId: string;
  /** The mandate this decision was evaluated against. */
  mandateId: string;
  /** After this instant the decision is dead, regardless of reuse. */
  decisionExpiresAt: string;
  /** Proof the execution guard re-derives against, not the decision itself. */
  executionGuardToken: string;
}

export interface EnclaveOutput extends DecisionBinding {
  decision: AuthorizationDecision;
  reasonCodes: string[];
  /** Which evaluator produced this — evidence must name its substrate. */
  evaluator: "public" | "arcium";
}

export interface PolicyEvaluator {
  /** `confidential` marks the request as MUST-fail-closed (PRD §11.11). */
  readonly kind: "public" | "arcium";
  readonly confidential: boolean;
  evaluate(
    mandate: Mandate,
    vault: Vault,
    proposal: ActionProposal,
    context: PolicyContext,
  ): Promise<EnclaveOutput>;
}

/** PRD §11.11: the enclave is down and no public fallback is defined. */
export class EnclaveUnavailableError extends Error {
  readonly code = "ENCLAVE_UNAVAILABLE";
  constructor(detail: string) {
    super(`confidential policy evaluation unavailable: ${detail}`);
    this.name = "EnclaveUnavailableError";
  }
}

/**
 * Fail-closed evaluation (PRD §11.11).
 *
 * The clause that makes this interesting is *"unless a separately defined
 * public-policy fallback exists"*. The PRD forbids a **silent** downgrade while
 * still permitting an explicitly-declared one. Those two readings are only
 * compatible if the fallback is:
 *
 *   1. passed in per-call — a property of *this* action, not a global default
 *      wired up somewhere and forgotten;
 *   2. marked on the result, so nobody can mistake a public decision for an
 *      enclave decision after the fact;
 *   3. accompanied by a reason code recording that the enclave was unavailable.
 *
 * With no fallback, a confidential evaluator that throws becomes an
 * `EnclaveUnavailableError`. With one, the decision is produced — but it is
 * labelled `evaluator: "public"` and tagged `ENCLAVE_FALLBACK_USED`. An
 * evaluation that *could not* be tagged would be the exact failure mode §11.11
 * is guarding against, because evidence would claim confidentiality that did not
 * happen.
 *
 * A cached approval is never accepted past `decisionExpiresAt`, regardless of
 * which evaluator produced it.
 */
export interface FallbackOptions {
  /** The separately-defined public-policy fallback, if this action has one. */
  fallback?: PolicyEvaluator;
}

export async function evaluateWithFallback(
  primary: PolicyEvaluator,
  proposal: ActionProposal,
  mandate: Mandate,
  vault: Vault,
  context: PolicyContext = {},
  opts: FallbackOptions = {},
): Promise<EnclaveOutput> {
  try {
    const out = await primary.evaluate(mandate, vault, proposal, context);
    return checkExpiry(out, proposal);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);

    // A public evaluator failing is a local defect, not an outage. Rewriting it
    // as ENCLAVE_UNAVAILABLE would send ops paging the wrong person, so it is
    // re-thrown untouched.
    if (!primary.confidential) throw e;

    // No separately-defined fallback -> fail closed, and say so by name.
    if (!opts.fallback) throw new EnclaveUnavailableError(detail);

    // The explicitly-declared path. The denial is not silent: it is stamped onto
    // the output so it survives to evidence.
    const out = await opts.fallback.evaluate(mandate, vault, proposal, context);
    return checkExpiry(
      {
        ...out,
        evaluator: "public",
        reasonCodes: [...out.reasonCodes, "ENCLAVE_FALLBACK_USED"],
      },
      proposal,
    );
  }
}

/**
 * An evaluator returning an expired decision is a defect in the evaluator, so it
 * is converted into a refusal rather than trusted — including in the fallback
 * path, where a stale cached approval would otherwise be spendable.
 */
function checkExpiry(out: EnclaveOutput, proposal: ActionProposal): EnclaveOutput {
  if (new Date(out.decisionExpiresAt) <= proposal.now) {
    return { ...out, decision: "DENY", reasonCodes: [...out.reasonCodes, "DECISION_EXPIRED"] };
  }
  return out;
}

/**
 * Builds a binding from a `PolicyResult`.
 *
 * Kept as a named function because the six PRD-mandated fields are easy to
 * forget one at a time, and a missing one is invisible at runtime until an
 * evidence audit asks for it.
 */
export function bind(result: PolicyResult, source: Omit<DecisionBinding, "policyVersion" | "decisionExpiresAt">, opts: { policyVersion: number; decisionExpiresAt: string }): EnclaveOutput {
  return {
    ...source,
    policyVersion: opts.policyVersion,
    decisionExpiresAt: opts.decisionExpiresAt,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    evaluator: "public",
  };
}
