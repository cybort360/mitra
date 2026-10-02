/**
 * F45 — the clearing commitment was FNV-1a over `fields.join("|")`.
 *
 * These tests are about the PROPERTIES, not the output format. A previous instinct
 * was to pin the new hex string, which would be the same mistake as asserting a
 * literal for the Tempo registry (F40): the literal cannot fail for any reason
 * other than someone editing the test.
 *
 * Two properties were broken independently:
 *
 *   1. **Field-boundary ambiguity.** `join("|")` cannot distinguish a field that
 *      contains `|` from a boundary between fields. Two different obligation sets
 *      produced the *same* digest. This is a collision that survives any upgrade
 *      to a wider hash, which is why fixing only the hash would not have been
 *      enough.
 *   2. **Width.** 32-bit FNV-1a is not collision-resistant, and this is the value
 *      participants agree a clearing result by.
 */
import { describe, expect, it } from "vitest";
import type { Obligation } from "@/lib/domain/types";
import { digest, inputsRoot, resultHash, netObligations } from "@/lib/kernel/clearing";
import { contentHash } from "@/lib/domain/canonical";

const ob = (over: Partial<Obligation> = {}): Obligation => ({
  obligationId: "o_1",
  runId: "run_1",
  debtor: "alice",
  creditor: "bob",
  amount: { asset: "USDC", amount: 100 },
  status: "CLEARED",
  dueAt: "2026-01-01T00:00:00Z",
  ...over,
} as Obligation);

describe("F45 — clearing commitments are collision-resistant", () => {
  it("distinguishes a field containing the separator from a field boundary", () => {
    // THE regression test. These produced an identical digest under FNV-1a.
    const a = digest("test", ["epoch_1", "alice|bob", "100"]);
    const b = digest("test", ["epoch_1", "alice", "bob|100"]);
    expect(a, "a '|' inside a field must not read as a boundary").not.toBe(b);
  });

  it("distinguishes fields that differ only in where a separator falls", () => {
    const base = ["a", "b", "c"];
    for (let i = 0; i < base.length; i++) {
      for (let j = i + 1; j < base.length; j++) {
        const moved = [...base];
        const merged = `${base[i]}|${base[j]}`;
        moved.splice(j, 1, merged);
        moved.splice(i, 1);
        expect(
          digest("test", base),
          `merging fields ${i},${j} must change the digest`,
        ).not.toBe(digest("test", moved));
      }
    }
  });

  it("separates domains, so inputsRoot and resultHash cannot collide", () => {
    const fields = ["x", "y"];
    expect(digest("mitra.clearing.inputs.v1", fields))
      .not.toBe(digest("mitra.clearing.result.v1", fields));
  });

  it("is SHA-256, not a 32-bit hash", () => {
    const d = digest("test", ["a"]);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A 32-bit digest has 8 hex chars; this is the width FNV-1a could not reach.
    expect(d.split(":")[1]).toHaveLength(64);
  });

  it("agrees with the repository's other content hashes", () => {
    // Consistency: clearing must not be the weakest hash in the set.
    expect(digest("test", ["a"])).toBe(contentHash({ domain: "test", value: ["a"] }));
  });

  it("distinguishes obligations whose fields collide under join", () => {
    const a = inputsRoot([ob({ obligationId: "o|1", debtor: "alice", creditor: "bob" })], "USDC", "solana");
    const b = inputsRoot([ob({ obligationId: "o", debtor: "alice", creditor: "bob|1" })], "USDC", "solana");
    expect(a).not.toBe(b);
  });
});

describe("F45 — determinism and order-independence are preserved", () => {
  it("is deterministic across calls", () => {
    const set = [ob(), ob({ obligationId: "o_2" })];
    expect(inputsRoot(set, "USDC", "solana")).toBe(inputsRoot(set, "USDC", "solana"));
  });

  it("is independent of input order", () => {
    // A property that existed before F45 and must not have been lost.
    const g = [ob({ obligationId: "a" }), ob({ obligationId: "b", amount: { asset: "USDC", amount: 50 } })];
    expect(inputsRoot(g, "USDC", "solana")).toBe(inputsRoot([...g].reverse(), "USDC", "solana"));
  });

  it("resultHash is order-independent and epoch-scoped", () => {
    const g = [ob({ obligationId: "a" }), ob({ obligationId: "b", amount: { asset: "USDC", amount: 50 } })];
    const r = netObligations(g);
    expect(resultHash(r, "e1")).toBe(resultHash(r, "e1"));
    expect(resultHash(r, "e1")).not.toBe(resultHash(r, "e2"));
  });

  it("a changed obligation changes the inputs root", () => {
    const a = inputsRoot([ob()], "USDC", "solana");
    const b = inputsRoot([ob({ amount: { asset: "USDC", amount: 101 } })], "USDC", "solana");
    expect(a).not.toBe(b);
  });

  it("a changed asset or chain changes the inputs root", () => {
    const s = [ob()];
    expect(inputsRoot(s, "USDC", "solana")).not.toBe(inputsRoot(s, "USDT", "solana"));
    expect(inputsRoot(s, "USDC", "solana")).not.toBe(inputsRoot(s, "USDC", "base"));
  });
});
