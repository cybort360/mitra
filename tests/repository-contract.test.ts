import { describe, expect, it } from "vitest";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";

/**
 * The store contract, pinned.
 *
 * ## Why this file asserts a negative
 *
 * `lib/store/repository.ts` used to claim the in-memory `CapitalLedger`
 * "satisfies this interface, which is what allows the two to be swapped without
 * touching a route". It did not — it was missing three methods and was entirely
 * synchronous against an async signature. That false claim was the stated
 * justification for the Phase 3 design, and it is why the routes kept calling
 * `getLedger()` for so long: the docstring said the swap was free, so nobody
 * checked.
 *
 * A comment cannot prevent that from recurring, because a comment is only as
 * current as its author. This test is.
 *
 * The compile-time assertion below is the actual guard. It is deliberately the
 * kind of check that fails when the world changes rather than when someone
 * remembers to update a file: if `CapitalLedger` ever *does* satisfy the
 * interface, `LedgerSatisfiesRepository` becomes `"YES"` and the assignment to
 * `"NO"` stops compiling, forcing this decision to be revisited on purpose.
 */
type LedgerSatisfiesRepository = CapitalLedger extends import("@/lib/store/repository").EconomicRepository
  ? "YES" : "NO";

describe("store contract", () => {
  it("the in-memory ledger does NOT satisfy EconomicRepository", () => {
    // Compile-time: `const _: "NO" = ...` fails if the ledger ever does satisfy
    // it. If you are changing this to "YES", you are changing the design.
    const verdict: LedgerSatisfiesRepository = "NO";
    expect(verdict).toBe("NO");

    // Runtime: the concrete reasons, so the failure is legible without a
    // compiler error to hand.
    const missing = (["getMandate", "appendEvent", "listEvents"] as const)
      .filter((m) => typeof (new CapitalLedger() as unknown as Record<string, unknown>)[m] !== "function");
    expect(missing).toEqual(["getMandate", "appendEvent", "listEvents"]);
  });

  it("the adapter DOES satisfy EconomicRepository", () => {
    // The adapter is what makes the swap possible, and it is a compile-time
    // assertion too — the interface has no runtime representation to check
    // against, so "implements the interface" is enforced by the type checker or
    // not at all.
    const repo: import("@/lib/store/repository").EconomicRepository = new InMemoryRepository(new CapitalLedger());
    for (const method of ["getVault", "getMandate", "reserveCapital", "consumeNonce", "putReservation"] as const) {
      expect(typeof repo[method]).toBe("function");
    }
  });
});
