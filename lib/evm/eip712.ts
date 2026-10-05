/**
 * EIP-712 typed structured data.
 *
 * Phase 8 requires EIP-712 and ERC-1271. Until now the Base and Tempo adapters
 * committed to a settlement with FNV-1a, which the code honestly labelled
 * "NOT signature-grade". That was correct at the time and it was the reason the
 * adapters were provisional: a digest no signer can produce and no verifier can
 * check is not a commitment, it is a checksum.
 *
 * ## Why this changes the adapters
 *
 * With EIP-712, the settlement commitment becomes a value a wallet can actually
 * SIGN. That is what makes ERC-1271 possible: the authorisation is then
 * verifiable by anyone holding the domain separator and the typed data, rather
 * than trusted because the adapter computed it.
 *
 * ## The domain separator is the security boundary
 *
 * EIP-712's own security property is that a signature is only valid for the
 * domain it was signed under. `settlingDomain()` therefore pins chain id and
 * verifying contract, and `assertExpectedDomain` refuses a signature produced
 * under a different one — the same discipline as the chain-id check the Tempo
 * adapter already had (F12/F15).
 */

import { hashTypedData, recoverTypedDataAddress, keccak256, encodeAbiParameters, isAddress } from "viem";

/** EIP-712's magic prefix. Present in every domain separator; omitting it changes the hash. */
const EIP712_DOMAIN_TYPEHASH =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

export interface SettlementDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export function settlingDomain(chainId: number, verifyingContract: `0x${string}`): SettlementDomain {
  return { name: "Mitra Settlement", version: "1", chainId, verifyingContract };
}

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "settlementId", type: "string" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "asset", type: "string" },
  ],
} as const;

/** The amount in atomic units — EIP-712 has no decimal type. */
export function toAtomic(amount: number, decimals: number): bigint {
  if (!(amount > 0)) throw new Error("NON_POSITIVE_AMOUNT");
  return BigInt(Math.round(amount * 10 ** decimals));
}

export interface TypedSettlement {
  settlementId: string;
  from: `0x${string}`;
  to: `0x${string}`;
  amountAtomic: bigint;
  asset: string;
}

/**
 * The typed-data hash a signer signs.
 *
 * Returns the full digest, not just a keccak of a string: this is the value
 * ERC-1271 will be asked about, so computing it in one place means the verifier
 * and the signer cannot drift.
 */
export function settlementDigest(domain: SettlementDomain, s: TypedSettlement): `0x${string}` {
  for (const [k, v] of Object.entries({ from: s.from, to: s.to, verifyingContract: domain.verifyingContract })) {
    if (!isAddress(v as string)) throw new Error(`INVALID_ADDRESS:${k}`);
  }
  return hashTypedData({
    domain,
    types: SETTLEMENT_TYPES,
    primaryType: "Settlement",
    message: {
      settlementId: s.settlementId,
      from: s.from,
      to: s.to,
      amount: s.amountAtomic,
      asset: s.asset,
    },
  });
}

/** Recovers the signer. Throws on a malformed signature rather than returning null. */
export async function recoverSettlementSigner(
  domain: SettlementDomain,
  s: TypedSettlement,
  signature: `0x${string}`,
): Promise<`0x${string}`> {
  return recoverTypedDataAddress({
    domain,
    types: SETTLEMENT_TYPES,
    primaryType: "Settlement",
    message: {
      settlementId: s.settlementId,
      from: s.from,
      to: s.to,
      amount: s.amountAtomic,
      asset: s.asset,
    },
    signature,
  });
}

export type DomainMismatch = { ok: true } | { ok: false; reason: string };

/**
 * Refuses a signature made under a different domain.
 *
 * Without this, a settlement signature produced for one chain (or one verifying
 * contract) verifies everywhere, because `recoverTypedDataAddress` will happily
 * recover a signer from *some* domain. The recovered address is the same person;
 * the MEANING is not. This is the check that keeps the meaning attached.
 */
export function assertExpectedDomain(
  expected: SettlementDomain,
  actual: SettlementDomain,
): DomainMismatch {
  if (expected.chainId !== actual.chainId) return { ok: false, reason: `CHAIN_ID_MISMATCH:${actual.chainId}` };
  if (expected.verifyingContract.toLowerCase() !== actual.verifyingContract.toLowerCase()) {
    return { ok: false, reason: "VERIFYING_CONTRACT_MISMATCH" };
  }
  if (expected.name !== actual.name || expected.version !== actual.version) {
    return { ok: false, reason: "DOMAIN_NAME_OR_VERSION_MISMATCH" };
  }
  return { ok: true };
}

