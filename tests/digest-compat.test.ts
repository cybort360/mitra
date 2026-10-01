import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { actionDigestFor } from "@/lib/store/ids";

/**
 * The action digest's format is a compatibility surface, and this records it.
 *
 * ## Why hardcode old values
 *
 * Canonicalizing `actionDigestFor` (F11) changed every digest it produces. That
 * is invisible: no test failed, no error was raised, and outstanding
 * reservations simply stopped executing with `ACTION_DIGEST_MISMATCH`.
 *
 * An earlier version of this change asserted in a code comment that the value
 * was unchanged. It was not, and it had not been checked. So the values are
 * pinned here instead — a change to the digest format now fails the build,
 * which is the moment to decide whether existing bindings must be re-issued.
 *
 * `EXPECTED_V1` is the pre-canonicalization value. If this ever needs to move,
 * the reason belongs in `forge/FAILURES.md`, and whoever changes it has to
 * answer the question this file exists to force.
 */
const SAMPLE = {
  vaultId: "v",
  mandateId: "m",
  mandateVersion: 1,
  amount: 10,
  asset: "USDC",
  chain: "solana",
  counterparty: "c",
  capability: "cap",
};

/** sha256(JSON.stringify([...positional...])) — the original implementation. */
const V1 = "sha256:ff378e4f4645e53a440b8858f96b0eea385e0986e15e69643bb8ab225e2903be";

/** typedHash("mitra.action.v1", {...keyed...}) — the canonical implementation. */
const V2 = "sha256:c22d6a25f7646bea17928451d32600d7fbe7afd7db25872c75cc4a75466724c8";

describe("action digest format", () => {
  it("v1 is what the pre-canonicalization implementation produced", () => {
    const legacy = `sha256:${createHash("sha256").update(JSON.stringify([
      SAMPLE.vaultId, SAMPLE.mandateId, SAMPLE.mandateVersion,
      SAMPLE.amount, SAMPLE.asset, SAMPLE.chain, SAMPLE.counterparty, SAMPLE.capability,
    ])).digest("hex")}`;
    // Proves the pinned constant is a real digest of the real inputs, not a
    // number copied from the implementation and trusted.
    expect(legacy).toBe(V1);
  });

  it("currently emits v2", () => {
    expect(actionDigestFor(SAMPLE)).toBe(V2);
  });

  it("v1 and v2 differ, which is why F11 exists", () => {
    // Asserted rather than left implicit. If these ever matched, the
    // compatibility note in F11 and in ids.ts would be wrong.
    expect(V1).not.toBe(V2);
  });

  it("is stable for identical input", () => {
    expect(actionDigestFor(SAMPLE)).toBe(actionDigestFor({ ...SAMPLE }));
  });

  it("is independent of key order in the input object", () => {
    const reordered = {
      capability: "cap", counterparty: "c", chain: "solana",
      asset: "USDC", amount: 10, mandateVersion: 1, mandateId: "m", vaultId: "v",
    };
    expect(actionDigestFor(reordered)).toBe(actionDigestFor(SAMPLE));
  });
});
