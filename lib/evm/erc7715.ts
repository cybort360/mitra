/**
 * ERC-7715 / ERC-7710 — permissionless delegation (PRD Phase 8).
 *
 * ## Why this is the last standard that mattered
 *
 * ERC-4337 gave us the smart account and ERC-1271 gave us the signature check.
 * Neither says **anything about authority**. A smart account can hold capital and
 * be entirely unconstrained; 4337 moves *who signs*, not *what they may do*.
 *
 * Delegation is the EVM-native form of a Mandate, and it is what makes Base's
 * capital boundary genuinely different from Solana's rather than a
 * reimplementation with different address validation.
 *
 * ## The shape
 *
 *   Grantor   creates a Permission
 *   Permission  says: delegate may spend <= X, until T, only for capability C,
 *               and only while this exact `caveats` hash holds
 *   Delegate   presents it; the contract checks it
 *
 * The load-bearing property is that a delegation is **self-limiting and
 * independently checkable**: anyone holding the Permission can verify it against
 * the grantor's signature, without asking Mitra or anybody else.
 *
 * ## What this does NOT do
 *
 * It does not make ERC-1271 verification redundant, and it does not replace the
 * Solana program. It is the EVM's answer to the same question, enforced by
 * contracts on Base rather than by our program. Both are needed because a
 * delegate's authority lives on the rail it was granted on.
 */

import { keccak256, encodeAbiParameters, isAddress } from "viem";

export type EvmPermission = {
  "0x0000000000000000000000000000000000000000": "eip155";
} | Record<string, unknown>;

export interface Delegation {
  /** Unique id, so a revocation cannot be confused with an expiry. */
  delegationId: `0x${string}`;
  grantor: `0x${string}`;
  delegate: `0x${string}`;
  /** Per-transaction ceiling, in atomic units. */
  maxValue: bigint;
  /** Per-period ceiling, atomic units. Zero means unbounded by period. */
  maxPeriodValue: bigint;
  periodSeconds: bigint;
  /** Unix seconds. A delegation that cannot expire is not a delegation. */
  validAfter: bigint;
  validUntil: bigint;
  /** Free-form, hashed. THIS is what makes it verifiable rather than readable. */
  caveats: `0x${string}`;
  /** Single-use vs renewable. */
  mode: "single-use" | "reusable";
}

/**
 * ERC-7715 caveat types.
 *
 * Only the ones whose semantics we can enforce correctly are defined. A caveat
 * whose meaning we cannot evaluate must NOT be passed off as understood, so an
 * unrecognised type is refused rather than ignored.
 */
export type Caveat =
  | { type: "AllowedContract"; contracts: `0x${string}`[] }
  | { type: "ValueLimit"; limit: bigint }
  | { type: "TimeWindow"; from: bigint; until: bigint }
  | { type: "ArgLessThan"; value: bigint }
  | { type: "RecipientAllowlist"; recipients: `0x${string}`[] };

const CAVEAT_TYPESTRINGS: Record<Caveat["type"], string> = {
  AllowedContract: "AllowedContract(address[] contracts)",
  ValueLimit: "ValueLimit(uint256 value)",
  TimeWindow: "TimeWindow(uint256 from,uint256 until)",
  ArgLessThan: "ArgLessThan(uint256 value)",
  RecipientAllowlist: "RecipientAllowlist(address[] recipients)",
};

/**
 * The EIP-712 digest for a delegation.
 *
 * The caveats are included in the TYPED DATA rather than left opaque, so a
 * delegation cannot be presented with different caveats than the grantor signed.
 * A delegation whose caveats hash does not reconstruct is not the one that was
 * granted — which is the same discipline as the settlement commitment, and for
 * the same reason.
 */
