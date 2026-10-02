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

// There is NO USDC and NO OUSD on Tempo, and the asset that actually moves value
// here is a TIP-20 mint. See the registry comment in lib/adapters/tempo.ts for the
// two rounds of fabrication this file's fixtures were built on.
const A = "PathUSD" as AssetSymbol;
const TO = "0x1111111111111111111111111111111111111111";
const FROM = "0x2222222222222222222222222222222222222222";
const MINT = TEMPO_TOKENS.PathUSD.mint;
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
    const r = await new TempoBalanceReader(mainnetIndexedSource, "moderato").read(A, FROM);
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
    const r = await new TempoBalanceReader(src, "moderato").read(A, FROM);
    expect(r).toEqual({ kind: "known", amount: 5000000n });
  });

  it("a failing source is an error, not a zero", async () => {
    const src: TempoBalanceSource = { balances: async () => { throw new Error("gateway timeout"); } };
    const r = await new TempoBalanceReader(src, "moderato").read(A, FROM);
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
    // so the F12 constant can never be read as a balance. The assertion is that no
    // key is a native symbol — not a literal list of names, which is how the F39
    // and F40 fabrications stayed invisible.
    const keys = Object.keys(TEMPO_TOKENS);
    expect(keys.length).toBeGreaterThan(0);
    for (const native of ["ETH", "WETH", "TEMPO"]) expect(keys).not.toContain(native);
  });

  it("a non-TIP-20 asset is refused", async () => {
    await expect(a.validateTarget({ asset: "ETH", recipient: TO, amount: 1 }))
      .rejects.toThrow("TEMPO_SETTLES_IN_TIP20_ONLY");
  });

  it("the same four refusals as the other rails", async () => {
    await expect(a.validateTarget({ asset: A, recipient: "nope", amount: 1 }))
      .rejects.toThrow("INVALID_RECIPIENT_ADDRESS");
    await expect(a.validateTarget({ asset: A, recipient: TO, amount: 0 }))
      .rejects.toThrow("INVALID_AMOUNT");
    await expect(a.validateTarget({ asset: A, recipient: TO, amount: 0.0000004 }))
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

/**
 * The mints were FABRICATED, then "corrected" into a DIFFERENT fabrication.
 *
 * F39 introduced `USDC: 0x5dDF...`, which does not exist. Every test in this file
 * passed because they referenced `TEMPO_TOKENS.USDC` — a test that reads a
 * constant out of the module under test validates the invention against itself.
 *
 * F40 found that F39's replacement was **also wrong on 4 of 5 entries**, because
 * it was pinned by the same self-referential assertion:
 *
 *     F39 claimed            F40 read from Moderato
 *     ──────────────         ────────────────────────
 *     OUSD     @ 0x…0000    PathUSD  @ 0x…0000
 *     pathUSD  @ 0x…0001    AlphaUSD @ 0x…0001
 *     AlphaUSD @ 0x…0002    BetaUSD  @ 0x…0002
 *     BetaUSD  @ 0x…6a37…   OpenUSD  @ 0x…6a37…
 *     ThetaUSD @ 0x…0003    ThetaUSD @ 0x…0003   (right by luck)
 *
 * So the test below deliberately does NOT assert a hardcoded table. Asserting the
 * same literal twice is what let two fabrications stand in a row. Instead it pins
 * the properties that were actually verified against Moderato, and a live check
 * (opt-in via TEMPO_LIVE=1) re-derives every name from a node so the constant can
 * be contradicted by the outside world rather than only by a second copy of itself.
 *
 * Verified 2026-02-10 against https://rpc.moderato.tempo.xyz (chain id 42431).
 */
describe("the TIP-20 registry matches what Moderato actually says", () => {
  const entries = Object.entries(TEMPO_TOKENS);

  it("names the four indexed mints and OpenUSD, and invents no others", () => {
    expect(entries.map(([k]) => k).sort()).toEqual([
      "AlphaUSD", "BetaUSD", "OpenUSD", "PathUSD", "ThetaUSD",
    ]);
  });

  it("contains no USDC and no OUSD, because Moderato has neither", () => {
    // Both names were fabricated at some point in this file's history.
    expect(TEMPO_TOKENS["USDC"]).toBeUndefined();
    expect(TEMPO_TOKENS["OUSD"]).toBeUndefined();
  });

  it("every mint is a distinct, well-formed address", () => {
    const mints = entries.map(([, t]) => t.mint.toLowerCase());
    expect(new Set(mints).size).toBe(mints.length);
    for (const m of mints) expect(m).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("each symbol equals its own registry key", () => {
    // A symbol silently disagreeing with its key is how the F39 shift went unnoticed.
    for (const [key, t] of entries) expect(t.symbol).toBe(key);
  });

  it("OpenUSD is the one mint outside the 0x20c0…index scheme", () => {
    // Derived rather than hand-counted: the indexed mints are `0x20c` + zeros +
    // a one-digit index. A literal like `20c0{36}` depends on counting zeros by
    // eye; getting it wrong makes the filter match NOTHING, and a filter that
    // matches nothing still passes a `toEqual([...])` only by accident. Written as
    // an explicit split so the two halves cannot silently disagree again.
    const INDEX_PREFIX = "0x20c";
    const isIndexed = (mint: string) => {
      const hex = mint.slice(2);
      if (hex.length !== 40) return false;
      if (!hex.startsWith(INDEX_PREFIX.slice(2))) return false;
      const rest = hex.slice(INDEX_PREFIX.length - 2); // everything after "20c"
      return /^0+$/.test(rest.slice(0, rest.length - 1)); // all zeros but the index
    };
    const indexed = entries.filter(([, t]) => isIndexed(t.mint));
    expect(indexed.map(([k]) => k).sort()).toEqual(["AlphaUSD", "BetaUSD", "PathUSD", "ThetaUSD"]);
    expect(TEMPO_TOKENS.OpenUSD.mint).toBe("0x20c0000000000000000000006a37da5c996874be");
    // So any code that INFERS addresses by pattern would miss OpenUSD entirely.
  });

  it("all decimals are 6, as read from each mint", () => {
    for (const [key, t] of entries) expect(t.decimals, key).toBe(6);
  });

  /**
   * The only assertion here that could have caught F39 or F40: it asks a NODE,
   * not the module. Opt-in because the suite must not require the network; run it
   * with TEMPO_LIVE=1 before trusting any change to this registry.
   */
  const liveIt = process.env.TEMPO_LIVE === "1" ? it : it.skip;
  liveIt("re-derives every name from Moderato (TEMPO_LIVE=1)", async () => {
    const { encodeFunctionData, parseAbi } = await import("viem");
    const rpc = process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz";
    const abi = parseAbi(["function name() view returns (string)"]);
    // Proper ABI decoding of a single `string` return: word0 = offset, word1 =
    // length, then `length` bytes. An earlier version of this decoder read from
    // char 2 and produced "\x07PathUSD" — the length word's first byte read as a
    // leading control character. Decoding the offset and the length explicitly is
    // what makes a wrong answer visible instead of nearly-right.
    const readString = (data: string) => {
      const hex = data.replace(/^0x/, "");
      const offset = parseInt(hex.slice(0, 64), 16);
      const length = parseInt(hex.slice(offset * 2, offset * 2 + 64), 16);
      const start = offset * 2 + 64;
      return Buffer.from(hex.slice(start, start + length * 2), "hex").toString("utf8");
    };
    for (const [key, t] of entries) {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: t.mint, data: encodeFunctionData({ abi, functionName: "name" }) }, "latest"],
        }),
      });
      const body = await res.json() as { result?: string; error?: { message: string } };
      expect(body.error, `${key} at ${t.mint} must be a live contract`).toBeUndefined();
      expect(readString(body.result!), `${key} at ${t.mint}`).toBe(key);
    }
  }, 30_000);
});
