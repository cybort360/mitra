import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACP_FORBIDDEN_VERBS, ACP_PERMITTED_ACTIONS, SessionKeyScopeError,
  SimulatedVirtualsTransport, VirtualsHttpTransport, assertSessionScope,
  newSessionKey, recoverDelegator, sessionDelegationTypedData, signSessionDelegation,
  type AcpAction, type SessionDelegation,
} from "@/lib/adapters/virtuals-transport";
import { VIRTUALS_RULE_SET } from "@/lib/adapters/virtuals";
import type { Hex } from "viem";

const NOW = 1_800_000_000;
const LATER = NOW + 3600;

/** A delegator (the agent's wallet) and a session key (unprivileged, separate). */
const delegator = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const session = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);

async function delegation(over: Partial<SessionDelegation> = {}): Promise<SessionDelegation> {
  const base = await signSessionDelegation({
    account: delegator,
    sessionAddress: session.address,
    allowedActions: ACP_PERMITTED_ACTIONS,
    maxSpendUsd: 25,
    expiresAt: LATER,
  });
  return { ...base, ...over };
}

/**
 * A GENUINE delegation: every field passed is **signed over**, not applied afterwards.
 *
 * The distinction is the whole reason these tests exist. Spreading overrides onto an
 * already-signed delegation breaks the signature, so `assertSessionScope` refuses at
 * `SESSION_KEY_DELEGATOR_MISMATCH` — correct, and useless for reaching the rule-digest,
 * spend-ceiling or expiry checks. An earlier version of this helper did exactly that and
 * four tests failed for reasons that had nothing to do with what they were testing.
 */
async function signDelegationWith(
  actions: readonly AcpAction[],
  over: { maxSpendUsd?: number; expiresAt?: number; ruleDigest?: string; chainId?: number } = {},
) {
  return signSessionDelegation({
    account: delegator,
    sessionAddress: session.address,
    allowedActions: actions,
    maxSpendUsd: over.maxSpendUsd ?? 25,
    expiresAt: over.expiresAt ?? LATER,
    ...(over.ruleDigest !== undefined ? { ruleDigest: over.ruleDigest } : {}),
    ...(over.chainId !== undefined ? { chainId: over.chainId } : {}),
  });
}

const scope = (d: SessionDelegation, over: Partial<Parameters<typeof assertSessionScope>[0]> = {}) =>
  assertSessionScope({ delegation: d, action: "DISCOVER", now: NOW, signerAddress: session.address, ...over });

// ── the delegation is a real signature ──────────────────────────────────────────

describe("LP-8 — a delegation is verified, not merely read", () => {
  it("recovers to the wallet that signed it", async () => {
    const d = await delegation();
    expect((await recoverDelegator(d))!.toLowerCase()).toBe(delegator.address.toLowerCase());
  });

  it("commits to the whole tuple, so no field can be edited after signing", async () => {
    const d = await delegation();
    // Each mutation must change the recovered signer or fail recovery outright. A delegation
    // that could be edited post-signature would make the entire scope mechanism theatre.
    for (const mutate of [
      (x: SessionDelegation) => ({ ...x, sessionAddress: delegator.address }),
      (x: SessionDelegation) => ({ ...x, maxSpendUsd: 1_000_000 }),
      (x: SessionDelegation) => ({ ...x, expiresAt: LATER * 10 }),
      (x: SessionDelegation) => ({ ...x, allowedActions: ["CANCEL_JOB", "RAW_SPEND"] as unknown as AcpAction[] }),
      (x: SessionDelegation) => ({ ...x, ruleDigest: "sha256:something-else" }),
    ]) {
      const recovered = await recoverDelegator(mutate(d));
      expect(recovered === null || recovered.toLowerCase() !== delegator.address.toLowerCase())
        .toBe(true);
    }
  });

  it("is order-insensitive in its action set, so a reorder cannot change meaning", async () => {
    const a = await delegation({ allowedActions: ["DISCOVER", "OPEN_JOB"] as AcpAction[] });
    const b = await delegation({ allowedActions: ["OPEN_JOB", "DISCOVER"] as AcpAction[] });
    expect(sessionDelegationTypedData(a).message.allowedActions)
      .toBe(sessionDelegationTypedData(b).message.allowedActions);
  });

  it("REFUSES a delegation whose delegator is not the signer", async () => {
    // Self-declared authority: the delegation says it was granted by wallet A and claims A
    // signed it, while carrying wallet B's signature.
    const real = await delegation();
    const forged = { ...real, delegator: privateKeyToAccount(`0x${"33".repeat(32)}` as Hex).address };
    await expect(scope(forged)).rejects.toThrow(/SESSION_KEY_DELEGATOR_MISMATCH/);
  });

  it("REFUSES a delegation with an unparseable signature", async () => {
    const d = await delegation();
    await expect(scope({ ...d, signature: "0xdeadbeef" as Hex })).rejects.toThrow(/SESSION_KEY_DELEGATION_UNVERIFIABLE/);
  });
});

