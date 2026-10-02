/**
 * Phase 8 — settlement adapters and the interchangeability claim.
 *
 * Exit condition: *"Same economic intent executes on Base through the common
 * API."*
 *
 * That is a claim about two implementations being interchangeable behind one
 * interface, so it is tested as such: the SAME settlement intent is driven through
 * both adapters and must produce the same outcome class, the same refusal
 * vocabulary, and the same commitment discipline. One adapter proves nothing.
 *
 * **The refusal-to-fabricate property is asserted first because it is the one
 * that matters.** An adapter with no transport must throw, not return a
 * plausible-looking hash. F22 and F24 both came from code that looked live
 * because it produced convincing values.
 */
import { describe, expect, it } from "vitest";
import type { AssetSymbol } from "@/lib/domain/types";
import {
  BaseSettlementAdapter,
  settlementCommitment,
  type BaseChainId,
  type BaseTransport,
} from "@/lib/adapters/base";
import {
  SolanaSettlementAdapter,
  solanaCommitment,
  type SolanaTransport,
} from "@/lib/adapters/solana";
import { UnconfiguredAdapterError, type SettlementAdapter } from "@/lib/adapters/types";

const CHAIN: BaseChainId = 84532;
const EVM_TO = "0x1111111111111111111111111111111111111111";
const EVM_FROM = "0x2222222222222222222222222222222222222222";
const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_FROM = "6dNVEJhTGbLUpFZ8YVhMZ3UhYZcV6rKzWJp1Yq9GY8yW";

const AMOUNT = { asset: "USDC" as AssetSymbol, amount: 12 };

function baseCommitment(settlementId: string, from = EVM_FROM, to = EVM_TO) {
  return settlementCommitment({
    settlementId, from, to, amount: AMOUNT.amount.toString(), asset: AMOUNT.asset, chainId: CHAIN,
  });
}
function solCommitment(settlementId: string) {
  return solanaCommitment({ settlementId, from: SOL_FROM, to: SOL_TO, amount: AMOUNT });
}

const intent = (settlementId: string, from: string, to: string, commitmentHash: string) =>
  ({ settlementId, from, to, amount: AMOUNT, commitmentHash });

