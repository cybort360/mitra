import { describe, expect, it } from "vitest";
import { evaluateProposal, validateExecutionBinding } from "@/lib/kernel/authorization";
import { netObligations } from "@/lib/kernel/clearing";
import { reconcileVault, reserve } from "@/lib/kernel/vault";
import { mandates, obligations, reservations, vaults } from "@/lib/store/seed";

describe("vault invariants", () => {
  it("never reserves more than available", () => {
    expect(() => reserve(vaults[0], vaults[0].available + 1)).toThrow("INSUFFICIENT_AVAILABLE_CAPITAL");
  });
  it("reconciliation exposes any unmodeled capital", () => {
    const result = reconcileVault(vaults[0]);
    expect(result.difference).toBe(0);
  });
});

describe("authority", () => {
  it("rejects action tampering", () => {
    expect(validateExecutionBinding(reservations[1], "sha256:tampered", 1, "USDC", "solana").reason).toBe("ACTION_DIGEST_MISMATCH");
  });
  it("denies unapproved provider", () => {
    const result = evaluateProposal(mandates[0], vaults[0], { amount: 5, asset: "USDC", chain: "solana", counterparty: "evil:provider", capability: "market_research", actionDigest: "x", now: new Date("2026-09-30T10:00:00Z") });
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("COUNTERPARTY_NOT_ALLOWED");
  });
});

describe("clearing", () => {
  it("net residual never exceeds gross included obligations", () => {
    const result = netObligations(obligations.map(o => ({...o, status: o.status === "SETTLED" ? "DUE" as const : o.status})));
    expect(result.residualVolume).toBeLessThanOrEqual(result.grossVolume);
  });
  it("is deterministic", () => {
    const a = netObligations(obligations);
    const b = netObligations([...obligations].reverse());
    expect(a.netPositions).toEqual(b.netPositions);
    expect(a.residualVolume).toEqual(b.residualVolume);
  });
});