// ── the allowlist ───────────────────────────────────────────────────────────────

describe("LP-8 — the action allowlist is fail-closed", () => {
  it("contains nothing that moves capital or adjudicates a dispute", () => {
    // The control is the ABSENCE of these verbs. `openJob` proposes a capped spend; it does
    // not disburse, and settlement stays on a canonical rail.
    for (const action of ACP_PERMITTED_ACTIONS) {
      expect(action, `${action} must not be a capital or dispute verb`).not.toMatch(/spend|settle|dispute|claim|withdraw|transfer|adjudicate/i);
    }
  });

  it.each(ACP_FORBIDDEN_VERBS)("REFUSES %s even when the DELEGATOR itself signed it into scope", async (verb) => {
    // The important case: the delegation is GENUINE — the agent's own wallet signed a
    // delegation listing `settle`. It is still refused, because the allowlist is checked as
    // an ENUM and not only against the delegation's list. A compromised or mistaken
    // delegator cannot widen the executable surface; only the code can.
    const d = await signDelegationWith([verb as AcpAction]);
    await expect(scope(d, { action: verb })).rejects.toThrow(/SESSION_KEY_ACTION_NOT_PERMITTED/);
  });

  it("REFUSES a FORGED delegation that widens scope, at the signature check", async () => {
    // The two refusals are different, and both are wanted. A delegation edited after signing
    // never reaches the allowlist, because it is not a delegation at all.
    const genuine = await delegation();
    const forged = { ...genuine, allowedActions: ["settle"] as unknown as AcpAction[] };
    await expect(scope(forged, { action: "settle" })).rejects.toThrow(/SESSION_KEY_DELEGATOR_MISMATCH/);
  });

  it("REFUSES an action the delegation does not list", async () => {
    const d = await signDelegationWith(["DISCOVER"]);
    await expect(scope(d, { action: "OPEN_JOB" })).rejects.toThrow(/SESSION_KEY_ACTION_NOT_DELEGATED/);
  });

  it("accepts every action that IS delegated", async () => {
    const d = await delegation();
    for (const action of ACP_PERMITTED_ACTIONS) {
      await expect(scope(d, { action })).resolves.toBeUndefined();
    }
  });
});

// ── rule-digest binding (ADR-0011) ──────────────────────────────────────────────

describe("LP-8 — the delegation is bound to the external rule set", () => {
  it("REFUSES a delegation minted under a different rule digest", async () => {
    // Without this, a delegation granted for one integration would be usable against
    // another — and ADR-0011's provenance would be lost.
    const d = await signDelegationWith(ACP_PERMITTED_ACTIONS, { ruleDigest: "sha256:other-marketplace-v1" });
    await expect(scope(d)).rejects.toThrow(/SESSION_KEY_RULE_DIGEST_MISMATCH/);
  });

  it("REFUSES when the Space runs under Mitra's own rules", async () => {
    // A Virtuals ACP session inside a Mitra-ruled Space would make Mitra the authority on
    // someone else's marketplace — the exact thing `requireExternalRules` exists to stop.
    const d = await delegation();
    await expect(scope(d, { spaceRuleDigest: "sha256:mitra-rules-v1" }))
      .rejects.toThrow(/SESSION_KEY_SPACE_RULES_MISMATCH/);
  });

  it("accepts the Space whose rules match the delegation", async () => {
    await expect(scope(await delegation(), { spaceRuleDigest: VIRTUALS_RULE_SET.digest })).resolves.toBeUndefined();
  });
});

// ── the signer is the delegated key ─────────────────────────────────────────────

describe("LP-8 — only the delegated key may sign", () => {
  it("REFUSES a signature from a key the delegation was not granted to", async () => {
    // The replay this stops: a delegation is copied and a different key is used to sign.
    const other = privateKeyToAccount(`0x${"44".repeat(32)}` as Hex);
    await expect(scope(await delegation(), { signerAddress: other.address }))
      .rejects.toThrow(/SESSION_KEY_SIGNER_NOT_DELEGATED/);
  });

  it("accepts the key it was granted to", async () => {
    await expect(scope(await delegation(), { signerAddress: session.address })).resolves.toBeUndefined();
  });
});

