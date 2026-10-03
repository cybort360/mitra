/**
 * Tempo Moderato transport (PRD Phase 9) — the live half of `TempoSettlementAdapter`.
 *
 * Everything here was measured on `rpc.moderato.tempo.xyz` before it was written
 * down; `scripts/tempo-pay.mjs` is the executable record of most of it.
 *
 * ## A payment is `transferWithMemo`, not native value and not plain `transfer`
 *
 * Native value is refused by the node ("value transfer not allowed", F40), so the
 * transaction always carries `value = 0` and calls a TIP-20 mint. It calls
 * `transferWithMemo(to, amount, bytes32 memo)` rather than `transfer` so the
 * settlement commitment travels ON-CHAIN with the payment. With plain `transfer`
 * the link between a Mitra settlement and the transfer that paid it would exist
 * only in Mitra's own records, which is exactly the local truth §21.4 says a
 * counterparty cannot check. Selector `0x95777d59` was confirmed live: an unknown
 * selector reverts with `UnknownFunctionSelector`, this one does not.
 *
 * ## Confirmation is decoded logs, never balances
 *
 * `eth_getBalance` is a constant on this chain (F12), and a TIP-20 transfer levies
 * a fee in the transferred token, so a balance delta makes a correct payment look
 * short (F40). `verify` therefore reads the transaction's own calldata to learn
 * what it was SUPPOSED to move, and confirms only if the receipt contains a
 * `Transfer` log from that same mint, to that same recipient, for that exact
 * amount. Nothing in this file calls `eth_getBalance`.
 *
 * ## Rate limits
 *
 * Moderato answers bursts with `-32002` ("Resource temporarily unavailable") or
 * HTTP 429. Every call goes through `createTempoRpc`, which retries those — and
 * only those — up to 3 times at 500ms × 2^n, as `scripts/fund-tempo.mjs` does.
 * Any other error is thrown at once: retrying a real rejection would only delay it.
 */

import { decodeFunctionData, encodeFunctionData, parseAbi, type LocalAccount } from "viem";
import { TEMPO_TOKENS, type TempoTransport } from "./tempo";
import type { ChainObservation } from "./types";

export const MODERATO_CHAIN_ID = 42431;
export const MODERATO_RPC_URL = "https://rpc.moderato.tempo.xyz";

/** ERC-20 / TIP-20 `Transfer(address indexed from, address indexed to, uint256 value)`. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const TIP20_ABI = parseAbi([
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
]);

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const REGISTERED_MINTS = new Set(Object.values(TEMPO_TOKENS).map((t) => t.mint.toLowerCase()));

// ---------------------------------------------------------------------------
// JSON-RPC with backoff
// ---------------------------------------------------------------------------

export class TempoRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`${method}: ${message}`);
  }
}

export type TempoRpc = (method: string, params?: unknown[]) => Promise<unknown>;

export interface TempoRpcOptions {
  url?: string;
  /** Retries AFTER the first attempt. 3 retries is 4 requests at most. */
  retries?: number;
  baseDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Codes that mean "ask again later", not "no". */
const RETRYABLE_CODES = new Set([-32002]);

export function createTempoRpc(opts: TempoRpcOptions = {}): TempoRpc {
  const url = opts.url ?? MODERATO_RPC_URL;
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      const retryable = res.status === 429 || (body.error?.code !== undefined && RETRYABLE_CODES.has(body.error.code));
      if (retryable && attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      if (body.error) throw new TempoRpcError(method, body.error.code, body.error.message ?? JSON.stringify(body.error));
      if (!res.ok) throw new TempoRpcError(method, res.status, `HTTP ${res.status}`);
      return body.result;
    }
  };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface ModeratoTransportOptions {
  rpc: TempoRpc;
  /** Signs locally. The key never leaves the process; only the signed tx is sent. */
  account: LocalAccount;
  chainId?: number;
  /** `eth_gasPrice` lags the effective price on Moderato; signing at 1x is rejected. */
  gasPriceMultiplier?: bigint;
  gasLimit?: bigint;
}

interface RpcReceipt {
  status: string;
  blockNumber?: string;
  to: string | null;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

interface RpcTransaction {
  from?: string;
  to: string | null;
  input: string;
  value: string;
}

export class ModeratoTransport implements TempoTransport {
  private readonly chainId: number;

  constructor(private readonly opts: ModeratoTransportOptions) {
    this.chainId = opts.chainId ?? MODERATO_CHAIN_ID;
  }

