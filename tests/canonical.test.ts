import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, chainHash, contentHash, routeCommitment, typedHash } from "@/lib/domain/canonical";

/**
 * Canonical serialization, pinned.
 *
 * These are not tests of hashing. `sha256` does not need testing. What needs
 * testing is the *canonical form* fed into it, because that is the part a future
 * edit breaks quietly: change how a number is serialized and every existing
 * receipt hash silently becomes unverifiable, with no error anywhere.
 *
 * The float cases matter most. `0.1 + 0.2 !== 0.3` in IEEE 754, and money is
 * denominated in values like that, so an implementation that hashes raw numbers
 * produces a different digest for the same economic amount.
 */
describe("canonical serialization", () => {
  it("is independent of key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    // Nested, because the bug only appears at depth in practice.
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe(canonicalize({ z: { x: 2, y: 1 } }));
  });

  it("preserves array order", () => {
    // The deliberate asymmetry: objects are unordered, arrays are not. Sorting
    // arrays would make two different instructions hash identically.
    expect(canonicalize(["a", "b"])).not.toBe(canonicalize(["b", "a"]));
  });

  it("treats 1 and 1.0 as the same number", () => {
    expect(canonicalize({ n: 1 })).toBe(canonicalize({ n: 1.0 }));
  });

  it("treats 0.1 and 0.10 as the same amount", () => {
    // The case JSON.stringify gets wrong, and the reason money needs a
    // fixed-scale decimal rather than a raw float.
    expect(canonicalize({ amount: 0.1 })).toBe(canonicalize({ amount: 0.10 }));
  });

  it("does not let float error split one amount into two hashes", () => {
    // 0.1 + 0.2 === 0.30000000000000004. An implementation hashing raw floats
    // gives this a different digest from 0.3, so the same money hashes two ways.
    expect(canonicalize(0.1 + 0.2)).toBe(canonicalize(0.3));
  });

  it("distinguishes amounts that genuinely differ", () => {
    // The counterpart to the above: the fix must not collapse real differences.
    expect(canonicalize(0.1)).not.toBe(canonicalize(0.11));
    expect(canonicalize(1)).not.toBe(canonicalize(2));
  });

  it("refuses non-finite numbers instead of inventing a representation", () => {
    // NaN and Infinity have no stable cross-runtime form. Emitting one would
    // produce a hash that differs on another machine, which is worse than
    // refusing.
    expect(() => canonicalize(NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/);
  });

  it("drops undefined rather than emitting it", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("distinguishes null from absent", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it("serializes dates as ISO strings", () => {
    const d = new Date("2026-10-01T12:00:00.000Z");
    expect(canonicalize({ at: d })).toBe(canonicalize({ at: "2026-10-01T12:00:00.000Z" }));
  });

  it("handles an empty object and array", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });
});

describe("content hashing", () => {
  it("is stable across key order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("changes when any execution-relevant field changes", () => {
    // One field at a time, because a digest that ignores a field is worse than no
    // digest: it looks like a binding and binds nothing.
    const base = { vaultId: "v1", amount: 10, asset: "USDC", chain: "solana" };
    for (const [field, value] of [
      ["vaultId", "v2"], ["amount", 11], ["asset", "EURC"], ["chain", "base"],
    ] as const) {
      expect(contentHash({ ...base, [field]: value })).not.toBe(contentHash(base));
    }
  });

  it("separates domains so two uses cannot collide", () => {
    // Same payload, different domain, different hash — otherwise a receipt
    // payload hash and an action digest over identical bytes would be
    // interchangeable, and a caller could replay one as the other.
    expect(typedHash("domain.a", { x: 1 })).not.toBe(typedHash("domain.b", { x: 1 }));
  });
});

describe("receipt chaining (PRD §17.3)", () => {
  const receipt = (n: number) => ({ receiptId: `r${n}`, result: "SETTLED", amount: 10 });

  it("links each receipt to its predecessor", () => {
    const first = chainHash(null, receipt(1));
    const second = chainHash(first, receipt(2));
    expect(first).not.toBe(second);
  });

  it("changes the whole chain when any earlier receipt is altered", () => {
    // The property that makes the chain tamper-evident: altering receipt 1
    // changes every subsequent link, so a mismatch is detectable at the first
    // divergence rather than only at the end.
    const honest = chainHash(chainHash(null, receipt(1)), receipt(2));
    const tampered = chainHash(chainHash(null, { ...receipt(1), amount: 999 }), receipt(2));
    expect(tampered).not.toBe(honest);
  });

  it("gives a genesis receipt a null predecessor, not an empty string", () => {
    // `null` and `""` are different values, and conflating them would let a
    // chain's first link be forged as "the first link of any chain".
    expect(chainHash(null, receipt(1))).not.toBe(chainHash("", receipt(1)));
  });

  it("cannot be unlinked by reordering", () => {
    const a = chainHash(null, receipt(1));
    const b = chainHash(a, receipt(2));
    const forged = chainHash(b, receipt(1));
    expect(forged).not.toBe(a);
  });
});

/**
 * F81 — the two rails must commit to the SAME 32 bytes.
 *
 * `routeCommitment` (domain, added with F76) and `routeHashFor` (Solana rail) were
 * independent implementations that produced different values for the same route. Both
 * are 32 bytes and both contracts only check non-zero, so nothing on chain noticed;
 * the disagreement only became real when LP-6 needed to hand one value to both rails.
 */
describe("F81 — one commitment definition for both rails", () => {
  const route = "evm:refundEscrow:baseSepolia:0xabc:0xdef";

  it("is 32 bytes and 0x-prefixed, so it fits bytes32 and a PDA field", () => {
    const c = routeCommitment(route);
    expect(c).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Buffer.from(c.slice(2), "hex")).toHaveLength(32);
  });

  it("is domain-separated, so the same route cannot collide with another purpose", () => {
    // The prefix is load-bearing. Dropping it makes a route commitment byte-identical
    // to a bare hash of the same string, which is the collision `typedHash` prevents.
    expect(routeCommitment(route)).not.toBe(
      `0x${createHash("sha256").update(route, "utf8").digest("hex")}`,
    );
    expect(routeCommitment(route)).toBe(
      `0x${createHash("sha256").update(`mitra-recovery-route-v1:${route}`, "utf8").digest("hex")}`,
    );
  });

  it("agrees with the Solana rail's helper, byte for byte", async () => {
    const { routeHashFor } = await import("@/lib/solana/vault-program");
    expect(routeHashFor(route).toString("hex")).toBe(routeCommitment(route).slice(2));
  });

  it("a caller cannot smuggle in an all-zero commitment", () => {
    expect(routeCommitment(route)).not.toBe(`0x${"0".repeat(64)}`);
  });
});