// ── lifetime and money ──────────────────────────────────────────────────────────

describe("LP-8 — expiry and spend bounds are checked locally", () => {
  it("REFUSES after expiry", async () => {
    const d = await delegation();
    await expect(scope(d, { now: LATER })).rejects.toThrow(/SESSION_KEY_EXPIRED/);
  });

  it("REFUSES exactly AT the expiry second, not one second later", async () => {
    // Off-by-one here either keeps a dead key alive for a second or kills a live one.
    const d = await delegation();
    await expect(scope(d, { now: LATER - 1 })).resolves.toBeUndefined();
    await expect(scope(d, { now: LATER })).rejects.toThrow(/SESSION_KEY_EXPIRED/);
  });

  it("REFUSES a bid above the delegation's ceiling, in integer micro-dollars", async () => {
    const d = await delegation();
    await expect(scope(d, { action: "OPEN_JOB", spendUsd: 25 })).resolves.toBeUndefined();
    await expect(scope(d, { action: "OPEN_JOB", spendUsd: 25.01 })).rejects.toThrow(/SESSION_KEY_SPEND_EXCEEDS_DELEGATION/);
  });

  it("REFUSES a negative spend rather than treating it as free", async () => {
    await expect(scope(await delegation(), { action: "OPEN_JOB", spendUsd: -1 }))
      .rejects.toThrow(/SESSION_KEY_NEGATIVE_SPEND/);
  });

  it("does not lose the ceiling to float noise", async () => {
    // 0.1 + 0.2 === 0.30000000000000004, so a naive comparison would refuse a bid exactly
    // at a 0.3 ceiling.
    const d = await signDelegationWith(ACP_PERMITTED_ACTIONS, { maxSpendUsd: 0.3 });
    await expect(scope(d, { action: "OPEN_JOB", spendUsd: 0.1 + 0.2 })).resolves.toBeUndefined();
  });
});

// ── refusal ordering ────────────────────────────────────────────────────────────

describe("LP-8 — a refusal names the first thing that is wrong", () => {
  it("reports an unverified delegation before anything about its contents", async () => {
    const d = await delegation();
    await expect(scope({ ...d, signature: "0xdead" as Hex }, { action: "settle", now: NOW + 10_000 }))
      .rejects.toThrow(/SESSION_KEY_DELEGATION_UNVERIFIABLE/);
  });

  it("reports a digest mismatch before an action mismatch", async () => {
    const d = await signDelegationWith(ACP_PERMITTED_ACTIONS, { ruleDigest: "sha256:other" });
    await expect(scope(d, { action: "settle" })).rejects.toThrow(/SESSION_KEY_RULE_DIGEST_MISMATCH/);
  });

  it("reports an undelegated key before an action mismatch", async () => {
    const other = privateKeyToAccount(`0x${"55".repeat(32)}` as Hex);
    await expect(scope(await delegation(), { action: "settle", signerAddress: other.address }))
      .rejects.toThrow(/SESSION_KEY_SIGNER_NOT_DELEGATED/);
  });

  it("reports an expiry before a spend overrun, for the same reason", async () => {
    const d = await delegation();
    await expect(scope(d, { action: "OPEN_JOB", now: LATER + 1, spendUsd: 10_000 }))
      .rejects.toThrow(/SESSION_KEY_EXPIRED/);
  });
});

// ── the live transport ──────────────────────────────────────────────────────────

