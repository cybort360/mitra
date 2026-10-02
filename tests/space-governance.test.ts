/**
 * Space governance (ADR-0011).
 *
 * The property: **no single participant can bind a Space that is not ADMIN mode,
 * and a Space cannot claim quorum while behaving like an admin.**
 *
 * These are the tests that would have caught the defect this replaces — a single
 * `owner` able to `SUSPENDED` a context other agents were party to. That is
 * "unrestricted operator control" over the commercial layer, which §3.2 excludes
 * by name.
 *
 * The single most important test here is the LAST one: a Space whose quorum is
 * one must be refused at configuration, because that is an admin wearing a
 * quorum's name, and it is the shape a centralising design drifts into.
 */
import { describe, expect, it } from "vitest";
import type { Space } from "@/lib/domain/types";
import {
  applyGovernedAction,
  decide,
  externalRulesChanged,
  isExternallyGoverned,
  validateGovernance,
} from "@/lib/kernel/space-governance";

function space(over: Partial<Space> = {}): Space {
  return {
    spaceId: "sp_1",
    owner: "buyer_1",
    governance: {
      mode: "QUORUM",
      admins: [],
      governors: ["buyer_1", "provider_1", "eval_1"],
      threshold: 2,
    },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE",
    participants: ["buyer_1", "provider_1", "eval_1"],
    allowedCapabilities: ["research"],
    settlementChains: ["solana"],
    budget: { asset: "USDC", amount: 100 },
    committed: { asset: "USDC", amount: 0 },
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const admin = space({
  governance: { mode: "ADMIN", admins: ["buyer_1"], governors: ["buyer_1", "provider_1", "eval_1"], threshold: 1 },
});

describe("QUORUM — no single party can bind the Space", () => {
  it("one governor CANNOT suspend", () => {
    expect(decide(space(), "SUSPEND", ["buyer_1"]))
      .toEqual({ ok: false, reason: "QUORUM_NOT_MET:1/2" });
  });

  it("the OWNER alone cannot suspend — the field that caused the defect", () => {
    const s = space({ owner: "buyer_1" });
    expect(decide(s, "SUSPEND", [s.owner]).ok).toBe(false);
  });

  it("two governors CAN suspend", () => {
    expect(decide(space(), "SUSPEND", ["buyer_1", "provider_1"]).ok).toBe(true);
  });

  it("the provider alone cannot suspend the buyer's Space", () => {
    expect(decide(space(), "SUSPEND", ["provider_1"]).ok).toBe(false);
  });

  it("DUPLICATE approvals do not form a quorum", () => {
    // Without deduplication, one governor submitting the same approval three
    // times would be a quorum on their own.
    expect(decide(space(), "SUSPEND", ["buyer_1", "buyer_1", "buyer_1"]).ok).toBe(false);
  });

  it("an approval from a NON-governor is invalid, not merely weak", () => {
    expect(decide(space(), "SUSPEND", ["buyer_1", "stranger_9"]))
      .toEqual({ ok: false, reason: "APPROVER_NOT_A_GOVERNOR:stranger_9" });
  });

  it("applying the action changes the status only when agreed", () => {
    const refused = applyGovernedAction(space(), "SUSPEND", ["buyer_1"]);
    expect(refused.ok).toBe(false);
    expect((refused as { space?: Space }).space).toBeUndefined();

    const agreed = applyGovernedAction(space(), "SUSPEND", ["buyer_1", "eval_1"]);
    expect(agreed.ok).toBe(true);
    expect((agreed as { space: Space }).space.status).toBe("SUSPENDED");
  });
});

describe("ADMIN — a deliberate small arrangement, not a weaker tier", () => {
  it("a single admin may bind", () => {
    expect(decide(admin, "SUSPEND", ["buyer_1"]).ok).toBe(true);
  });

  it("a NON-admin governor cannot bind alone in ADMIN mode", () => {
    expect(decide(admin, "SUSPEND", ["provider_1"]))
      .toEqual({ ok: false, reason: "ADMIN_APPROVAL_REQUIRED" });
  });

  it("ADMIN mode requires at least one admin", () => {
    expect(validateGovernance({ mode: "ADMIN", admins: [], governors: ["a", "b"], threshold: 1 }))
      .toEqual({ ok: false, reason: "ADMIN_MODE_REQUIRES_AN_ADMIN" });
  });
});

describe("a Space cannot advertise governance it does not have", () => {
  it("REFUSES a QUORUM of one — an admin wearing a quorum's name", () => {
    // THE test. This is the shape a centralising design drifts into, and honouring
    // it would let a Space appear self-governed while one party still controls it.
    expect(validateGovernance({ mode: "QUORUM", admins: [], governors: ["a", "b"], threshold: 1 }))
      .toEqual({ ok: false, reason: "QUORUM_REQUIRES_THRESHOLD_OF_AT_LEAST_TWO" });
  });

  it("REFUSES a threshold larger than the governor set", () => {
    expect(validateGovernance({ mode: "QUORUM", admins: [], governors: ["a", "b"], threshold: 3 }).ok).toBe(false);
  });

  it("REFUSES an empty governor set", () => {
    expect(validateGovernance({ mode: "QUORUM", admins: [], governors: [], threshold: 2 }))
      .toEqual({ ok: false, reason: "NO_GOVERNORS" });
  });

  it("REFUSES an admin who is not a governor — an off-ledger authority", () => {
    expect(validateGovernance({ mode: "ADMIN", admins: ["ghost"], governors: ["a", "b"], threshold: 1 }))
      .toEqual({ ok: false, reason: "ADMIN_MUST_BE_A_GOVERNOR" });
  });

  it("REFUSES a non-positive or fractional threshold", () => {
    expect(validateGovernance({ mode: "ADMIN", admins: ["a"], governors: ["a"], threshold: 0 }).ok).toBe(false);
    expect(validateGovernance({ mode: "ADMIN", admins: ["a"], governors: ["a"], threshold: 1.5 }).ok).toBe(false);
  });

  it("a Space with INVALID governance cannot act at all", () => {
    const broken = space({ governance: { mode: "QUORUM", admins: [], governors: ["a", "b"], threshold: 1 } });
    expect(decide(broken, "SUSPEND", ["a", "b"]).ok).toBe(false);
  });
});

describe("marketplace rules are referenced, not absorbed", () => {
  const external = space({
    rules: { source: "external", ruleSetRef: "erc8183:job-lifecycle:v1", digest: "sha256:rules-8183-v1" },
  });

  it("isExternallyGoverned identifies a Space bound to someone else's rules", () => {
    expect(isExternallyGoverned(external)).toBe(true);
    expect(isExternallyGoverned(space())).toBe(false);
  });

  it("DETECTS a changed external rule set rather than silently adopting it", () => {
    // Silently applying new terms would hand the marketplace unilateral power
    // over every participant - the centralisation this design removes.
    expect(externalRulesChanged(external, "sha256:rules-8183-v1")).toBe(false);
    expect(externalRulesChanged(external, "sha256:rules-8181-SURPRISE")).toBe(true);
  });

  it("a Mitra-native Space is never 'externally changed'", () => {
    expect(externalRulesChanged(space(), "anything-at-all")).toBe(false);
  });

  it("amending rules is quorum-gated like everything else", () => {
    expect(decide(external, "AMEND_RULES", ["buyer_1"]).ok).toBe(false);
    expect(decide(external, "AMEND_RULES", ["buyer_1", "provider_1"]).ok).toBe(true);
  });

  it("admitting a member is quorum-gated, not an owner action", () => {
    expect(decide(external, "ADMIT", ["buyer_1"]).ok).toBe(false);
    expect(decide(external, "ADMIT", ["buyer_1", "eval_1"]).ok).toBe(true);
  });
});
