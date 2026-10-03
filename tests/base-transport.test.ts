/**
 * Phase 8 — the live Base transport, tested against a scripted node, plus the
 * two adapter defects found while building it (registry wrong for its chain;
 * commitment amount in whole units, so any fraction threw).
 *
 * The viem clients run for real here; only the node is scripted, through a
 * `custom` EIP-1193 transport, so fee estimation, nonce handling and local
 * signing are the production code paths.
 *
 * The live block at the bottom is opt-in (BASE_LIVE=1 and a funded
 * .dev-keys/evm-testnet.key) and is the only part that can be contradicted by
 * the chain rather than by this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concatHex,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  parseTransaction,
  sliceHex,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AssetSymbol } from "@/lib/domain/types";
import { settlementDigest, settlingDomain } from "@/lib/evm/eip712";
import { BASE_ASSETS, BaseSettlementAdapter, settlementCommitment, ZERO_ADDRESS, type BaseChainId } from "@/lib/adapters/base";
import { BaseRpcTransport, commitmentFromCalldata } from "@/lib/adapters/base-transport";

const account = privateKeyToAccount(`0x${"22".repeat(32)}`); // never funded
const SEPOLIA: BaseChainId = 84532;
const USDC = BASE_ASSETS[SEPOLIA].USDC;
const TO = "0x1111111111111111111111111111111111111111" as const;
const COMMIT = `0x${"ab".repeat(32)}` as const;
const TX_HASH = `0x${"cd".repeat(32)}` as const;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const transferLog = (token: string, to: string, amount: bigint) => ({
  address: token, topics: [TRANSFER_TOPIC, topicOf(account.address), topicOf(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x10", logIndex: "0x0", transactionHash: TX_HASH, transactionIndex: "0x0", removed: false,
});

/** A scripted EIP-1193 node behind viem's `custom` transport. */
function fakeNode(over: Record<string, (params: unknown[]) => unknown> = {}, chainId: number = SEPOLIA) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => hex(chainId),
    eth_getTransactionCount: () => "0x5",
    eth_getBlockByNumber: () => ({
      number: "0x10", hash: `0x${"1".repeat(64)}`, parentHash: `0x${"0".repeat(64)}`, timestamp: "0x1",
      baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
    }),
    eth_maxPriorityFeePerGas: () => "0x5f5e100",
    eth_estimateGas: () => "0xa0ed",
    eth_sendRawTransaction: () => TX_HASH,
    ...over,
  };
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params: params ?? [] });
      const h = handlers[method];
      if (!h) throw new Error(`unscripted rpc: ${method}`);
      return h(params ?? []);
    },
  });
  return { transport, calls };
}

const rawSent = (calls: Array<{ method: string; params: unknown[] }>) =>
  parseTransaction(calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as TransactionSerialized);

const sendInput = { to: TO, amountAtomic: "500000", asset: USDC, chainId: SEPOLIA, data: COMMIT };

describe("adapter defects fixed alongside the transport", () => {
  const from = account.address;

  it("a fractional amount settles (it threw SyntaxError: Cannot convert 0.5 to a BigInt)", async () => {
    const seen: string[] = [];
    const a = new BaseSettlementAdapter({
      chainId: SEPOLIA,
      transport: { send: async (i) => { seen.push(i.amountAtomic); return { txHash: TX_HASH }; }, verify: async () => ({ confirmed: true }) },
    });
    const amount = { asset: "USDC" as AssetSymbol, amount: 0.5 };
    const commitmentHash = settlementCommitment({ settlementId: "s1", from, to: TO, amount: 0.5, asset: "USDC", chainId: SEPOLIA });
    await a.settle({ settlementId: "s1", from, to: TO, amount, commitmentHash });
    expect(seen).toEqual(["500000"]);
  });

  it("the signed amountAtomic is atomic and the asset is the token contract", () => {
    // Re-derived from the EIP-712 primitives, so a regression to whole units
    // (12 instead of 12_000_000) or to the symbol cannot pass.
    const expected = settlementDigest(settlingDomain(SEPOLIA, ZERO_ADDRESS), {
      settlementId: "s1", from, to: TO, amountAtomic: 12_000_000n, asset: USDC.address,
    });
    expect(settlementCommitment({ settlementId: "s1", from, to: TO, amount: 12, asset: "USDC", chainId: SEPOLIA })).toBe(expected);
  });

  it("USDC resolves to a different contract on each chain", async () => {
    expect(BASE_ASSETS[84532].USDC.address).not.toBe(BASE_ASSETS[8453].USDC.address);
    const seen: string[] = [];
    const spy = { send: async (i: { asset: { address: string } | null }) => { seen.push(i.asset!.address); return { txHash: TX_HASH }; }, verify: async () => ({ confirmed: true }) };
    for (const chainId of [84532, 8453] as const) {
      const amount = { asset: "USDC" as AssetSymbol, amount: 1 };
      const commitmentHash = settlementCommitment({ settlementId: "s1", from, to: TO, amount: 1, asset: "USDC", chainId });
      await new BaseSettlementAdapter({ chainId, transport: spy }).settle({ settlementId: "s1", from, to: TO, amount, commitmentHash });
    }
    expect(seen).toEqual([BASE_ASSETS[84532].USDC.address, BASE_ASSETS[8453].USDC.address]);
  });
});

