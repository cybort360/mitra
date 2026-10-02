/**
 * Phase 3c — the public policy design and the fail-closed rule.
 *
 * The most important assertion in this file is negative: **a confidential
 * evaluation must never fall back to the public evaluator when the enclave is
 * down.** PRD §11.11 calls that a "silent downgrade ... into an unrestricted
 * approval", and it is the failure that would turn a privacy feature into a
 * bypass.
 *
 * Every test below is written so that deleting the guard it covers makes it go
 * red. F25 and F28 both came from tests that named a property and never
 * exercised it, so the standard here is: which line must change for this to fail?
 */
import { describe, expect, it, vi } from "vitest";
import type { Mandate, Vault } from "@/lib/domain/types";
import type { ActionProposal } from "@/lib/kernel/authorization";
import {
  EnclaveUnavailableError,
  evaluateWithFallback,
  type PolicyEvaluator,
  type EnclaveOutput,
} from "@/lib/kernel/policy-engine";
import { PublicPolicyEvaluator, guardToken, mayExecute } from "@/lib/kernel/policy-evaluators";

const NOW = new Date("2026-01-10T12:00:00.000Z");
/** Expiry instant for every fixture below. */
const LATER = new Date("2026-01-10T13:00:00.000Z");
/**
 * When the executor runs — strictly BEFORE `LATER`.
 *
 * The first version used `LATER` as the execution instant, which equals the
 * expiry, so every `mayExecute` returned DECISION_EXPIRED and the three tests
 * about expiry, guard tokens and signers all failed for the same wrong reason.
 * That the code reported expiry was CORRECT: `new Date(expiresAt) <= now` is
 * inclusive at the instant, the same rule the mandate tests pin. The bug was the
 * fixture, and the lesson is the familiar one — a test that fails for an
 * unrelated reason hides the property it was written to check.
 */
const EXECUTING = new Date("2026-01-10T12:30:00.000Z");

const mandate = {
  id: "mnd_1",
  agentId: "agt_1",
  status: "ACTIVE",
  asset: "USDC",
  approvedChains: ["solana"] as never,
  allowedCapabilities: ["payment"] as never,
  prohibitedCapabilities: [] as never,
  allowedCounterparties: ["counterparty_1"] as never,
  maxTransaction: 1000,
  budget: 10_000,
  expiresAt: "2027-01-01T00:00:00.000Z",
} as unknown as Mandate;

const vault = {
  id: "vlt_1",
  available: 5000,
  emergencyFreeze: false,
  frozen: 0,
  total: 5000,
} as unknown as Vault;

const proposal: ActionProposal = {
  amount: 100,
  asset: "USDC",
  chain: "solana",
  counterparty: "counterparty_1",
  capability: "payment",
  actionDigest: "digest-abc",
  now: NOW,
};

const deps = { vaultId: "vlt_1", mandateId: "mnd_1", policyVersion: 3 };

/** An evaluator that always allows — stands in for a healthy Arcium enclave. */
function enclave(up: boolean): PolicyEvaluator {
  return {
    kind: "arcium",
    confidential: true,
    evaluate: (): Promise<EnclaveOutput> => {
      if (!up) throw new Error("MPC quorum unreachable");
      return Promise.resolve({
        policyVersion: 3,
        actionDigest: "digest-abc",
        vaultId: "vlt_1",
        mandateId: "mnd_1",
        decisionExpiresAt: LATER.toISOString(),
        executionGuardToken: guardToken("digest-abc", "mnd_1"),
        decision: "ALLOW",
        reasonCodes: ["POLICY_OK"],
        evaluator: "arcium",
      });
    },
  };
}

