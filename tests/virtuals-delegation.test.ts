/**
 * ADR-0011 open item 5 — ERC-7715 delegation and the Virtuals adapter.
 *
 * ## The two properties
 *
 * **ERC-7715:** a delegation is self-limiting and independently checkable. Anyone
 * holding it can verify it against the grantor's signature without asking Mitra —
 * which is what makes it the EVM's answer to a Mandate rather than a feature
 * that only our system understands.
 *
 * **Virtuals:** the adapter operates UNDER the marketplace's rule set and does not
 * adjudicate. It discovers, it opens jobs, it maps states — and it refuses. The
 * dangerous failure here is an adapter that *decides*: filtering providers,
 * ranking them, or coercing an unrecognised marketplace state into a Mitra
 * verdict. Each of those makes Mitra the authority on someone else's marketplace.
 */
import { describe, expect, it } from "vitest";
import type { Space } from "@/lib/domain/types";
import {
  caveatsHash,
  checkDelegation,
  delegationDigest,
  validateCaveats,
  type Delegation,
} from "@/lib/evm/erc7715";
import {
  UnconfiguredAdapterError,
} from "@/lib/adapters/types";
import { VirtualsMarketplaceAdapter, VIRTUALS_RULE_SET } from "@/lib/adapters/virtuals";

const NOW = 1_000_000n;
const GRANTOR = "0x1111111111111111111111111111111111111111" as const;
const DELEGATE = "0x2222222222222222222222222222222222222222" as const;
const STRANGER = "0x3333333333333333333333333333333333333333" as const;

function delegation(over: Partial<Delegation> = {}): Delegation {
  return {
    delegationId: `0x${"11".repeat(32)}` as `0x${string}`,
    grantor: GRANTOR,
    delegate: DELEGATE,
    maxValue: 1_000_000n,
    maxPeriodValue: 5_000_000n,
    periodSeconds: 86_400n,
    validAfter: NOW - 100n,
    validUntil: NOW + 10_000n,
    caveats: caveatsHash("0x1234" as `0x${string}`),
    mode: "reusable",
    ...over,
  };
}

describe("ERC-7715 — the delegation bounds itself", () => {
  it("permits a spend inside the ceiling", () => {
    expect(checkDelegation(delegation(), { executor: DELEGATE, value: 999_999n }, NOW)).toEqual({ ok: true });
  });

  it("REFUSES above the per-transaction ceiling", () => {
    expect(checkDelegation(delegation(), { executor: DELEGATE, value: 1_000_001n }, NOW))
      .toEqual({ ok: false, reason: "VALUE_EXCEEDS_MAX" });
  });

  it("REFUSES before it is valid", () => {
    const d = delegation({ validAfter: NOW + 500n });
    expect(checkDelegation(d, { executor: DELEGATE, value: 1n }, NOW))
      .toEqual({ ok: false, reason: "DELEGATION_NOT_YET_VALID" });
  });

  it("REFUSES at expiry — expiry is inclusive at the instant", () => {
    const d = delegation({ validUntil: NOW });
    expect(checkDelegation(d, { executor: DELEGATE, value: 1n }, NOW))
      .toEqual({ ok: false, reason: "DELEGATION_EXPIRED" });
  });

  it("REFUSES a delegation with NO ceiling", () => {
    // A delegation with no limit is a blank cheque, which is not a delegation.
    expect(checkDelegation(delegation({ maxValue: 0n }), { executor: DELEGATE, value: 1n }, NOW))
      .toEqual({ ok: false, reason: "DELEGATION_HAS_NO_VALUE" });
  });

  it("REFUSES a different caller presenting it — a confused deputy", () => {
    // The delegation was granted TO the delegate. A stranger presenting it is not a
    // permission, it is someone else using a permit that is not theirs.
    expect(checkDelegation(delegation(), { executor: STRANGER, value: 1n }, NOW))
      .toEqual({ ok: false, reason: "NOT_THE_DELEGATE" });
  });

  it("an EXPIRED delegation is refused even for its rightful delegate", () => {
    const d = delegation({ validUntil: NOW - 1n });
    expect(checkDelegation(d, { executor: DELEGATE, value: 1n }, NOW).ok).toBe(false);
  });
});