describe("BaseRpcTransport.send — what is signed", () => {
  it("signs a zero-value ERC-20 transfer to the chain's token, with the commitment appended", async () => {
    const node = fakeNode();
    const r = await new BaseRpcTransport({ account, chainId: SEPOLIA, transport: node.transport }).send(sendInput);
    expect(r.txHash).toBe(TX_HASH);

    const tx = rawSent(node.calls);
    expect(tx.chainId).toBe(SEPOLIA);
    expect(tx.to?.toLowerCase()).toBe(USDC.address.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(commitmentFromCalldata(tx.data!)).toBe(COMMIT);
    const call = decodeFunctionData({ abi: erc20Abi, data: sliceHex(tx.data!, 0, 68) });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([TO, 500_000n]);
  });

  it.each([
    ["a node on another chain (Base mainnet)", { nodeChain: 8453 }, {}, "CHAIN_MISMATCH"],
    ["a settlement for another chain id", {}, { chainId: 8453 as BaseChainId }, "CHAIN_MISMATCH"],
    ["the mainnet USDC address on Sepolia", {}, { asset: BASE_ASSETS[8453].USDC }, "UNREGISTERED_ERC20_FOR_CHAIN"],
    ["a native (asset-less) settlement", {}, { asset: null }, "NATIVE_SETTLEMENT_NOT_SUPPORTED"],
    ["a commitment that is not 32 bytes", {}, { data: "0xabcd" }, "COMMITMENT_NOT_BYTES32"],
    ["a zero amount", {}, { amountAtomic: "0" }, "INVALID_ATOMIC_AMOUNT"],
    ["a malformed recipient", {}, { to: "0x123" as `0x${string}` }, "INVALID_RECIPIENT_ADDRESS"],
  ])("refuses %s and broadcasts nothing", async (_n, nodeOpts, override, error) => {
    const node = fakeNode({}, (nodeOpts as { nodeChain?: number }).nodeChain ?? SEPOLIA);
    const t = new BaseRpcTransport({ account, chainId: SEPOLIA, transport: node.transport });
    await expect(t.send({ ...sendInput, ...override })).rejects.toThrow(error);
    expect(node.calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });
});

describe("BaseRpcTransport.verify — confirmation comes from decoded logs only", () => {
  const AMOUNT = 500_000n;
  const transferData = (to: string = TO, amount = AMOUNT) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount] });

  const verifyingNode = (o: { status?: string; noReceipt?: boolean; txTo?: string; value?: string; input?: Hex; logs?: ReturnType<typeof transferLog>[] } = {}) =>
    fakeNode({
      eth_getTransactionReceipt: () => (o.noReceipt ? null : {
        status: o.status ?? "0x1", transactionHash: TX_HASH, transactionIndex: "0x0", blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x10",
        from: account.address, to: o.txTo ?? USDC.address, cumulativeGasUsed: "0xa0ed", gasUsed: "0xa0ed", effectiveGasPrice: "0x3b9aca00",
        contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, type: "0x2",
        logs: o.logs ?? [transferLog(USDC.address, TO, AMOUNT)],
      }),
      eth_getTransactionByHash: () => ({
        hash: TX_HASH, from: account.address, to: o.txTo ?? USDC.address, value: o.value ?? "0x0",
        input: o.input ?? concatHex([transferData(), COMMIT]), nonce: "0x5", gas: "0xa0ed", type: "0x2",
        maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x5f5e100", chainId: hex(SEPOLIA),
        blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x10", transactionIndex: "0x0", v: "0x0", r: "0x1", s: "0x1", yParity: "0x0", accessList: [],
      }),
    });

  const verify = async (node: ReturnType<typeof verifyingNode>, chainId: BaseChainId = SEPOLIA) =>
    (await new BaseRpcTransport({ account, chainId: SEPOLIA, transport: node.transport }).verify(TX_HASH, chainId)).confirmed;

  it("confirms an exact Transfer from the registered token to the intended recipient", async () => {
    expect(await verify(verifyingNode())).toBe(true);
  });

  it("never reads a balance", async () => {
    const node = verifyingNode();
    await verify(node);
    const methods = node.calls.map((c) => c.method);
    expect(methods).not.toContain("eth_getBalance");
    expect(methods).not.toContain("eth_call");
  });

  it.each([
    ["the tx is not mined", { noReceipt: true }],
    ["the receipt reverted", { status: "0x0" }],
    ["the recipient got less than intended", { logs: [transferLog(USDC.address, TO, AMOUNT - 1n)] }],
    ["the full amount went to someone else", { logs: [transferLog(USDC.address, `0x${"9".repeat(40)}`, AMOUNT)] }],
    ["the Transfer came from a different contract", { logs: [transferLog(BASE_ASSETS[SEPOLIA].WETH.address, TO, AMOUNT)] }],
    // Callee and emitter agree, so only the registry check can refuse it.
    ["an unregistered token logged its own Transfer", { txTo: BASE_ASSETS[8453].USDC.address, logs: [transferLog(BASE_ASSETS[8453].USDC.address, TO, AMOUNT)] }],
    ["the tx carried native value", { value: "0x1" }],
    ["the transfer has no commitment suffix", { input: transferData() }],
    ["the call was approve, not transfer", {
      input: concatHex([encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TO, AMOUNT] }), COMMIT]),
    }],
  ])("does not confirm when %s", async (_n, o) => {
    expect(await verify(verifyingNode(o as Parameters<typeof verifyingNode>[0]))).toBe(false);
  });

  it("does not confirm against a different chain id", async () => {
    expect(await verify(verifyingNode(), 8453)).toBe(false);
  });
});