describe("LP-8 — the live transport fails closed and re-checks on every call", () => {
  /** A live transport with an injected fetch and clock. */
  const transport = (over: Record<string, unknown> = {}, delegation?: SessionDelegation) =>
    new VirtualsHttpTransport({
      apiKey: "k",
      sessionKey: session,
      delegation: delegation ?? ({ chainId: 84532 } as SessionDelegation),
      fetchImpl: async () => new Response(JSON.stringify({ agents: [], job: { id: "j1", state: "open" } }), { status: 200 }),
      now: () => NOW,
      ...over,
    });

  it("REFUSES to construct without an API key", () => {
    expect(() => transport({ apiKey: "" })).toThrow(/UNCONFIGURED_VIRTUALS_TRANSPORT/);
  });

  it("REFUSES to construct without a delegation", () => {
    expect(() => transport({ delegation: undefined })).toThrow(/UNCONFIGURED_VIRTUALS_TRANSPORT/);
  });

  it("RE-CHECKS the clock on every call, not once at construction", async () => {
    // The failure mode session keys exist to prevent: a process that validated at startup
    // and then kept signing for its whole lifetime.
    const d = await delegation();
    let clock = NOW;
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: d,
      fetchImpl: async () => new Response(JSON.stringify({ agents: [] }), { status: 200 }),
      now: () => clock,
    });
    await expect(t.listProviders("research")).resolves.toBeDefined();
    clock = LATER + 1; // the delegation expires while the process is still running
    await expect(t.listProviders("research")).rejects.toThrow(/SESSION_KEY_EXPIRED/);
  });

  it("REFUSES a bid over the ceiling BEFORE producing a signature", async () => {
    let signed = 0;
    const d = await signDelegationWith(ACP_PERMITTED_ACTIONS, { maxSpendUsd: 10 });
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: d,
      fetchImpl: async () => { signed++; return new Response("{}", { status: 200 }); },
      now: () => NOW,
    });
    await expect(t.openJob({ providerId: "p", objective: "o", agreementId: "a", maxUsd: 50 }))
      .rejects.toThrow(/SESSION_KEY_SPEND_EXCEEDS_DELEGATION/);
    expect(signed, "no request was made at all").toBe(0);
  });

  it("REFUSES an out-of-scope verb through the transport, with no request", async () => {
    let called = 0;
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: await delegation(),
      fetchImpl: async () => { called++; return new Response("{}", { status: 200 }); },
      now: () => NOW,
    });
    await expect(t.attemptOutOfScope("claim_dispute")).rejects.toThrow(/SESSION_KEY_ACTION_NOT_PERMITTED/);
    expect(called).toBe(0);
  });

  it("retries a GET on 5xx and eventually succeeds", async () => {
    let attempts = 0;
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: await delegation(),
      fetchImpl: async () => {
        attempts++;
        return attempts < 3
          ? new Response("busy", { status: 503 })
          : new Response(JSON.stringify({ agents: [] }), { status: 200 });
      },
      now: () => NOW, maxAttempts: 3, backoffMs: 1,
    });
    await expect(t.listProviders("research")).resolves.toEqual([]);
    expect(attempts).toBe(3);
  });

  it("gives up after its attempt budget rather than retrying forever", async () => {
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: await delegation(),
      fetchImpl: async () => new Response("busy", { status: 503 }),
      now: () => NOW, maxAttempts: 2, backoffMs: 1,
    });
    await expect(t.listProviders("research")).rejects.toThrow(/ACP_UNREACHABLE/);
  });

  it("signs with the SESSION key, never the delegator's", async () => {
    // The whole point of the split: the vault-capable wallet is offline.
    let seen: string | undefined;
    const t = new VirtualsHttpTransport({
      apiKey: "k", sessionKey: session, delegation: await delegation(),
      fetchImpl: async (_u: unknown, init?: RequestInit) => {
        seen = (init?.headers as Record<string, string>)?.["X-Session-Address"];
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      },
      now: () => NOW,
    });
    await t.listProviders("research");
    expect(seen?.toLowerCase()).toBe(session.address.toLowerCase());
    expect(seen?.toLowerCase()).not.toBe(delegator.address.toLowerCase());
  });
});

// ── the simulator ───────────────────────────────────────────────────────────────