describe("ERC-7715 — the caveats are inside the signed data", () => {
  const domain = { name: "Mitra", version: "1", chainId: 84532, verifyingContract: GRANTOR };

  it("the digest is 32 bytes and changes with every field", () => {
    const base = delegationDigest({ domain, d: delegation() });
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    expect(delegationDigest({ domain, d: delegation({ maxValue: 2n }) })).not.toBe(base);
    expect(delegationDigest({ domain, d: delegation({ delegate: STRANGER }) })).not.toBe(base);
    expect(delegationDigest({ domain: { ...domain, chainId: 1 }, d: delegation() })).not.toBe(base);
  });

  it("REFUSES to hash a malformed grantor or delegate", () => {
    expect(() => delegationDigest({ domain, d: delegation({ grantor: "nope" as never }) }))
      .toThrow(/INVALID_GRANTOR/);
    expect(() => delegationDigest({ domain, d: delegation({ delegate: "nope" as never }) }))
      .toThrow(/INVALID_DELEGATE/);
  });

  it("REFUSES an unrecognised caveat rather than ignoring it", () => {
    // Accepting a caveat type whose semantics we do not implement would mean
    // enforcing none of it while appearing to.
    expect(validateCaveats([{ type: "SomethingWeDoNotUnderstand" } as never]))
      .toEqual({ ok: false, reason: "UNRECOGNISED_CAVEAT:SomethingWeDoNotUnderstand" });
  });

  it("accepts and names the caveats it CAN enforce", () => {
    const r = validateCaveats([
      { type: "AllowedContract", contracts: [GRANTOR] },
      { type: "ValueLimit", limit: 500n },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.types).toHaveLength(2);
  });
});

function externalSpace(over: Partial<Space> = {}): Space {
  return {
    spaceId: "sp_virt",
    owner: "buyer_1",
    governance: { mode: "QUORUM", admins: [], governors: ["buyer_1", "provider_1"], threshold: 2 },
    rules: { source: "external", ruleSetRef: VIRTUALS_RULE_SET.ref, digest: VIRTUALS_RULE_SET.digest },
    status: "ACTIVE",
    participants: ["buyer_1", "provider_1"],
    allowedCapabilities: ["research"],
    settlementChains: ["base"],
    assets: { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } },
    budget: { asset: "USDC", amount: 100 },
    committed: { asset: "USDC", amount: 0 },
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("Virtuals operates UNDER the marketplace's rules", () => {
  const client = {
    listProviders: async () => [
      { id: "p1", name: "Acme Research", capabilities: ["research"], priceUsd: 12 },
      { id: "p2", name: "Other Lab", capabilities: ["research"] },
    ],
    openJob: async (i: { providerId: string }) => ({ jobId: `job_${i.providerId}`, state: "open" }),
    jobState: async () => ({ state: "running", artifacts: ["ipfs://a"] }),
    cancelJob: async () => {},
  };

  it("REFUSES to run under MITRA's own rules", () => {
    const mitra = externalSpace({ rules: { source: "mitra", digest: "mitra-rules-v1" } });
    const a = new VirtualsMarketplaceAdapter(client, mitra);
    // The centralisation ADR-0011 exists to prevent, stated as an error message.
    return expect(a.discover({ capability: "research" })).rejects.toThrow(/ADAPTER_REQUIRES_EXTERNAL_RULES/);
  });

  it("discovers providers AS THE MARKETPLACE LISTS THEM", async () => {
    const a = new VirtualsMarketplaceAdapter(client, externalSpace());
    const found = await a.discover({ capability: "research" });
    // No filtering, no shortlist, no local ranking.
    expect(found).toHaveLength(2);
    expect(found.map((p) => p.externalId)).toEqual(["virtuals:p1", "virtuals:p2"]);
    expect(found[0].settlementNetworks).toEqual(["base"]);
  });

  it("REFUSES to price a job in an asset the Space has not admitted", async () => {
    const noAssets = externalSpace({ assets: {} });
    const a = new VirtualsMarketplaceAdapter(client, noAssets);
    return expect(a.createJob({ providerId: "p1", objective: "o", agreementId: "ag_1", maxUsd: 10 }))
      .rejects.toThrow(/MARKETPLACE_JOB_ASSET_NOT_ADMITTED/);
  });

  it("opens a job in the MARKETPLACE's lifecycle", async () => {
    const a = new VirtualsMarketplaceAdapter(client, externalSpace());
    const j = await a.createJob({ providerId: "p1", objective: "o", agreementId: "ag_1", maxUsd: 10 });
    expect(j).toEqual({ externalJobId: "job_p1", state: "open" });
  });

  it("THROWS rather than returning fixtures when unconfigured", async () => {
    const a = new VirtualsMarketplaceAdapter(undefined, externalSpace());
    // A marketplace adapter that invents providers is worse than none: the
    // discovery result is what a principal relies on.
    await expect(a.discover({ capability: "research" })).rejects.toBeInstanceOf(UnconfiguredAdapterError);
  });

  it("maps KNOWN marketplace states and refuses to guess at unknown ones", () => {
    expect(VirtualsMarketplaceAdapter.toAgreementStatus("running")).toBe("EXECUTING");
    expect(VirtualsMarketplaceAdapter.toAgreementStatus("completed")).toBe("ACCEPTED");
    // An unrecognised state must never be coerced into REJECTED: that is a
    // decision Mitra is not entitled to make about someone else's marketplace.
    expect(VirtualsMarketplaceAdapter.toAgreementStatus("some-new-state")).toBeNull();
  });

  it("never claims evidence it did not observe", () => {
    const a = new VirtualsMarketplaceAdapter(client, externalSpace());
    expect(a.evidenceFor(false)).toBe("DESIGN_ONLY");
    expect(a.evidenceFor(true)).toBe("TESTNET_PASS");
  });
});