/**
 * Opt-in. Settles 0.01 USDC — a FRACTIONAL amount, which the adapter could not
 * settle at all before — to the sender, then asks the chain whether it happened
 * and whether the commitment is in the transaction it can see.
 */
const KEY = ".dev-keys/evm-testnet.key";
const live = process.env.BASE_LIVE === "1" && existsSync(KEY);
describe.skipIf(!live)("live Base Sepolia (BASE_LIVE=1)", () => {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

  it("every Sepolia registry entry is a live contract with the claimed symbol and decimals", async () => {
    const { createPublicClient } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const c = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    for (const [key, a] of Object.entries(BASE_ASSETS[84532])) {
      expect(await c.readContract({ address: a.address, abi: erc20Abi, functionName: "symbol" }), key).toBe(key);
      expect(await c.readContract({ address: a.address, abi: erc20Abi, functionName: "decimals" }), key).toBe(a.decimals);
    }
  }, 30_000);

  it("settles through the adapter, confirms from logs, and carries the commitment on-chain", async () => {
    const me = privateKeyToAccount(`0x${readFileSync(KEY, "utf8").trim().replace(/^0x/, "")}`);
    const transport = new BaseRpcTransport({ account: me, chainId: SEPOLIA, transport: http(rpcUrl) });
    const adapter = new BaseSettlementAdapter({ chainId: SEPOLIA, transport });
    const settlementId = `live-${Date.now()}`;
    const amount = { asset: "USDC" as AssetSymbol, amount: 0.01 };
    const commitmentHash = settlementCommitment({ settlementId, from: me.address, to: me.address, amount: 0.01, asset: "USDC", chainId: SEPOLIA });

    const { txHash } = await adapter.settle({ settlementId, from: me.address, to: me.address, amount, commitmentHash });
    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      confirmed = (await adapter.verify(txHash)).confirmed;
    }
    console.log(`live base settlement ${txHash} confirmed=${confirmed}`);
    expect(confirmed).toBe(true);

    const res = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] }),
    });
    const { result } = (await res.json()) as { result: { input: Hex } };
    expect(commitmentFromCalldata(result.input)).toBe(commitmentHash);
  }, 90_000);
});