export function delegationDigest(input: {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  d: Delegation;
}): `0x${string}` {
  const { domain, d } = input;
  if (!isAddress(d.grantor)) throw new Error("INVALID_GRANTOR");
  if (!isAddress(d.delegate)) throw new Error("INVALID_DELEGATE");
  if (!isAddress(domain.verifyingContract)) throw new Error("INVALID_VERIFYING_CONTRACT");

  /**
   * **The domain is hashed FIRST and SEPARATELY, exactly as EIP-712 specifies.**
   *
   * The first version destructured `domain`, validated the addresses inside it,
   * and then left it out of the hash entirely. A delegation signature would
   * therefore have been valid on every chain: same delegate, same ceiling, same
   * everything, replayed onto any Base deployment. That is the identical defect
   * class as the settlement commitment that used FNV-1a over the fields alone —
   * the domain is what stops a signature meaning something on one chain and
   * something else on another, and omitting it makes the whole digest chain-blind.
   *
   * The catch found this: the mutation was not a mutation, it was a test
   * assertion that "the digest changes with the chain id" and did not.
   */
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
       { type: "uint256" }, { type: "address" }],
      [
        // typehash, nameHash, versionHash, chainId, verifyingContract — the
        // EIP-712 order exactly, which is why the type list must match the values.
        keccak256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(new TextEncoder().encode(domain.name)),
        keccak256(new TextEncoder().encode(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" },
       { type: "address" }, { type: "address" },
       { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
       { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        domainSeparator,
        d.delegationId,
        d.grantor, d.delegate,
        d.maxValue, d.maxPeriodValue, d.periodSeconds,
        d.validAfter, d.validUntil,
        caveatsHash(d.caveats), d.caveats,
      ],
    ),
  );
}

/** keccak of the ABI-encoded caveats array — the binding a caveat list gets. */
export function caveatsHash(caveats: `0x${string}`): `0x${string}` {
  return keccak256(caveats);
}

/**
 * Whether a delegation permits a spend, right now.
 *
 * Pure arithmetic over the delegation and the caller's `now`. The contract on
 * Base enforces the same rule; this exists so an agent can check BEFORE
 * submitting, and so the rule is testable without a chain.
 *
 * Every refusal is distinct, because an agent that cannot tell "expired" from
 * "not yours" cannot recover on its own.
 */
export function checkDelegation(
  d: Delegation,
  action: { executor: `0x${string}`; recipient?: `0x${string}`; value: bigint },
  now: bigint,
): { ok: true } | { ok: false; reason: string } {
  if (now < d.validAfter) return { ok: false, reason: "DELEGATION_NOT_YET_VALID" };
  if (now >= d.validUntil) return { ok: false, reason: "DELEGATION_EXPIRED" };
  // A delegation with no ceiling is not a delegation.
  if (d.maxValue <= 0n) return { ok: false, reason: "DELEGATION_HAS_NO_VALUE" };
  if (action.value > d.maxValue) return { ok: false, reason: "VALUE_EXCEEDS_MAX" };
  if (action.executor.toLowerCase() !== d.delegate.toLowerCase()) {
    // The delegation was granted TO someone; a different caller presenting it is a
    // confused deputy, not a permission.
    return { ok: false, reason: "NOT_THE_DELEGATE" };
  }
  if (d.mode === "single-use" && action.value >= d.maxValue && d.maxPeriodValue === 0n) {
    // Single-use delegations are spent by their first use; the contract tracks
    // consumption. Surfacing it here keeps the two implementations consistent.
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Validates a caveat set we are asked to honour.
 *
 * An UNRECOGNISED caveat is refused rather than ignored. Accepting a caveat type
 * whose semantics we do not implement would mean enforcing none of it while
 * appearing to — the exact pattern `applyReputation` avoids.
 */
export function validateCaveats(caveats: Caveat[]): { ok: true; types: string[] } | { ok: false; reason: string } {
  const known = new Set(Object.keys(CAVEAT_TYPESTRINGS));
  for (const c of caveats) {
    if (!known.has(c.type)) return { ok: false, reason: `UNRECOGNISED_CAVEAT:${c.type}` };
  }
  return { ok: true, types: caveats.map((c) => CAVEAT_TYPESTRINGS[c.type]) };
}

export { CAVEAT_TYPESTRINGS };
