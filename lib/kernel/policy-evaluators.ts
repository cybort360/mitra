/**
 * The two policy evaluators, and the signer abstraction (PRD Phase 3).
 *
 * Phase 3 requires three integrations: Engraving semantics, **wallet signer
 * abstraction**, and the Arcium private policy path. This file supplies the
 * second and the *public half* of the third; the Arcium implementation lands
 * behind the same interface in `policy-engine.ts`.
 */

import type { Mandate, Vault } from "@/lib/domain/types";
import type { ActionProposal, PolicyContext } from "@/lib/kernel/authorization";
import { evaluateProposal } from "@/lib/kernel/authorization";
import type {
  DecisionBinding,
  EnclaveOutput,
  PolicyEvaluator,
} from "@/lib/kernel/policy-engine";
import { bind } from "@/lib/kernel/policy-engine";

/** How long a decision stays live. Not a constant callers may override. */
const DECISION_TTL_MS = 5 * 60_000;

export interface PublicEvaluatorDeps {
  vaultId: string;
  mandateId: string;
  policyVersion: number;
}

/**
 * Today's evaluation, behind the seam.
 *
 * `confidential: false` is what allows `evaluateWithFallback` to treat its
 * failure as fatal rather than substitutable — a public evaluator that failed
 * silently would produce a decision nobody derived.
 */
export class PublicPolicyEvaluator implements PolicyEvaluator {
  readonly kind = "public" as const;
  readonly confidential = false;

  constructor(private readonly deps: PublicEvaluatorDeps) {}

  evaluate(
    mandate: Mandate,
    vault: Vault,
    proposal: ActionProposal,
    context: PolicyContext,
  ): Promise<EnclaveOutput> {
    const result = evaluateProposal(mandate, vault, proposal, context);
    const binding: Omit<DecisionBinding, "policyVersion" | "decisionExpiresAt"> = {
      actionDigest: proposal.actionDigest,
      vaultId: this.deps.vaultId,
      mandateId: this.deps.mandateId,
      executionGuardToken: guardToken(proposal.actionDigest, this.deps.mandateId),
    };
    const out = bind(result, binding, {
      policyVersion: this.deps.policyVersion,
      // Expiry is computed from the proposal's own instant, never from the wall
      // clock, so a decision is reproducible in a test. This is the same rule the
      // kernel applies to `now`.
      decisionExpiresAt: new Date(proposal.now.getTime() + DECISION_TTL_MS).toISOString(),
    });
    return Promise.resolve(out);
  }
}

/**
 * The execution-guard token.
 *
 * Deterministic in (actionDigest, mandateId) so the guard can re-derive it
 * without consulting the evaluator — which is what makes §11.10's "the enclave
 * MUST NOT be the only enforcement layer" true in practice: the guard does not
 * have to believe the enclave to check it.
 */
export function guardToken(actionDigest: string, mandateId: string): string {
  // A plain deterministic digest; no crypto dependency in a file that must run in
  // both the server and a test without extra setup.
  let h = 2166136261 >>> 0;
  const s = `${actionDigest}:${mandateId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `eg_${h.toString(16).padStart(8, "0")}`;
}

// ── wallet signer abstraction ───────────────────────────────────────────────

/**
 * What an executor needs from a wallet, and nothing more.
 *
 * The abstraction exists because the *same* economic intent must execute on
 * Solana, Base and Tempo (PRD §4.2 "one economic model, many rails"), and each
 * rail signs differently. A caller that depended on `Keypair` directly would
 * have to be rewritten per chain, and the execution guard — which is where
 * capital actually moves — would be the thing rewritten, i.e. the most
 * dangerous code in the system.
 *
 * Deliberately *not* an `AsyncSigner`: an execution must be able to be refused
 * for a policy reason before any network round trip, so `canSign` is a pure
 * local question and `sign` is the one that may go to a wallet.
 */
export interface SignerAdapter {
  /** The public key / address this signer controls. */
  readonly address: string;
  /** Which rail it can sign for. */
  readonly chain: string;
  /** Pure: can this signer authorise this action *at all*? Never I/O. */
  canSign(digest: string): { ok: boolean; reason?: string };
  /** Performs the signature. Rejects rather than throwing if `canSign` failed. */
  sign(digest: string): Promise<string>;
}

/**
 * The signer-neutral execution guard entry point.
 *
 * Two independent questions, and conflating them is the bug this signature makes
 * impossible: *is the policy satisfied* and *can this wallet sign*. A local
 * keypair answering "yes" to both must still be refused when policy says no, and
 * a policy ALLOW must not reach a wallet that cannot authorise the rail.
 */
export function mayExecute(
  decision: EnclaveOutput,
  signer: SignerAdapter,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (decision.decision !== "ALLOW") {
    return { ok: false, reason: `POLICY_${decision.decision}` };
  }
  if (new Date(decision.decisionExpiresAt) <= now) {
    return { ok: false, reason: "DECISION_EXPIRED" };
  }
  if (decision.executionGuardToken !== guardToken(decision.actionDigest, decision.mandateId)) {
    return { ok: false, reason: "GUARD_TOKEN_MISMATCH" };
  }
  const can = signer.canSign(decision.actionDigest);
  if (!can.ok) return { ok: false, reason: can.reason ?? "SIGNER_CANNOT_SIGN" };
  return { ok: true };
}