  async send(input: { to: string; mint: string; amountAtomic: string; commitment: string }): Promise<{ txHash: string }> {
    // Each refusal happens before anything is signed, so a refused send never
    // reaches the network in any form.
    if (!EVM_ADDRESS.test(input.to)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!REGISTERED_MINTS.has(input.mint.toLowerCase())) throw new Error("UNREGISTERED_TIP20_MINT");
    if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("INVALID_ATOMIC_AMOUNT");
    // The memo slot is exactly 32 bytes. Hashing or padding a longer or shorter
    // commitment to fit would make two different commitments share one memo,
    // which is the ambiguous-encoding class F45 recorded.
    if (!BYTES32.test(input.commitment)) throw new Error("COMMITMENT_NOT_BYTES32");

    // WRONG_CHAIN refuses rather than warns: a signed tx is replayable on any
    // chain with the same id, and mainnet Tempo is 4217.
    const reported = Number(BigInt((await this.opts.rpc("eth_chainId")) as string));
    if (reported !== this.chainId) throw new Error(`CHAIN_MISMATCH: expected ${this.chainId}, node reports ${reported}`);

    const data = encodeFunctionData({
      abi: TIP20_ABI,
      functionName: "transferWithMemo",
      args: [input.to as `0x${string}`, BigInt(input.amountAtomic), input.commitment as `0x${string}`],
    });

    // "latest", not "pending": the pending nonce lags the mined one on Moderato
    // and produces repeated "nonce too low" (tempo-pay.mjs).
    const nonce = Number(BigInt((await this.opts.rpc("eth_getTransactionCount", [this.opts.account.address, "latest"])) as string));
    const gasPrice = BigInt((await this.opts.rpc("eth_gasPrice")) as string);
    const multiplier = this.opts.gasPriceMultiplier ?? 2n;

    const signed = await this.opts.account.signTransaction({
      type: "eip1559",
      chainId: this.chainId,
      to: input.mint as `0x${string}`,
      value: 0n,
      data,
      nonce,
      gas: this.opts.gasLimit ?? 500_000n,
      maxFeePerGas: gasPrice * multiplier,
      maxPriorityFeePerGas: gasPrice,
    });

    const txHash = (await this.opts.rpc("eth_sendRawTransaction", [signed])) as string;
    if (!BYTES32.test(txHash)) throw new Error("NODE_RETURNED_MALFORMED_TX_HASH");
    return { txHash };
  }

  /**
   * Confirmed means: the receipt succeeded AND it contains a `Transfer` log, emitted
   * by the mint the transaction called, to the recipient the calldata named, for the
   * amount the calldata named. `status == 1` alone is not confirmation — a
   * successful transaction can still deliver nothing to the address it was for.
   */
  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    return { confirmed: (await this.observe(txHash)) !== null };
  }

  /**
   * What the chain shows for a settlement, or null if it is not a confirmed one.
   * `verify` is exactly `observe(...) !== null`. The carried commitment is the
   * `transferWithMemo` memo, decoded from the calldata the node returned.
   */
  async observe(txHash: string): Promise<ChainObservation | null> {
    if (!BYTES32.test(txHash)) return null;

    const receipt = (await this.opts.rpc("eth_getTransactionReceipt", [txHash])) as RpcReceipt | null;
    if (!receipt || BigInt(receipt.status) !== 1n) return null;

    const tx = (await this.opts.rpc("eth_getTransactionByHash", [txHash])) as RpcTransaction | null;
    if (!tx?.to || !REGISTERED_MINTS.has(tx.to.toLowerCase())) return null;
    if (BigInt(tx.value) !== 0n) return null;

    const intent = decodeIntent(tx.input);
    if (!intent) return null;

    const mint = tx.to.toLowerCase();
    const delivered = receipt.logs.some(
      (l) =>
        l.address.toLowerCase() === mint &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        l.topics.length === 3 &&
        topicAddress(l.topics[2]) === intent.to &&
        BigInt(l.data) === intent.amount,
    );
    if (!delivered) return null;
    return {
      txHash,
      block: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : 0,
      carriedCommitment: intent.memo,
      from: (tx.from ?? "").toLowerCase(),
      to: intent.to,
      amountAtomic: intent.amount,
      asset: mint,
    };
  }
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Only `transferWithMemo` counts, and `TIP20_ABI` is what enforces it: it holds no
 * other function, so any other calldata fails to decode. A plain `transfer` carries
 * no commitment, so it cannot be a Mitra settlement even if it moved the right
 * amount to the right place.
 */
function decodeIntent(input: string): { to: string; amount: bigint; memo: string } | null {
  try {
    const { args } = decodeFunctionData({ abi: TIP20_ABI, data: input as `0x${string}` });
    return { to: args[0].toLowerCase(), amount: args[1], memo: String(args[2]).toLowerCase() };
  } catch {
    return null;
  }
}