describe("an unconfigured adapter refuses rather than fabricating", () => {
  it("Base throws UnconfiguredAdapterError without a transport", async () => {
    const a = new BaseSettlementAdapter({ chainId: CHAIN });
    await expect(a.settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s1"))))
      .rejects.toBeInstanceOf(UnconfiguredAdapterError);
  });

  it("Solana likewise", async () => {
    const a = new SolanaSettlementAdapter();
    await expect(a.settle(intent("s1", SOL_FROM, SOL_TO, solCommitment("s1"))))
      .rejects.toBeInstanceOf(UnconfiguredAdapterError);
  });

  it("verify reports unconfirmed rather than throwing", async () => {
    expect((await new BaseSettlementAdapter({ chainId: CHAIN }).verify("0xabc")).confirmed).toBe(false);
    expect((await new SolanaSettlementAdapter().verify("sig")).confirmed).toBe(false);
  });

  it("the error says the integration is not claimed", async () => {
    const e = await new BaseSettlementAdapter({ chainId: CHAIN })
      .settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s1")))
      .catch((x) => x as Error);
    expect((e as Error).message).toMatch(/does not claim a live external integration/i);
  });
});

describe("validation refusals are distinct and shared", () => {
  const bad: [string, Parameters<SettlementAdapter["validateTarget"]>[0]][] = [
    ["INVALID_RECIPIENT_ADDRESS", { asset: "USDC", recipient: "not-an-address", amount: 1 }],
    ["INVALID_AMOUNT", { asset: "USDC", recipient: EVM_TO, amount: 0 }],
    ["UNSUPPORTED_ASSET_ON_BASE", { asset: "DOGE", recipient: EVM_TO, amount: 1 }],
  ];

  it("Base refuses each with a specific reason", async () => {
    const a = new BaseSettlementAdapter({ chainId: CHAIN });
    for (const [reason, input] of bad) {
      await expect(a.validateTarget(input), reason).rejects.toThrow(reason);
    }
  });

  it("Solana refuses the same three, with only the asset vocabulary differing", async () => {
    // This is the interchangeability claim: the *rules* are identical even though
    // the address formats and asset registries are not.
    const a = new SolanaSettlementAdapter();
    await expect(a.validateTarget({ asset: "USDC", recipient: "nope", amount: 1 }))
      .rejects.toThrow("INVALID_RECIPIENT_ADDRESS");
    await expect(a.validateTarget({ asset: "USDC", recipient: SOL_TO, amount: 0 }))
      .rejects.toThrow("INVALID_AMOUNT");
    await expect(a.validateTarget({ asset: "DOGE", recipient: SOL_TO, amount: 1 }))
      .rejects.toThrow("UNSUPPORTED_ASSET_ON_SOLANA");
  });

  it("cross-chain addresses are refused by the other chain", async () => {
    // The WRONG_CHAIN scenario in failure-lab. A Solana address must not be a
    // valid Base recipient, and vice versa.
    await expect(new BaseSettlementAdapter({ chainId: CHAIN }).validateTarget({ asset: "USDC", recipient: SOL_TO, amount: 1 }))
      .rejects.toThrow("INVALID_RECIPIENT_ADDRESS");
    await expect(new SolanaSettlementAdapter().validateTarget({ asset: "USDC", recipient: EVM_TO, amount: 1 }))
      .rejects.toThrow("INVALID_RECIPIENT_ADDRESS");
  });
});

describe("the commitment is re-derived, not trusted", () => {
  it("a commitment for a different settlement is refused", async () => {
    const a = new BaseSettlementAdapter({ chainId: CHAIN });
    await expect(a.settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s2"))))
      .rejects.toThrow("COMMITMENT_MISMATCH");
  });

  it("a commitment for a different recipient is refused", async () => {
    const a = new BaseSettlementAdapter({ chainId: CHAIN });
    const other = `0x${"3".repeat(40)}`;
    await expect(a.settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s1", EVM_FROM, other))))
      .rejects.toThrow("COMMITMENT_MISMATCH");
  });

  it("a commitment minted on one chain id does not verify on another", async () => {
    const onTestnet = baseCommitment("s1");
    const mainnet = new BaseSettlementAdapter({ chainId: 8453 });
    await expect(mainnet.settle(intent("s1", EVM_FROM, EVM_TO, onTestnet)))
      .rejects.toThrow("COMMITMENT_MISMATCH");
  });

  it("commitments are case-insensitive on addresses but not on fields", () => {
    expect(baseCommitment("s1", EVM_FROM.toLowerCase(), EVM_TO.toLowerCase()))
      .toBe(baseCommitment("s1"));
    expect(baseCommitment("s1")).not.toBe(baseCommitment("s2"));
  });
});

describe("the same intent executes on both rails", () => {
  const baseT: BaseTransport = {
    send: async () => ({ txHash: `0x${"a".repeat(64)}` as `0x${string}` }),
    verify: async () => ({ confirmed: true }),
  };
  const solT: SolanaTransport = {
    send: async () => ({ txHash: "5" + "b".repeat(63) }),
    verify: async () => ({ confirmed: true }),
  };

  it("both produce a txHash and LOCAL_PASS once a transport is present", async () => {
    const b = await new BaseSettlementAdapter({ chainId: CHAIN, transport: baseT })
      .settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s1")));
    const s = await new SolanaSettlementAdapter({ transport: solT })
      .settle(intent("s1", SOL_FROM, SOL_TO, solCommitment("s1")));
    expect(b.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64}$/);
    expect(b.evidenceLevel).toBe("LOCAL_PASS");
    expect(s.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("both report confirmed once the transport says so", async () => {
    expect((await new BaseSettlementAdapter({ chainId: CHAIN, transport: baseT }).verify("0x1")).confirmed).toBe(true);
    expect((await new SolanaSettlementAdapter({ transport: solT }).verify("x")).confirmed).toBe(true);
  });

  it("atomic amounts scale by the asset's decimals", async () => {
    const seen: string[] = [];
    const spy: BaseTransport = { ...baseT, send: async (i) => { seen.push(i.amountAtomic); return { txHash: `0x${"c".repeat(64)}` as `0x${string}` }; } };
    await new BaseSettlementAdapter({ chainId: CHAIN, transport: spy })
      .settle(intent("s1", EVM_FROM, EVM_TO, baseCommitment("s1")));
    // USDC has 6 decimals: 12 USDC == 12_000_000 atomic.
    expect(seen[0]).toBe("12000000");
  });

  it("an amount below atomic precision is refused", async () => {
    // 0.0000004 USDC is below 6-decimal precision, so it cannot be represented.
    await expect(new BaseSettlementAdapter({ chainId: CHAIN })
      .validateTarget({ asset: "USDC", recipient: EVM_TO, amount: 0.0000004 }))
      .rejects.toThrow("AMOUNT_BELOW_ATOMIC_PRECISION");
  });

  it("both adapters satisfy the SettlementAdapter contract structurally", () => {
    const adapters: SettlementAdapter[] = [
      new BaseSettlementAdapter({ chainId: CHAIN }),
      new SolanaSettlementAdapter(),
    ];
    for (const a of adapters) {
      expect(typeof a.chain).toBe("string");
      expect(typeof a.validateTarget).toBe("function");
      expect(typeof a.settle).toBe("function");
      expect(typeof a.verify).toBe("function");
    }
    expect(adapters.map((a) => a.chain).sort()).toEqual(["base", "solana"]);
  });
});