describe("LP-8 — the simulator is no more permissive than the live transport", () => {
  const sim = (d: SessionDelegation, now = () => NOW) =>
    new SimulatedVirtualsTransport({ delegation: d, sessionKey: session, now });

  it("announces itself", async () => {
    const t = sim(await delegation());
    expect(t.isSimulated).toBe(true);
    expect(t.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("performs the SAME scope check", async () => {
    // A simulator that were more permissive would be a fixture that approves actions the
    // product refuses — the most dangerous kind of test double.
    const d = await signDelegationWith(ACP_PERMITTED_ACTIONS, { maxSpendUsd: 5 });
    await expect(sim(d).openJob({ providerId: "p", objective: "o", agreementId: "a", maxUsd: 50 }))
      .rejects.toThrow(/SESSION_KEY_SPEND_EXCEEDS_DELEGATION/);
  });

  it("refuses an expired delegation", async () => {
    const d = await delegation();
    await expect(sim(d, () => LATER + 1).listProviders("research")).rejects.toThrow(/SESSION_KEY_EXPIRED/);
  });

  it("derives a STABLE job id, so a retry is visible as the same job", async () => {
    const t = sim(await delegation());
    const a = await t.openJob({ providerId: "p", objective: "o", agreementId: "ag_1", maxUsd: 1 });
    const b = await t.openJob({ providerId: "p", objective: "o", agreementId: "ag_1", maxUsd: 1 });
    expect(a.jobId).toBe(b.jobId);
  });

  it("records which actions it authorised", async () => {
    const t = sim(await delegation());
    await t.listProviders("research");
    await t.jobState("j1");
    expect(t.calls).toEqual(["DISCOVER", "QUERY_STATE"]);
  });
});

// ── keys ────────────────────────────────────────────────────────────────────────

describe("LP-8 — session keys are unprivileged and ephemeral", () => {
  it("are fresh every time and distinct from the delegator", () => {
    const a = newSessionKey();
    const b = newSessionKey();
    expect(a.address).not.toBe(b.address);
    expect(a.address.toLowerCase()).not.toBe(delegator.address.toLowerCase());
  });
});

describe("LP-8 — SessionKeyScopeError carries a machine-readable reason", () => {
  it("every refusal has a reason string, not just a message", async () => {
    try {
      await scope(await delegation(), { action: "settle" });
      expect.unreachable("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionKeyScopeError);
      expect((e as SessionKeyScopeError).reason).toBe("SESSION_KEY_ACTION_NOT_PERMITTED");
    }
  });
});

/**
 * Default client resolution (LP-8).
 *
 * The resolution is the last place a session key could escape its delegation, because it is
 * the only function that decides *which* transport a running system uses.
 */
describe("LP-8 — client resolution has three outcomes and no fourth", () => {
  const sessionHex = `0x${"22".repeat(32)}`;

  it("returns the LIVE transport when a key, a session key and a delegation are all present", async () => {
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    const client = virtualsClientFromEnv(
      { delegation: await delegation(), sessionKeyHex: sessionHex },
      { VIRTUALS_API_KEY: "k" },
    );
    expect(client?.name).toBe("virtuals-acp-http");
  });

  it("returns the SIMULATOR when the key is absent — announcing itself", async () => {
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    const client = virtualsClientFromEnv({ delegation: await delegation(), sessionKeyHex: sessionHex }, {}) as
      { isSimulated?: boolean; evidenceLevel?: string; name?: string } | undefined;
    expect(client?.name).toBe("virtuals-acp-simulated");
    expect(client?.isSimulated).toBe(true);
    expect(client?.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("returns UNDEFINED without a delegation, so the adapter raises UnconfiguredAdapterError", async () => {
    // A session key with no delegation has no scope, so there is nothing to enforce and
    // nothing honest to do with it.
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    expect(virtualsClientFromEnv({} as never, { VIRTUALS_API_KEY: "k" })).toBeUndefined();
  });

  it("returns UNDEFINED without a session key", async () => {
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    expect(virtualsClientFromEnv({ delegation: await delegation() }, { VIRTUALS_API_KEY: "k" })).toBeUndefined();
  });

  it("returns UNDEFINED for a malformed session key rather than throwing at import", async () => {
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    expect(virtualsClientFromEnv({ delegation: await delegation(), sessionKeyHex: "not-a-key" }, { VIRTUALS_API_KEY: "k" })).toBeUndefined();
  });

  it("an UNDEFINED client makes the adapter refuse, rather than no-op", async () => {
    // The end-to-end statement of why `undefined` is the right absence: the adapter's own
    // guard turns it into an error, not a silent success.
    const { virtualsClientFromEnv } = await import("@/lib/adapters/virtuals");
    const { VirtualsMarketplaceAdapter } = await import("@/lib/adapters/virtuals");
    const space = {
      spaceId: "sp", owner: "o", governance: { mode: "QUORUM" as const, admins: [], governors: ["o"], threshold: 1 },
      rules: { source: "external" as const, ruleSetRef: "virtuals:acp:v1", digest: VIRTUALS_RULE_SET.digest },
      status: "ACTIVE" as const, participants: ["o"], allowedCapabilities: ["research"],
      settlementChains: ["base" as const], budget: { asset: "USDC" as const, amount: 1 },
      committed: { asset: "USDC" as const, amount: 0 }, version: 1, createdAt: "2026-01-01T00:00:00Z",
    };
    const adapter = new VirtualsMarketplaceAdapter(virtualsClientFromEnv({} as never, {}), space);
    await expect(adapter.discover({ capability: "research" })).rejects.toThrow(/not configured/);
  });
});