describe("fail-closed (PRD §11.11)", () => {
  it("a down enclave REJECTS when no fallback was defined for this action", async () => {
    const publicFallback = new PublicPolicyEvaluator(deps);
    // The fallback exists in the world — it is simply not bound to THIS action.
    // Passing nothing must therefore fail closed; handing the function a public
    // evaluator out of band must not be possible, and passing an unrelated object
    // must not be treated as one.
    await expect(
      evaluateWithFallback(enclave(false), proposal, mandate, vault, {}),
    ).rejects.toBeInstanceOf(EnclaveUnavailableError);

    // A value that is not a fallback object must never be read as one.
    await expect(
      evaluateWithFallback(enclave(false), proposal, mandate, vault, {}, publicFallback as never),
    ).rejects.toBeInstanceOf(EnclaveUnavailableError);
  });

  it("an EXPLICITLY declared fallback is used, and is loudly marked", async () => {
    // PRD §11.11 permits "a separately defined public-policy fallback". The
    // requirement is that it is declared per action and unmistakable afterwards.
    const out = await evaluateWithFallback(
      enclave(false), proposal, mandate, vault, {},
      { fallback: new PublicPolicyEvaluator(deps) },
    );
    expect(out.decision).toBe("ALLOW");
    expect(out.evaluator, "must never claim to be an enclave decision").toBe("public");
    expect(out.reasonCodes).toContain("ENCLAVE_FALLBACK_USED");
  });

  it("the fallback path still honours decision expiry", async () => {
    const stale: PolicyEvaluator = {
      kind: "public",
      confidential: false,
      evaluate: () => Promise.resolve({
        policyVersion: 3,
        actionDigest: "digest-abc",
        vaultId: "vlt_1",
        mandateId: "mnd_1",
        decisionExpiresAt: NOW.toISOString(),
        executionGuardToken: guardToken("digest-abc", "mnd_1"),
        decision: "ALLOW" as const,
        reasonCodes: ["POLICY_OK"],
        evaluator: "public" as const,
      }),
    };
    const out = await evaluateWithFallback(
      enclave(false), proposal, mandate, vault, {}, { fallback: stale },
    );
    expect(out.decision).toBe("DENY");
    expect(out.reasonCodes).toContain("DECISION_EXPIRED");
  });

  it("the error is NAMED, not swallowed, so ops can tell downtime from denial", async () => {
    const e = await evaluateWithFallback(enclave(false), proposal, mandate, vault, {})
      .catch((err) => err as EnclaveUnavailableError);
    expect(e).toBeInstanceOf(EnclaveUnavailableError);
    expect((e as EnclaveUnavailableError).code).toBe("ENCLAVE_UNAVAILABLE");
    expect((e as Error).message).toMatch(/MPC quorum unreachable/);
  });

  it("a healthy enclave yields a decision, not an error", async () => {
    const out = await evaluateWithFallback(enclave(true), proposal, mandate, vault, {});
    expect(out.decision).toBe("ALLOW");
    expect(out.evaluator).toBe("arcium");
  });

  it("a public evaluator's failure is NOT converted into ENCLAVE_UNAVAILABLE", async () => {
    // Confusing the two would report a local bug as an outage, and ops would
    // page the wrong person. The reason must be preserved as thrown.
    const broken: PolicyEvaluator = {
      kind: "public",
      confidential: false,
      evaluate: () => Promise.reject(new TypeError("local bug")),
    };
    await expect(
      evaluateWithFallback(broken, proposal, mandate, vault, {}),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the six PRD §11.10 bindings are all present", () => {
  it("an output carries policy version, digest, vault, mandate, expiry, guard", async () => {
    const out = await evaluateWithFallback(
      new PublicPolicyEvaluator(deps), proposal, mandate, vault, {},
    );
    expect(out.policyVersion).toBe(3);
    expect(out.actionDigest).toBe("digest-abc");
    expect(out.vaultId).toBe("vlt_1");
    expect(out.mandateId).toBe("mnd_1");
    expect(out.decisionExpiresAt).toBe(NOW.toISOString().slice(0, 10) + "T12:05:00.000Z");
    expect(out.executionGuardToken).toBe(guardToken("digest-abc", "mnd_1"));
  });

  it("decision expiry is derived from the proposal instant, not the clock", async () => {
    // A wall-clock-derived expiry is untestable and silently different between
    // runs; the kernel's own rule is explicit time in.
    const spy = vi.spyOn(Date, "now");
    const out = await evaluateWithFallback(
      new PublicPolicyEvaluator(deps), proposal, mandate, vault, {},
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out.decisionExpiresAt).toBe("2026-01-10T12:05:00.000Z");
    spy.mockRestore();
  });

  it("an already-expired decision is DENIED even if the evaluator allowed it", async () => {
    const stale: PolicyEvaluator = {
      kind: "arcium",
      confidential: true,
      evaluate: () => Promise.resolve({
        policyVersion: 3,
        actionDigest: "digest-abc",
        vaultId: "vlt_1",
        mandateId: "mnd_1",
        decisionExpiresAt: NOW.toISOString(), // == proposal.now, so expired
        executionGuardToken: guardToken("digest-abc", "mnd_1"),
        decision: "ALLOW",
        reasonCodes: ["POLICY_OK"],
        evaluator: "arcium",
      }),
    };
    const out = await evaluateWithFallback(stale, proposal, mandate, vault, {});
    expect(out.decision).toBe("DENY");
    expect(out.reasonCodes).toContain("DECISION_EXPIRED");
  });
});

describe("wallet signer abstraction — two independent questions", () => {
  const allowed = {
    policyVersion: 3,
    actionDigest: "digest-abc",
    vaultId: "vlt_1",
    mandateId: "mnd_1",
    decisionExpiresAt: LATER.toISOString(),
    executionGuardToken: guardToken("digest-abc", "mnd_1"),
    decision: "ALLOW" as const,
    reasonCodes: ["POLICY_OK"],
    evaluator: "public" as const,
  };

  const signer = {
    address: "0xabc",
    chain: "base",
    canSign: (d: string) => ({ ok: d === "digest-abc" }),
    sign: (d: string) => Promise.resolve(`sig:${d}`),
  };

  it("policy DENY is refused even for a signer that can sign", async () => {
    const denied = { ...allowed, decision: "DENY" as const };
    // The whole point of the split: a wallet saying "yes" must not override
    // policy saying "no".
    expect(mayExecute(denied, signer, EXECUTING)).toEqual({ ok: false, reason: "POLICY_DENY" });
  });

  it("an expired decision is refused for a capable signer", () => {
    expect(mayExecute({ ...allowed, decisionExpiresAt: NOW.toISOString() }, signer, EXECUTING))
      .toEqual({ ok: false, reason: "DECISION_EXPIRED" });
  });

  it("a tampered guard token is refused", () => {
    expect(mayExecute({ ...allowed, executionGuardToken: "eg_forged" }, signer, EXECUTING))
      .toEqual({ ok: false, reason: "GUARD_TOKEN_MISMATCH" });
  });

  it("a signer that cannot authorise the rail is refused despite policy ALLOW", () => {
    const wrong = { ...signer, canSign: () => ({ ok: false, reason: "WRONG_CHAIN" }) };
    expect(mayExecute(allowed, wrong, EXECUTING)).toEqual({ ok: false, reason: "WRONG_CHAIN" });
  });

  it("all four refusals are distinguishable", () => {
    const results = [
      mayExecute({ ...allowed, decision: "DENY" as const }, signer, EXECUTING),
      mayExecute({ ...allowed, decisionExpiresAt: NOW.toISOString() }, signer, EXECUTING),
      mayExecute({ ...allowed, executionGuardToken: "eg_forged" }, signer, EXECUTING),
      mayExecute(allowed, { ...signer, canSign: () => ({ ok: false }) }, EXECUTING),
    ];
    const reasons = results.map((r) => (r.ok ? "OK" : r.reason));
    expect(new Set(reasons).size).toBe(4);
  });
});
