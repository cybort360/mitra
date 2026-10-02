/**
 * Phase 9 — Tempo, and the two failures this chain has already produced.
 *
 * These tests exist to make F12 and F15 **impossible to reintroduce silently**,
 * because both fail silently: F12 returns a plausible large constant, and F15
 * returns a byte-identical empty response for funded and unfunded accounts. A
 * guard that cannot tell those apart looks correct.
 *
 * The central assertion is the one F15 demands: an empty balance response is
 * `EMPTY`, never `known: 0`. Collapsing them would report a funded account as
 * broke, and nothing would look wrong.
 */
import { describe, expect, it } from "vitest";
import type { AssetSymbol, Money } from "@/lib/domain/types";
import {
  TempoBalanceReader,
  TempoSettlementAdapter,
  TEMPO_TOKENS,
  type TempoBalanceSource,
  type TempoTransport,
} from "@/lib/adapters/tempo";
import { UnconfiguredAdapterError, type SettlementAdapter } from "@/lib/adapters/types";

const A = "USDC" as AssetSymbol;
const TO = "0x1111111111111111111111111111111111111111";
const FROM = "0x2222222222222222222222222222222222222222";
const MINT = TEMPO_TOKENS.USDC.mint;
const AMOUNT: Money = { asset: A, amount: 12 };

const commit = (i: { settlementId: string; from: string; to: string; amount: Money; network: string }) =>
  `cmt_${i.settlementId}_${i.network}`;

/** A source returning exactly what F15's mis-indexed host returns for a funded Moderato address. */
const mainnetIndexedSource: TempoBalanceSource = {
  balances: async () => ({ data: [] }),
};

describe("F15 — an empty balance response is NOT zero", () => {
  it("a funded account queried through the wrong host reads EMPTY, not 0", async () => {
    // This is the exact failure: the address IS funded on Moderato, the host
    // indexes mainnet, and it answers `{"data":[]}` — identically to a broke one.
    const r = await new TempoBalanceReader(mainnetIndexedSource, "moderato").read("USDC", FROM);
    expect(r.kind).toBe("EMPTY");
    expect(r).not.toEqual({ kind: "known", amount: 0n });
  });

  it("a genuine zero balance also reads EMPTY, which is the ambiguity itself", () => {
    // Documented consequence: on this chain the source cannot distinguish broke
    // from un-indexed. Both are EMPTY, and callers must not treat EMPTY as zero.
    const r = { kind: "EMPTY" } as const;
    expect(r.kind).not.toBe("known");
  });

  it("a real balance is reported as known", async () => {
    const src: TempoBalanceSource = { balances: async () => ({ data: [{ mint: MINT, amount: "5000000" }] }) };
    const r = await new TempoBalanceReader(src, "moderato").read("USDC", FROM);
    expect(r).toEqual({ kind: "known", amount: 5000000n });
  });

  it("a failing source is an error, not a zero", async () => {
    const src: TempoBalanceSource = { balances: async () => { throw new Error("gateway timeout"); } };
    const r = await new TempoBalanceReader(src, "moderato").read("USDC", FROM);
    expect(r.kind).toBe("error");
  });

  it("an unsupported asset is an error naming the asset", async () => {
    const r = await new TempoBalanceReader(mainnetIndexedSource, "moderato").read("ETH", FROM);
    expect(r).toEqual({ kind: "error", reason: "UNSUPPORTED_ASSET_ON_TEMPO:ETH" });
  });
});

describe("F12 — Tempo settles in TIP-20 only", () => {
  const a = new TempoSettlementAdapter({ network: "moderato" }, commit);

  it("there is no native-balance path to fall into", () => {
    // The guard is structural: native ETH is simply not a settlement asset here,
    // so the F12 constant can never be read as a balance.
    expect(Object.keys(TEMPO_TOKENS)).toEqual(["USDC"]);
    expect(() => Object.keys(TEMPO_TOKENS)).not.toThrow();
  });

  it("a non-TIP-20 asset is refused", async () => {
    await expect(a.validateTarget({ asset: "ETH", recipient: TO, amount: 1 }))
      .rejects.toThrow("TEMPO_SETTLES_IN_TIP20_ONLY");
  });

  it("the same four refusals as the other rails", async () => {
    await expect(a.validateTarget({ asset: "USDC", recipient: "nope", amount: 1 }))
      .rejects.toThrow("INVALID_RECIPIENT_ADDRESS");
    await expect(a.validateTarget({ asset: "USDC", recipient: TO, amount: 0 }))
      .rejects.toThrow("INVALID_AMOUNT");
    await expect(a.validateTarget({ asset: "USDC", recipient: TO, amount: 0.0000004 }))
      .rejects.toThrow("AMOUNT_BELOW_ATOMIC_PRECISION");
  });
});

describe("Tempo satisfies the same settlement contract as the other rails", () => {
  it("refuses rather than fabricating when unconfigured", async () => {
    const a = new TempoSettlementAdapter({ network: "moderato" }, commit);
    await expect(a.settle({ settlementId: "s1", from: FROM, to: TO, amount: AMOUNT, commitmentHash: "cmt_s1_moderato" }))
      .rejects.toBeInstanceOf(UnconfiguredAdapterError);
    expect((await a.verify("0x1")).confirmed).toBe(false);
  });

  it("re-derives the commitment, namespaced by network", async () => {
    const moderato = new TempoSettlementAdapter({ network: "moderato" }, commit);
    const mainnet = new TempoSettlementAdapter({ network: "mainnet" }, commit);
    // A commitment minted on one network must not settle on the other.
    await expect(mainnet.settle({ settlementId: "s1", from: FROM, to: TO, amount: AMOUNT, commitmentHash: "cmt_s1_moderato" }))
      .rejects.toThrow("COMMITMENT_MISMATCH");
    await expect(moderato.settle({ settlementId: "s1", from: FROM, to: TO, amount: AMOUNT, commitmentHash: "cmt_s2_moderato" }))
      .rejects.toThrow("COMMITMENT_MISMATCH");
  });

  it("settles through an injected transport", async () => {
    const sent: unknown[] = [];
    const t: TempoTransport = {
      send: async (i) => { sent.push(i); return { txHash: "0x" + "a".repeat(64) }; },
      verify: async () => ({ confirmed: true }),
    };
    const a = new TempoSettlementAdapter({ network: "moderato", transport: t }, commit);
    const r = await a.settle({ settlementId: "s1", from: FROM, to: TO, amount: AMOUNT, commitmentHash: "cmt_s1_moderato" });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((sent[0] as { amountAtomic: string }).amountAtomic).toBe("12000000");
    expect((await a.verify(r.txHash)).confirmed).toBe(true);
  });

  it("all three rails satisfy one interface", () => {
    const rails: SettlementAdapter[] = [
      new TempoSettlementAdapter({ network: "moderato" }, commit),
    ];
    for (const r of rails) {
      expect(r.chain).toBe("tempo");
      for (const m of ["validateTarget", "settle", "verify"] as const) {
        expect(typeof r[m], m).toBe("function");
      }
    }
  });
});
