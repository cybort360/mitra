import { describe, expect, it } from "vitest";
import { evaluateProposal, validateExecutionBinding } from "@/lib/kernel/authorization";
import { netObligations } from "@/lib/kernel/clearing";
import { reconcileVault, releaseReservation, reserve } from "@/lib/kernel/vault";
import { mandates, obligations, reservations, vaults } from "@/lib/store/seed";
import type { ActionProposal, PolicyContext } from "@/lib/kernel/authorization";

// Fixed clocks keep every authorization and expiry assertion deterministic.
const NOW = new Date("2026-09-30T12:00:00Z");
const BEFORE_EXPIRY = new Date("2026-09-30T17:00:00Z");
// res_run496 expires 2026-09-30T18:00Z, so this clock is genuinely past it.
const AFTER_EXPIRY = new Date("2026-09-30T19:00:00Z");

describe("vault invariants", () => {
  it("never reserves more than available", () => {
    expect(() => reserve(vaults[0], vaults[0].available + 1)).toThrow("INSUFFICIENT_AVAILABLE_CAPITAL");
  });
  it("reconciliation exposes any unmodeled capital", () => {
    const result = reconcileVault(vaults[0]);
    expect(result.difference).toBe(0);
  });
  it("rejects zero, negative and non-finite reservation amounts", () => {
    expect(() => reserve(vaults[0], 0)).toThrow("INVALID_RESERVATION_AMOUNT");
    expect(() => reserve(vaults[0], -100)).toThrow("INVALID_RESERVATION_AMOUNT");
    expect(() => reserve(vaults[0], Number.NaN)).toThrow("INVALID_RESERVATION_AMOUNT");
  });
  it("returns reserved capital to available on release", () => {
    const held = reserve(vaults[0], 500);
    expect(held.reserved).toBe(vaults[0].reserved + 500);
    const back = releaseReservation(held, { ...reservations[2], amount: 500 });
    expect(back.reserved).toBe(vaults[0].reserved);
    expect(back.available).toBe(vaults[0].available);
  });
  it("conserves total capital across reserve and release", () => {
    const back = releaseReservation(reserve(vaults[0], 1234.56), { ...reservations[2], amount: 1234.56 });
    expect(reconcileVault(back).ok).toBe(true);
  });
});

describe("authority", () => {
  const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
    amount: 5, asset: "USDC", chain: "solana", counterparty: "virtuals:research-agent-18",
    capability: "market_research", actionDigest: "sha256:abc", now: NOW, ...over,
  });

  it("rejects action tampering", () => {
    expect(validateExecutionBinding(reservations[1], "sha256:tampered", 1, "USDC", "solana", BEFORE_EXPIRY).reason).toBe("ACTION_DIGEST_MISMATCH");
  });
  it("allows a well-formed proposal against the seed mandate", () => {
    expect(evaluateProposal(mandates[0], vaults[0], proposal()).decision).toBe("ALLOW");
  });

  // --- Phase 0 regressions: each of these passed before the kernel hardening ---

  it("does not execute an expired reservation even when every other field matches", () => {
    const stale = reservations[2]; // RESERVED, expired 2026-09-30T18:00Z
    const result = validateExecutionBinding(stale, stale.actionDigest, stale.amount, stale.asset, stale.chain, AFTER_EXPIRY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("RESERVATION_EXPIRED");
  });
  it("executes the same reservation one second before it expires", () => {
    const r = reservations[2];
    const justBefore = new Date(new Date(r.expiresAt).getTime() - 1000);
    expect(validateExecutionBinding(r, r.actionDigest, r.amount, r.asset, r.chain, justBefore).ok).toBe(true);
  });
  it("denies a replayed nonce", () => {
    const r = reservations[2];
    const result = validateExecutionBinding(r, r.actionDigest, r.amount, r.asset, r.chain, BEFORE_EXPIRY, { consumedNonces: [r.nonce] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NONCE_ALREADY_CONSUMED");
  });
  it("denies non-positive amounts at the execution guard", () => {
    const r = reservations[2];
    expect(validateExecutionBinding(r, r.actionDigest, 0, r.asset, r.chain, BEFORE_EXPIRY).reason).toBe("INVALID_AMOUNT");
    expect(validateExecutionBinding(r, r.actionDigest, -5, r.asset, r.chain, BEFORE_EXPIRY).reason).toBe("INVALID_AMOUNT");
  });
  it("denies a negative amount at the policy layer", () => {
    const result = evaluateProposal(mandates[0], vaults[0], proposal({ amount: -100 }));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("INVALID_AMOUNT");
  });
  it("denies an unapproved provider", () => {
    const result = evaluateProposal(mandates[0], vaults[0], proposal({ counterparty: "evil:provider" }));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("COUNTERPARTY_NOT_ALLOWED");
  });
});

describe("velocity limit", () => {
  const mandate = mandates[0]; // velocityLimit { amount: 50, windowMinutes: 60 }
  const proposal = (amount: number) => ({
    amount, asset: "USDC", chain: "solana", counterparty: "virtuals:research-agent-18",
    capability: "market_research", actionDigest: "sha256:abc", now: NOW,
  });
  const spend = (amount: number, at: string): PolicyContext => ({ recentSpend: [{ at, amount }] });

  it("allows spend that stays under the windowed limit", () => {
    expect(evaluateProposal(mandate, vaults[0], proposal(10), spend(20, "2026-09-30T11:30:00Z")).decision).toBe("ALLOW");
  });
  it("denies a single transaction that breaches the limit outright", () => {
    expect(evaluateProposal(mandate, vaults[0], proposal(60)).reasonCodes).toContain("VELOCITY_LIMIT_EXCEEDED");
  });
  it("denies cumulative spend inside the window", () => {
    const result = evaluateProposal(mandate, vaults[0], proposal(10), spend(45, "2026-09-30T11:30:00Z"));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("VELOCITY_LIMIT_EXCEEDED");
  });
  it("ignores spend that fell out of the window", () => {
    expect(evaluateProposal(mandate, vaults[0], proposal(10), spend(45, "2026-09-30T09:00:00Z")).decision).toBe("ALLOW");
  });
  it("does not enforce a velocity limit on mandates without one", () => {
    const unlimited = { ...mandate, velocityLimit: undefined };
    // 45 + 15 = 60 would breach the 50 limit that this mandate no longer carries.
    expect(evaluateProposal(unlimited, vaults[0], proposal(15), spend(45, "2026-09-30T11:59:00Z")).decision).toBe("ALLOW");
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
  it("conserves value: net positions sum to zero", () => {
    const sum = netObligations(obligations).netPositions.reduce((s, p) => s + p.amount, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-6);
  });
  it("nets offsetting obligations to zero transfers", () => {
    const base = obligations[0];
    const mk = (id: string, debtor: string, creditor: string, amount: number) => ({
      ...base, obligationId: id, debtor, creditor, amount: { ...base.amount, amount }, status: "DUE" as const,
    });
    const result = netObligations([mk("o1", "A", "B", 100), mk("o2", "B", "A", 100)]);
    expect(result.residualTransfers).toHaveLength(0);
    expect(result.residualVolume).toBe(0);
  });
  it("reports disputed obligations as excluded rather than netting them", () => {
    const disputed = { ...obligations[0], obligationId: "disp", status: "DISPUTED" as const };
    const result = netObligations([disputed, ...obligations]);
    expect(result.excluded).toContainEqual({ obligationId: "disp", reason: "DISPUTED" });
  });
});
