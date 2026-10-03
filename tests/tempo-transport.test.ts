/**
 * Phase 9 — the live Tempo transport, tested against a scripted node.
 *
 * Every rule here was paid for on Moderato (F12, F40, tempo-pay.mjs). The tests
 * pin the ones that fail SILENTLY if lost: a balance read standing in for a
 * receipt, a fee-shortened transfer standing in for the payment, a mint the
 * registry does not know, a chain that is not Moderato, and a rate-limit retried
 * forever or not at all.
 *
 * The live check at the bottom is opt-in (TEMPO_LIVE=1 and a funded
 * .dev-keys/evm-testnet.key) and is the only test here that can be contradicted
 * by the chain rather than by this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseTransaction, type TransactionSerialized } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AssetSymbol, Money } from "@/lib/domain/types";
import { TEMPO_TOKENS, TempoSettlementAdapter, tempoCommitment } from "@/lib/adapters/tempo";
import {
  createTempoRpc,
  ModeratoTransport,
  MODERATO_CHAIN_ID,
  TIP20_ABI,
  TRANSFER_TOPIC,
  type TempoRpc,
} from "@/lib/adapters/tempo-transport";

// A throwaway key that only ever signs in memory here. Never funded.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const MINT = TEMPO_TOKENS.PathUSD.mint;
const TO = "0x1111111111111111111111111111111111111111";
const FEE_VAULT = "0xfeec000000000000000000000000000000000000";
const MEMO = `0x${"ab".repeat(32)}` as const;
const TX_HASH = `0x${"cd".repeat(32)}`;

const topicOf = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const transferLog = (mint: string, from: string, to: string, amount: bigint) => ({
  address: mint, topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)], data: word(amount),
});

/** A scripted node. Records every call so tests can assert what was NOT asked. */
function fakeNode(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc: TempoRpc = async (method, params = []) => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) throw new Error(`unscripted rpc: ${method}`);
    return h(params);
  };
  return { rpc, calls };
}

const sendingNode = (chainId = MODERATO_CHAIN_ID) =>
  fakeNode({
    eth_chainId: () => `0x${chainId.toString(16)}`,
    eth_getTransactionCount: () => "0x7",
    eth_gasPrice: () => "0x3b9aca00", // 1 gwei
    eth_sendRawTransaction: () => TX_HASH,
  });

