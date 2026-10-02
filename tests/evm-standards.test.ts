/**
 * Phase 8 — EIP-712 typed data and ERC-1271.
 *
 * The property under test is that a settlement authorisation is now a value a
 * wallet can **sign** and anyone can **verify**, which is what replaces the FNV-1a
 * placeholder. Two failures matter more than a missed feature:
 *
 *   - a cross-domain signature must not authorise a settlement. The signer is the
 *     same person on chain A and chain B; the MEANING is not, and recovery alone
 *     makes that look like a bad signature rather than a replay.
 *   - an ERC-1271 verifier that errors, returns false, or returns the wrong magic
 *     value must be treated as INVALID. "Unverifiable" is not "valid".
 */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC1271_MAGIC_VALUE,
  assertExpectedDomain,
  recoverSettlementSigner,
  settlementDigest,
  settlingDomain,
  toAtomic,
  verifyAuthorisation,
  type SignatureVerifier,
  type TypedSettlement,
} from "@/lib/evm/eip712";

const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const dom = settlingDomain(84532, CONTRACT);
const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const typed: TypedSettlement = {
  settlementId: "set_1",
  from: CONTRACT,
  to: "0x2222222222222222222222222222222222222222",
  amountAtomic: 12_000_000n,
  asset: "USDC",
};

/** Signs the typed data under `domain`. */
async function sign(domain = dom, t: TypedSettlement = typed) {
  return alice.signTypedData({
    domain,
    types: { Settlement: [
      { name: "settlementId", type: "string" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "asset", type: "string" },
    ] },
    primaryType: "Settlement",
    message: {
      settlementId: t.settlementId, from: t.from, to: t.to,
      amount: t.amountAtomic, asset: t.asset,
    },
  });
}

const refuse: SignatureVerifier = { isValidSignature: async () => "0x" };

describe("EIP-712 — the digest is a real typed-data hash", () => {
  it("is 32 bytes", () => {
    const d = settlementDigest(dom, typed);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when any field changes", () => {
    const base = settlementDigest(dom, typed);
    expect(settlementDigest(dom, { ...typed, settlementId: "set_2" })).not.toBe(base);
    expect(settlementDigest(dom, { ...typed, to: "0x3333333333333333333333333333333333333333" })).not.toBe(base);
    expect(settlementDigest(dom, { ...typed, amountAtomic: 12_000_001n })).not.toBe(base);
    expect(settlementDigest(settlingDomain(8453, CONTRACT), typed)).not.toBe(base);
  });

  it("is order-sensitive to the domain's verifying contract", () => {
    const other = settlingDomain(84532, "0x4444444444444444444444444444444444444444");
    expect(settlementDigest(other, typed)).not.toBe(settlementDigest(dom, typed));
  });

  it("refuses a malformed address rather than hashing it", () => {
    expect(() => settlementDigest(dom, { ...typed, to: "nope" as `0x${string}` }))
      .toThrow(/INVALID_ADDRESS/);
  });

  it("atomic conversion rejects a non-positive amount", () => {
    expect(toAtomic(12, 6)).toBe(12_000_000n);
    expect(() => toAtomic(0, 6)).toThrow();
    expect(() => toAtomic(-1, 6)).toThrow();
  });
});

