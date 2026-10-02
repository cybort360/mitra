/**
 * Settlement evidence — the stranger-verification gap (PRD §21.4 `getEvidence`).
 *
 * The property that matters: an evidence bundle must be **checkable**, not
 * merely well-shaped. A bundle that carries a commitment field nobody
 * re-derives is a claim with a JSON schema, and a counterparty relying on it is
 * trusting Mitra's word — which is the thing the whole capital boundary exists to
 * avoid.
 *
 * The strongest test here is the negative one: alter the settlement's AMOUNT after
 * authorisation, keep everything else, and require the bundle to be refused. A
 * verifier that only checks that the required fields are present passes that
 * bundle, and the attack is precisely a bundle that looks complete.
 */
import { describe, expect, it } from "vitest";
import {
  buildEvidenceBundle,
  observedLevel,
  verifyEvidenceBundle,
} from "@/lib/evm/evidence";
import { settlementDigest, settlingDomain } from "@/lib/evm/eip712";

const CONTRACT = "0x1111111111111111111111111111111111111111" as const;
const dom = settlingDomain(84532, CONTRACT);
const typed = {
  settlementId: "set_1",
  from: CONTRACT,
  to: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  amountAtomic: 12_000_000n,
  asset: "USDC",
};
const base = {
  evidenceId: "ev_1",
  receiptId: "rc_1",
  settlementId: "set_1",
  chain: "base-sepolia",
  typed,
  domain: dom,
};

describe("a bundle is only as good as its commitment", () => {
  it("an unconfirmed bundle verifies but is honestly DESIGN_ONLY", () => {
    const b = buildEvidenceBundle(base);
    const v = verifyEvidenceBundle(b);
    expect(v).toEqual({ ok: true, evidenceLevel: "DESIGN_ONLY" });
    expect(b.level).toBe("DESIGN_ONLY");
  });

  it("REFUSES a bundle whose amount was altered after authorisation", () => {
    // The attack: everything looks complete, and the transfer moved a different
    // amount than the one that was signed for.
    const b = buildEvidenceBundle(base);
    const tampered = { ...b, typed: { ...typed, amountAtomic: 999_999_999n } };
    expect(verifyEvidenceBundle(tampered)).toEqual({ ok: false, reason: "COMMITMENT_MISMATCH" });
  });

  it("REFUSES a bundle whose recipient was altered", () => {
    const b = buildEvidenceBundle(base);
    const tampered = {
      ...b,
      typed: { ...typed, to: "0x3333333333333333333333333333333333333333" as `0x${string}` },
    };
    expect(verifyEvidenceBundle(tampered).ok).toBe(false);
  });

  it("REFUSES a bundle whose settlementId disagrees with the typed data", () => {
    const b = buildEvidenceBundle(base);
    // Found by this test: the first verifier reconstructed the digest but never
    // compared the bundle's settlementId with the one inside the typed data, so a
    // bundle naming A could carry a valid commitment for B.
    expect(verifyEvidenceBundle({ ...b, settlementId: "set_other" }))
      .toEqual({ ok: false, reason: "SETTLEMENT_ID_MISMATCH" });
  });

  it("REFUSES a bundle with no receipt or no settlement", () => {
    const b = buildEvidenceBundle(base);
    expect(verifyEvidenceBundle({ ...b, receiptId: "" }))
      .toEqual({ ok: false, reason: "EVIDENCE_WITHOUT_RECEIPT" });
    expect(verifyEvidenceBundle({ ...b, settlementId: "" }))
      .toEqual({ ok: false, reason: "EVIDENCE_WITHOUT_SETTLEMENT" });
  });

  it("REFUSES malformed typed fields rather than hashing them", () => {
    const b = buildEvidenceBundle(base);
    const bad = { ...b, typed: { ...typed, to: "nope" as `0x${string}` } };
    expect(verifyEvidenceBundle(bad).ok).toBe(false);
    expect((verifyEvidenceBundle(bad) as { reason: string }).reason).toMatch(/MALFORMED/);
  });

  it("the commitment it stores is the real EIP-712 digest", () => {
    const b = buildEvidenceBundle(base);
    expect(b.commitment).toBe(settlementDigest(dom, typed));
    expect(b.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("confirmation upgrades the level honestly", () => {
  it("a testnet confirmation is TESTNET_PASS", () => {
    const b = buildEvidenceBundle({
      ...base,
      confirmation: { txHash: "0xabc", blockNumber: 100, observedAt: "2026-10-02T00:00:00Z" },
    });
    expect(verifyEvidenceBundle(b)).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    expect(b.level).toBe("TESTNET_PASS");
  });

  it("a mainnet confirmation is LIVE_PUBLIC_PASS", () => {
    expect(observedLevel("mainnet")).toBe("LIVE_PUBLIC_PASS");
    expect(observedLevel("base")).toBe("LIVE_PUBLIC_PASS");
    expect(observedLevel("base-sepolia")).toBe("TESTNET_PASS");
    expect(observedLevel("solana-devnet")).toBe("TESTNET_PASS");
  });

  it("REFUSES a confirmation with no hash or a zero block", () => {
    const b = buildEvidenceBundle(base);
    const noHash = { ...b, confirmation: { txHash: "", blockNumber: 5, observedAt: "t" } };
    expect(verifyEvidenceBundle(noHash)).toEqual({ ok: false, reason: "MALFORMED_CONFIRMATION" });
    const zeroBlock = { ...b, confirmation: { txHash: "0x1", blockNumber: 0, observedAt: "t" } };
    expect(verifyEvidenceBundle(zeroBlock)).toEqual({ ok: false, reason: "MALFORMED_CONFIRMATION" });
  });

  it("a tampered bundle is refused EVEN WHEN it carries a valid confirmation", () => {
    // Otherwise the confirmation would launder a tampered settlement.
    const b = buildEvidenceBundle({
      ...base,
      confirmation: { txHash: "0xabc", blockNumber: 100, observedAt: "t" },
    });
    const tampered = { ...b, typed: { ...typed, amountAtomic: 1n } };
    expect(verifyEvidenceBundle(tampered)).toEqual({ ok: false, reason: "COMMITMENT_MISMATCH" });
  });

  it("the level vocabulary is the one ADR-0008 defines", () => {
    // A first draft invented "ONCHAIN_CONFIRMED", which is not a member of
    // EvidenceLevel. tsc caught it; this pins the reason it matters.
    const levels = [observedLevel("mainnet"), observedLevel("solana-devnet"), "DESIGN_ONLY"];
    for (const l of levels) {
      expect([
        "DESIGN_ONLY", "LOCAL_PASS", "TESTNET_PASS", "LIVE_PUBLIC_PASS", "PRODUCTION_PASS",
      ]).toContain(l);
    }
  });
});
