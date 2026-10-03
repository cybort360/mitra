/**
 * ERC-8004 — onchain agent identity, reputation and validation registries
 * (PRD Phase 5 "ERC-8004 adapter", Phase 8 "ERC-8004 identity").
 *
 * Mitra's `Agent` already exists. The question this module answers is what an
 * ERC-8004 registry entry must carry for a Mitra agent to be *discoverable by
 * outsiders* without Mitra becoming the authority on who an agent is.
 *
 * ## The trust direction matters
 *
 * This is a **projection outward**, not an authority inward. Mitra does not read
 * an ERC-8004 registry and accept its verdict — a third-party registry that can
 * mint an agent into existence would be a way around onboarding entirely. So:
 *
 *   - outbound: a Mitra agent projects to a registry entry, carrying evidence
 *   - inbound: an external reference is RECORDED as `ExternalIdentityRef` and is
 *     never treated as proof of identity on its own
 *
 * ## Reputation is claimed, never imported
 *
 * A registry's reputation score is a claim by whoever wrote it. `applyReputation`
 * records the claim with its source and does NOT let it become a Mitra
 * authorization input. If registry reputation could raise a spending limit, an
 * attacker would buy a high score and spend against it — turning the registry
 * into an unaudited credit system, which §3.2 explicitly refuses ("not a
 * generalized credit rating system").
 */

import type { Agent, ExternalIdentityRef } from "@/lib/domain/types";

export interface Erc8004Registration {
  agentId: string;
  /** The chain the registry lives on. */
  registryChain: string;
  registryAddress: string;
  /** Opaque token/agent id within that registry. */
  tokenId: string;
  services: string[];
  /** Claims are attributed, not adopted. */
  claimedReputation?: number;
  claimedMetadataUri?: string;
}

export type RegistrationResult =
  | { ok: true; registration: Erc8004Registration }
  | { ok: false; reason: string };

/**
 * Projects a Mitra agent outward.
 *
 * Refuses an agent with no services: a registry entry that advertises nothing
 * is a discoverability dead end, and publishing one wastes a lookup for every
 * consumer that finds it.
 */
export function toErc8004Registration(
  agent: Agent,
  registry: { chain: string; address: string; tokenId: string },
): RegistrationResult {
  const services = (agent.capabilities ?? []).slice().sort();
  if (!services.length) return { ok: false, reason: "AGENT_HAS_NO_SERVICES" };
  if (!registry.tokenId) return { ok: false, reason: "REGISTRY_TOKEN_ID_REQUIRED" };
  return {
    ok: true,
    registration: {
      agentId: agent.agentId,
      registryChain: registry.chain,
      registryAddress: registry.address,
      tokenId: registry.tokenId,
      services,
    },
  };
}

/**
 * Records an external reference WITHOUT treating it as identity.
 *
 * The returned `ExternalIdentityRef` is a pointer for display and correlation.
 * Nothing in the authorization path may read it as an assertion about who the
 * agent is — that is the whole reason this function is separate from
 * `toErc8004Registration`.
 */
export function recordExternalRef(
  agentId: string,
  reg: Erc8004Registration,
): ExternalIdentityRef {
  return {
    system: `erc8004:${reg.registryChain}`,
    id: reg.tokenId,
  };
}

export interface ReputationClaim {
  agentId: string;
  registryAddress: string;
  score: number;
  observedAt: string;
}

/**
 * Stores a reputation claim, attributed.
 *
 * Returns the claim rather than mutating the agent: a claim is evidence about
 * what a registry said, not a fact about the agent. Anything that wanted to
 * convert this into a spending limit would be reintroducing a credit system,
 * which §3.2 refuses.
 */
export function applyReputation(claims: ReputationClaim[], claim: ReputationClaim): ReputationClaim[] {
  if (!(claim.score >= 0)) throw new Error("REPUTATION_SCORE_MUST_BE_NON_NEGATIVE");
  return [...claims.filter((c) => c.registryAddress !== claim.registryAddress), claim];
}

/**
 * The only thing a registry may influence: **discovery ranking**, never authority.
 *
 * Returns an ordering, not a decision. Sorting by claimed score changes who is
 * listed first; it cannot change what any agent is permitted to do.
 */
export function rankForDiscovery(
  candidates: Array<{ registration: Erc8004Registration; claimedReputation?: number }>,
): Erc8004Registration[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.claimedReputation ?? 0) - (a.c.claimedReputation ?? 0) || a.i - b.i)
    .map((x) => x.c.registration);
}

/**
 * Resolves an external reference to an internal agent, or refuses.
 *
 * ## F47 — `docs/SECURITY.md`
 *
 * > External identities cannot be silently remapped to another wallet/agent record.
 *
 * `recordExternalRef` records a `{system, id}` pointer and nothing more, which is
 * correct as far as it goes. But nothing stopped an agent from *carrying* a different
 * agent's reference: `marketplaceRefs` is a plain array, so `[...refs, otherAgentsRef]`
 * type-checks and the record then reads as though both references were this agent's.
 * A silent remap looks exactly like a legitimate second identity until something
 * checks.
 *
 * Two guards, because they catch different mistakes:
 *
 * 1. **One owner per (system, id).** Two agents claiming the same external identity
 *    is the remap in its most damaging form — an agent inherits another agent's
 *    reputation, mandates or obligations.
 * 2. **An agent cannot silently gain a ref it did not declare.** `mergeRefs` takes the
 *    set a caller is entitled to add and rejects anything already bound elsewhere.
 *
 * `system` is compared case-sensitively and exactly: normalising would let
 * `ERC8004:base` and `erc8004:base` be treated as one identity, which is a remap by
 * another name.
 */
type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface IdentityBinding {
  agentId: string;
  refs: ExternalIdentityRef[];
}

/** Fails with the specific collision, naming both agents so the fix is obvious. */
export function assertNoIdentityRemap(
  bindings: readonly IdentityBinding[],
  candidateAgentId: string,
  candidateRefs: readonly ExternalIdentityRef[],
): Result<true> {
  for (const ref of candidateRefs) {
    for (const b of bindings) {
      if (b.agentId === candidateAgentId) continue;
      const clash = b.refs.some((r) => r.system === ref.system && r.id === ref.id);
      if (clash) {
        return {
          ok: false,
          reason: `IDENTITY_REMAPPED:${ref.system}/${ref.id} is bound to ${b.agentId}`,
        };
      }
    }
  }
  return { ok: true, value: true };
}

/** Adds refs to an agent's set, refusing any that belong to another agent. */
export function mergeRefs(
  bindings: readonly IdentityBinding[],
  agentId: string,
  incoming: readonly ExternalIdentityRef[],
): Result<ExternalIdentityRef[]> {
  const guard = assertNoIdentityRemap(bindings, agentId, incoming);
  if (!guard.ok) return guard;
  const existing = bindings.find((b) => b.agentId === agentId)?.refs ?? [];
  // De-duplicated within the agent too: the same ref twice is not two identities,
  // and carrying it twice would make a set-equality check meaningless.
  const merged: ExternalIdentityRef[] = [];
  for (const r of [...existing, ...incoming]) {
    if (!merged.some((m) => m.system === r.system && m.id === r.id)) merged.push(r);
  }
  return { ok: true, value: merged };
}