describe("ERC-1271 / EOA — the signer is recovered", () => {
  it("accepts a genuine signature from the expected signer", async () => {
    const sig = await sign();
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: sig,
      expectedSigner: alice.address, domain: dom, typed, verifier: refuse,
    });
    expect(v).toEqual({ ok: true, mode: "eoa" });
  });

  it("refuses a signature from the WRONG signer", async () => {
    const sig = await bob.signTypedData({
      domain: dom,
      types: { Settlement: [
        { name: "settlementId", type: "string" }, { name: "from", type: "address" },
        { name: "to", type: "address" }, { name: "amount", type: "uint256" },
        { name: "asset", type: "string" },
      ] },
      primaryType: "Settlement",
      message: { settlementId: typed.settlementId, from: typed.from, to: typed.to, amount: typed.amountAtomic, asset: typed.asset },
    });
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: sig,
      expectedSigner: alice.address, domain: dom, typed, verifier: refuse,
    });
    expect(v.ok).toBe(false);
  });

  it("refuses a malformed signature with a NAMED reason", async () => {
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: "0xdeadbeef",
      expectedSigner: alice.address, domain: dom, typed, verifier: refuse,
    });
    // Falls through to ERC-1271, which the stub refuses, so the reason is the
    // combined one. It is NOT an early "malformed" return any more.
    expect(v).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE_AND_NOT_1271" });
  });

  it("recovers the same address it was signed by", async () => {
    const sig = await sign();
    expect((await recoverSettlementSigner(dom, typed, sig)).toLowerCase())
      .toBe(alice.address.toLowerCase());
  });
});

describe("cross-domain signatures are refused as a REPLAY, not a bad signature", () => {
  it("a signature made on mainnet does not authorise on sepolia", async () => {
    // Same signer, same settlement, different chain. Recovery alone rejects it,
    // but the reason would be indistinguishable from a malformed signature.
    const sig = await sign(settlingDomain(8453, CONTRACT));
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: sig,
      expectedSigner: alice.address, domain: dom, typed, verifier: refuse,
      claimedDomain: settlingDomain(8453, CONTRACT),
    });
    expect(v).toEqual({ ok: false, reason: "CHAIN_ID_MISMATCH:8453" });
  });

  it("a signature for a different verifying contract is refused", () => {
    const r = assertExpectedDomain(dom, settlingDomain(84532, "0x4444444444444444444444444444444444444444"));
    expect(r).toEqual({ ok: false, reason: "VERIFYING_CONTRACT_MISMATCH" });
  });

  it("a matching domain passes", () => {
    expect(assertExpectedDomain(dom, settlingDomain(84532, CONTRACT))).toEqual({ ok: true });
  });
});

describe("ERC-1271 — contract wallets", () => {
  const SMART = "0x5555555555555555555555555555555555555555" as const;

  it("accepts a contract wallet returning the magic value", async () => {
    const digest = settlementDigest(dom, typed);
    const v = await verifyAuthorisation({
      digest, signature: "0xdeadbeef",
      expectedSigner: SMART, domain: dom, typed,
      verifier: { isValidSignature: async (c, d, s) => {
        expect(c).toBe(SMART);
        expect(d).toBe(digest);
        expect(s).toBe("0xdeadbeef");
        return ERC1271_MAGIC_VALUE;
      } },
    });
    expect(v).toEqual({ ok: true, mode: "contract" });
  });

  it("a verifier returning false is INVALID, not unverified", async () => {
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: "0xdeadbeef",
      expectedSigner: SMART, domain: dom, typed,
      verifier: { isValidSignature: async () => "0x" },
    });
    // Not readable as ECDSA AND refused by the contract — a distinct reason from
    // "the contract looked at it and said no".
    expect(v).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE_AND_NOT_1271" });
  });

  it("a verifier returning the WRONG magic value is INVALID", async () => {
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: "0xdeadbeef",
      expectedSigner: SMART, domain: dom, typed,
      verifier: { isValidSignature: async () => "0x1234" },
    });
    expect(v.ok).toBe(false);
    expect(v).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE_AND_NOT_1271" });
  });

  it("a verifier that REVERTS is INVALID, not a crash", async () => {
    // An agent wallet that reverts on a call must not take the whole process down,
    // and must certainly not be read as valid.
    const v = await verifyAuthorisation({
      digest: settlementDigest(dom, typed), signature: "0xdeadbeef",
      expectedSigner: SMART, domain: dom, typed,
      verifier: { isValidSignature: async () => { throw new Error("execution reverted"); } },
    });
    expect(v).toEqual({ ok: false, reason: "ERC1271_CALL_FAILED" });
  });
});