describe("createTempoRpc — backoff on rate limits only", () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("retries -32002 at 500ms x 2^n and then succeeds", async () => {
    const delays: number[] = [];
    let n = 0;
    const rpc = createTempoRpc({
      fetch: async () => (++n < 3
        ? respond(200, { error: { code: -32002, message: "Resource temporarily unavailable" } })
        : respond(200, { result: "0xa5bf" })),
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(await rpc("eth_chainId")).toBe("0xa5bf");
    expect(delays).toEqual([500, 1000]);
  });

  it("retries HTTP 429 the same way", async () => {
    let n = 0;
    const rpc = createTempoRpc({
      fetch: async () => (++n < 2 ? respond(429, {}) : respond(200, { result: "0x1" })),
      sleep: async () => {},
    });
    expect(await rpc("eth_blockNumber")).toBe("0x1");
    expect(n).toBe(2);
  });

  it("gives up after 3 retries and surfaces the rate-limit error", async () => {
    let n = 0;
    const delays: number[] = [];
    const rpc = createTempoRpc({
      fetch: async () => { n++; return respond(200, { error: { code: -32002, message: "busy" } }); },
      sleep: async (ms) => { delays.push(ms); },
    });
    await expect(rpc("eth_chainId")).rejects.toThrow("busy");
    expect(n).toBe(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("does NOT retry a real rejection", async () => {
    let n = 0;
    const rpc = createTempoRpc({
      fetch: async () => { n++; return respond(200, { error: { code: -32000, message: "value transfer not allowed" } }); },
      sleep: async () => { throw new Error("must not sleep"); },
    });
    await expect(rpc("eth_sendRawTransaction", ["0x"])).rejects.toThrow("value transfer not allowed");
    expect(n).toBe(1);
  });
});

describe("ModeratoTransport.send — what is signed", () => {
  it("signs a zero-value transferWithMemo to the mint, carrying the commitment as memo", async () => {
    const node = sendingNode();
    const t = new ModeratoTransport({ rpc: node.rpc, account });
    const r = await t.send({ to: TO, mint: MINT, amountAtomic: "12000000", commitment: MEMO });
    expect(r.txHash).toBe(TX_HASH);

    const raw = node.calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as TransactionSerialized;
    const tx = parseTransaction(raw);
    expect(tx.chainId).toBe(MODERATO_CHAIN_ID);
    expect(tx.to?.toLowerCase()).toBe(MINT.toLowerCase());
    // F40: native value is refused by the node, so it must never be set.
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.nonce).toBe(7);
    // eth_gasPrice lags the effective price; a 1x signature is rejected.
    expect(tx.maxFeePerGas).toBe(2_000_000_000n);

    const call = decodeFunctionData({ abi: TIP20_ABI, data: tx.data! });
    expect(call.functionName).toBe("transferWithMemo");
    expect(call.args).toEqual([TO, 12_000_000n, MEMO]);
  });

  it("reads the nonce at latest, not pending", async () => {
    const node = sendingNode();
    await new ModeratoTransport({ rpc: node.rpc, account }).send({ to: TO, mint: MINT, amountAtomic: "1", commitment: MEMO });
    expect(node.calls.find((c) => c.method === "eth_getTransactionCount")!.params).toEqual([account.address, "latest"]);
  });

  it.each([
    ["a chain that is not Moderato (Tempo mainnet)", { chainId: 4217 }, {}, "CHAIN_MISMATCH"],
    ["a mint the registry does not know", {}, { mint: "0x20c0000000000000000000000000000000000009" }, "UNREGISTERED_TIP20_MINT"],
    ["a commitment that is not 32 bytes", {}, { commitment: "cmt_s1_moderato" }, "COMMITMENT_NOT_BYTES32"],
    ["a zero amount", {}, { amountAtomic: "0" }, "INVALID_ATOMIC_AMOUNT"],
    ["a fractional atomic amount", {}, { amountAtomic: "1.5" }, "INVALID_ATOMIC_AMOUNT"],
    ["a malformed recipient", {}, { to: "0x123" }, "INVALID_RECIPIENT_ADDRESS"],
  ])("refuses %s and broadcasts nothing", async (_name, nodeOpts, override, error) => {
    const node = sendingNode((nodeOpts as { chainId?: number }).chainId);
    const t = new ModeratoTransport({ rpc: node.rpc, account });
    await expect(t.send({ to: TO, mint: MINT, amountAtomic: "1000000", commitment: MEMO, ...override }))
      .rejects.toThrow(error);
    expect(node.calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });
});

describe("ModeratoTransport.verify — confirmation comes from decoded logs only", () => {
  const AMOUNT = 12_000_000n;
  const intentInput = (to = TO, amount = AMOUNT) =>
    encodeFunctionData({ abi: TIP20_ABI, functionName: "transferWithMemo", args: [to as `0x${string}`, amount, MEMO] });

  const verifyingNode = (opts: {
    status?: string;
    receipt?: null;
    txTo?: string;
    value?: string;
    input?: string;
    logs?: ReturnType<typeof transferLog>[];
  }) =>
    fakeNode({
      eth_getTransactionReceipt: () => (opts.receipt === null ? null : {
        status: opts.status ?? "0x1",
        to: opts.txTo ?? MINT,
        logs: opts.logs ?? [
          transferLog(MINT, account.address, TO, AMOUNT),
          transferLog(MINT, account.address, FEE_VAULT, 32n),
        ],
      }),
      eth_getTransactionByHash: () => ({ to: opts.txTo ?? MINT, value: opts.value ?? "0x0", input: opts.input ?? intentInput() }),
    });

  const verify = async (node: ReturnType<typeof verifyingNode>) =>
    (await new ModeratoTransport({ rpc: node.rpc, account }).verify(TX_HASH)).confirmed;

  it("confirms when the mint logged a Transfer of exactly the intended amount to the intended recipient", async () => {
    expect(await verify(verifyingNode({}))).toBe(true);
  });

  it("never reads a balance (F12: eth_getBalance is a constant on this chain)", async () => {
    const node = verifyingNode({});
    await verify(node);
    expect(node.calls.map((c) => c.method)).not.toContain("eth_getBalance");
    expect(node.calls.map((c) => c.method)).not.toContain("eth_call");
  });

  it.each([
    ["the tx is not yet mined", { receipt: null }],
    ["the receipt status is failure", { status: "0x0" }],
    ["only the fee vault received anything", { logs: [transferLog(MINT, account.address, FEE_VAULT, 32n)] }],
    ["the recipient got less than intended (fee-shortened)", { logs: [transferLog(MINT, account.address, TO, AMOUNT - 32n)] }],
    ["the Transfer was emitted by a different contract", { logs: [transferLog(TEMPO_TOKENS.AlphaUSD.mint, account.address, TO, AMOUNT)] }],
    ["the full amount went to someone other than the intended recipient", {
      logs: [transferLog(MINT, account.address, FEE_VAULT, AMOUNT)],
    }],
    // The callee and the emitter agree here, so only the registry check can refuse it:
    // a contract anyone can deploy may log a Transfer it never made.
    ["the tx called an unregistered contract that logged its own Transfer", {
      txTo: "0x20c0000000000000000000000000000000000009",
      logs: [transferLog("0x20c0000000000000000000000000000000000009", account.address, TO, AMOUNT)],
    }],
    ["the tx carried native value", { value: "0x1" }],
    ["the tx was a plain transfer with no memo", {
      input: encodeFunctionData({
        abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
        functionName: "transfer", args: [TO, AMOUNT],
      }),
    }],
  ])("does not confirm when %s", async (_name, opts) => {
    expect(await verify(verifyingNode(opts as Parameters<typeof verifyingNode>[0]))).toBe(false);
  });

  it("does not ask the node about a malformed hash", async () => {
    const node = verifyingNode({});
    expect((await new ModeratoTransport({ rpc: node.rpc, account }).verify("0x1")).confirmed).toBe(false);
    expect(node.calls).toHaveLength(0);
  });
});

describe("tempoCommitment — the production commitment fits the memo and binds the network", () => {
  const amount: Money = { asset: "PathUSD" as AssetSymbol, amount: 12 };
  const base = { settlementId: "s1", from: account.address, to: TO, amount };

  it("is exactly 32 bytes", () => {
    expect(tempoCommitment({ ...base, network: "moderato" })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("differs between Moderato and mainnet, and between amounts", () => {
    const m = tempoCommitment({ ...base, network: "moderato" });
    expect(tempoCommitment({ ...base, network: "mainnet" })).not.toBe(m);
    expect(tempoCommitment({ ...base, amount: { ...amount, amount: 12.000001 }, network: "moderato" })).not.toBe(m);
  });

  it("drives the adapter end to end through the transport", async () => {
    const node = sendingNode();
    const adapter = new TempoSettlementAdapter(
      { network: "moderato", transport: new ModeratoTransport({ rpc: node.rpc, account }) },
      tempoCommitment,
    );
    const r = await adapter.settle({ ...base, commitmentHash: tempoCommitment({ ...base, network: "moderato" }) });
    expect(r.txHash).toBe(TX_HASH);
    const tx = parseTransaction(node.calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as TransactionSerialized);
    const call = decodeFunctionData({ abi: TIP20_ABI, data: tx.data! });
    expect(call.args[2]).toBe(tempoCommitment({ ...base, network: "moderato" }));
  });
});

/**
 * Opt-in. Spends 0.01 PathUSD (plus the token fee) on a self-transfer, then
 * asks the chain — not this file — whether it happened.
 */
const KEY = ".dev-keys/evm-testnet.key";
const liveIt = process.env.TEMPO_LIVE === "1" && existsSync(KEY) ? it : it.skip;
describe("live Moderato settlement (TEMPO_LIVE=1)", () => {
  liveIt("settles through the adapter and confirms from the receipt's logs", async () => {
    const live = privateKeyToAccount(`0x${readFileSync(KEY, "utf8").trim().replace(/^0x/, "")}`);
    const rpc = createTempoRpc({ url: process.env.TEMPO_RPC ?? undefined });
    const transport = new ModeratoTransport({ rpc, account: live });
    const adapter = new TempoSettlementAdapter({ network: "moderato", transport }, tempoCommitment);

    const input = {
      settlementId: `live-${Date.now()}`,
      from: live.address,
      to: live.address,
      amount: { asset: "PathUSD" as AssetSymbol, amount: 0.01 },
    };
    const commitment = tempoCommitment({ ...input, network: "moderato" });
    const { txHash } = await adapter.settle({ ...input, commitmentHash: commitment });

    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      confirmed = (await adapter.verify(txHash)).confirmed;
    }
    console.log(`live tempo settlement ${txHash} confirmed=${confirmed}`);
    expect(confirmed).toBe(true);

    // The commitment must be ON-CHAIN, not only in our calldata: Moderato emits
    // TransferWithMemo(from, to, amount, bytes32 indexed memo), observed live.
    const MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
    const receipt = (await rpc("eth_getTransactionReceipt", [txHash])) as { logs: Array<{ topics: string[] }> };
    const memoLog = receipt.logs.find((l) => l.topics[0] === MEMO_TOPIC);
    expect(memoLog?.topics[3]).toBe(commitment);
  }, 60_000);
});