// ── ERC-1271 ─────────────────────────────────────────────────────────────────

/** The magic value a contract wallet returns from `isValidSignature`. */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";

export type AuthorisationVerdict =
  | { ok: true; mode: "eoa" | "contract" }
  | { ok: false; reason: string };

export interface SignatureVerifier {
  /**
   * ERC-1271: does `contract` consider `signature` valid for `digest`?
   *
   * Must return the magic value. A contract that reverts, returns false, or
   * returns the wrong value is treated as INVALID — an unverifiable signature is
   * not a valid one.
   */
  isValidSignature(contract: `0x${string}`, digest: `0x${string}`, signature: `0x${string}`): Promise<string>;
}

/**
 * Verifies an authorisation from either an EOA or a contract wallet.
 *
 * The EOA path recovers the address and compares; the contract path defers to
 * ERC-1271. Both are required in practice: agent wallets are frequently smart
 * accounts (ERC-4337 / ERC-1271), and a verifier that only handles EOAs reports
 * every smart-account signature as invalid, which is a silent denial.
 */
export async function verifyAuthorisation(input: {
  digest: `0x${string}`;
  signature: `0x${string}`;
  /** The address that must have authorised. */
  expectedSigner: `0x${string}`;
  domain: SettlementDomain;
  typed: TypedSettlement;
  verifier: SignatureVerifier;
  /**
   * The domain the signature CLAIMS, when the caller knows it (e.g. read from a
   * permit or an on-chain record) and it may not be the one we require.
   *
   * Recovery alone already rejects a cross-domain signature — it recovers a
   * different address — but that failure is indistinguishable from a bad
   * signature. Checking it explicitly gives the operator the true reason, which
   * matters because a signature replay across chains is a distinct attack from a
   * malformed one.
   */
  claimedDomain?: SettlementDomain;
}): Promise<AuthorisationVerdict> {
  const { digest, signature, expectedSigner, domain, typed, verifier } = input;

  if (input.claimedDomain) {
    const d = assertExpectedDomain(domain, input.claimedDomain);
    if (!d.ok) return { ok: false, reason: d.reason };
  }

  return verifyDigestSignature({
    digest, signature, expectedSigner, verifier,
    recover: () => recoverSettlementSigner(domain, typed, signature),
  });
}

/**
 * The EOA-then-ERC-1271 check behind every Mitra authorisation, for any typed
 * data: `recover` recovers the signer of the typed data whose hash is `digest`.
 */
export async function verifyDigestSignature(input: {
  digest: `0x${string}`;
  signature: `0x${string}`;
  expectedSigner: `0x${string}`;
  recover: () => Promise<`0x${string}`>;
  verifier: SignatureVerifier;
}): Promise<AuthorisationVerdict> {
  const { digest, signature, expectedSigner, verifier } = input;

  let recovered: `0x${string}` | null = null;
  try {
    recovered = await input.recover();
  } catch {
    // Deliberately FALLS THROUGH rather than returning. A contract wallet's
    // signature is also "malformed" to ECDSA recovery — it is not 65 bytes of
    // r,s,v — so returning here made the ERC-1271 path unreachable and denied
    // every smart-account signature. That is the silent denial this function is
    // supposed to avoid: an agent using a Safe or an ERC-4337 account would have
    // been refused as malformed, with no indication the real path was never tried.
  }

  if (recovered && recovered.toLowerCase() === expectedSigner.toLowerCase()) {
    return { ok: true, mode: "eoa" };
  }

  // Not an EOA match. It may be a contract wallet signing via ERC-1271 over the
  // same digest.
  let verdict: string;
  try {
    verdict = await verifier.isValidSignature(expectedSigner, digest, signature);
  } catch {
    // A reverting verifier is INVALID, not unverified. Agent wallets revert on
    // calls they do not recognise, and reading that as valid would be the worst
    // possible failure.
    return { ok: false, reason: "ERC1271_CALL_FAILED" };
  }
  if (typeof verdict !== "string" || verdict.toLowerCase() !== ERC1271_MAGIC_VALUE) {
    // Distinguishes "the EOA recovery could not read it" from "the contract
    // considered it and said no" — different operator responses.
    return {
      ok: false,
      reason: recovered ? "ERC1271_NOT_VALID" : "MALFORMED_SIGNATURE_AND_NOT_1271",
    };
  }
  return { ok: true, mode: "contract" };
}

export { keccak256, encodeAbiParameters, hashTypedData };
