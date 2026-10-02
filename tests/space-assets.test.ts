/**
 * ADR-0011 open item 2 — per-Space asset resolution.
 *
 * The property: **no asset is admissible unless someone recorded that it is.**
 *
 * The previous design had `BASE_ASSETS` / `SOLANA_ASSETS` / `TEMPO_TOKENS` as
 * module constants inside each adapter, which made one deployer decide which
 * assets exist and which mint addresses are real. The dangerous property of that
 * is not the hardcoding — it is that a fallback to a constant would restore the
 * centralisation *invisibly*, with the adapter appearing configured.
 *
 * So the load-bearing test here is the LAST one: with no Space assets and no
 * external registry, resolution REFUSES. It must not fall back to anything.
 */
import { describe, expect, it } from "vitest";
import type { Space } from "@/lib/domain/types";
import { assetAdmitted, resolveAsset } from "@/lib/kernel/space-assets";

function space(over: Partial<Space> = {}): Space {
  return {
    spaceId: "sp_1",
    owner: "buyer_1",
    governance: { mode: "ADMIN", admins: ["buyer_1"], governors: ["buyer_1", "p_1"], threshold: 1 },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE",
    participants: ["buyer_1", "p_1"],
    allowedCapabilities: ["payment"],
    settlementChains: ["base"],
    budget: { asset: "USDC", amount: 100 },
    committed: { asset: "USDC", amount: 0 },
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 };

describe("an asset must be admitted by someone", () => {
  it("a Space that declares an asset resolves it, attributed to the Space", () => {
    const r = resolveAsset(space({ assets: { USDC } }), "USDC");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset.source).toBe("space");
      expect(r.asset.decimals).toBe(6);
      expect(r.asset.address).toBe(USDC.address);
    }
  });

  it("a Space with NO asset map resolves nothing", () => {
    expect(resolveAsset(space(), "USDC"))
      .toEqual({ ok: false, reason: "SPACE_HAS_NOT_ADMITTED_ASSET:USDC" });
  });

  it("a Space admitting some assets does not admit others", () => {
    const s = space({ assets: { USDC } });
    expect(assetAdmitted(s, "USDC")).toBe(true);
    expect(assetAdmitted(s, "DAI")).toBe(false);
  });
});

describe("marketplace rules govern when the Space does not", () => {
  const external = space({
    rules: { source: "external", ruleSetRef: "erc8183:job-lifecycle:v1", digest: "sha256:r1" },
  });

  it("falls back to the registry the CALLER supplied, attributed to the rule set", () => {
    const r = resolveAsset(external, "USDC", { externalRegistry: { USDC } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.asset.source).toBe("external-rules");
      expect(r.asset.ruleSetRef).toBe("erc8183:job-lifecycle:v1");
    }
  });

  it("the Space's own declaration WINS over the marketplace registry", () => {
    // A participant may be stricter than the marketplace they operate under.
    const mine = { address: "0xMyOwnToken", decimals: 18 };
    const r = resolveAsset(space({ rules: external.rules, assets: { USDC: mine } }), "USDC", {
      externalRegistry: { USDC },
    });
    expect(r.ok && r.asset.address).toBe("0xMyOwnToken");
    expect(r.ok && r.asset.source).toBe("space");
  });

  it("an external Space with NO registry supplied resolves nothing", () => {
    // The caller must supply the registry recorded AT AGREEMENT TIME. Fetching it
    // now would let the marketplace change terms between agreement and settlement.
    expect(resolveAsset(external, "USDC"))
      .toEqual({ ok: false, reason: "EXTERNAL_RULES_DO_NOT_PUBLISH:erc8183:job-lifecycle:v1:USDC" });
  });
});

describe("there is NO built-in fallback — the property that matters", () => {
  it("an unconfigured space cannot settle in the universally-known token", () => {
    // Every adapter previously had USDC hardcoded at a real mainnet address. If
    // this returns ok, the centralisation is back and nobody would notice.
    const r = resolveAsset(space(), "USDC", {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain("0x");
  });

  it("resolution never invents an address", () => {
    for (const sym of ["USDC", "USDT", "ETH", "SOL", "DAI"]) {
      const r = resolveAsset(space(), sym);
      expect(r.ok, `${sym} resolved without being admitted`).toBe(false);
    }
  });

  it("a declared asset with an implausible shape is still the Space's to decide", () => {
    // Resolution does not second-guess a Space's own declaration; the guard that
    // matters is the mint matching the AGREED record, enforced at settlement by
    // comparing against the recorded address.
    const odd = { address: "not-an-address", decimals: 0 };
    const r = resolveAsset(space({ assets: { WEIRD: odd } }), "WEIRD");
    expect(r.ok && r.asset.address).toBe("not-an-address");
  });
});
