/**
 * Cross-chain payout: settling an agreement to a payee on a chain Mitra does not
 * operate vaults on (LP-7).
 *
 * ## The problem
 *
 * Counterparties increasingly live on BNB Chain or X Layer. The obvious answer — deploy a
 * MitraVault there — is exactly what this module exists to avoid: an unverified vault on
 * an unaudited network holding real capital is a liability, not a feature. So the
 * **escrow stays canonical** (Base, Tempo, Solana) and only the *payout* crosses, through a
 * relayer the counterparty's chain already has liquidity for.
 *
 * ## What this module is careful about
 *
 * Everything here is irreversible: once the relayer broadcasts, the money is gone. So the
 * checks are in three layers, and each refuses rather than corrects.
 *
 * 1. **Identity.** A payout address is validated as a strict EIP-55 checksummed address and
 *    the destination chain is resolved through an explicit registry. A wrong-network or
 *    malformed address is not a typo here; it is a permanent loss, and there is no recovery
 *    path on the far side.
 * 2. **Price.** A quote is rejected before execution if its fee exceeds
 *    `min(1% of amount, $2.00)` or if it needs more than 50 bps of slippage. A relayer that
 *    quotes a fee we did not agree to in advance is not a relayer we should use at all.
 * 3. **Authority.** `amount + fee` must fit inside the payer's remaining headroom. The fee
 *    is *additional* debit, so a guard that only checks `amount` is a guard that can be
 *    walked past by a large fee — and the fee is the one number the counterparty's chain
 *    sets.
 *
 * ## No silent simulation
 *
 * `SimulatedPayoutRelayer` exists for offline tests and says so on every result:
 * `isSimulated: true` and `evidenceLevel: "LOCAL_PASS"`. It never produces a hash that
 * could be pasted into an explorer, because `AGENTS.md` forbids production code from
 * claiming a settlement it did not make — and the dangerous version of this bug is not a
 * crash, it is a test double whose output reaches a settlement record.
 *
 * `LiFiPayoutRelayer` is the concrete live transport and **fails closed** with
 * `UNCONFIGURED_RELAYER` when its key is absent. An unconfigured relayer must never resolve
 * to "no fee, just send it".
 */

import { createHash } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import type { EvidenceLevel, Money } from "@/lib/domain/types";

// ── chains ─────────────────────────────────────────────────────────────────────

/** Chains Mitra operates escrows and vaults on. */
export type CanonicalChain = "base" | "tempo" | "solana";

/** Chains Mitra settles TO but never holds a vault on. */
export type ExternalChain = "bnb" | "xlayer";

export type AnyChain = CanonicalChain | ExternalChain;

export function isExternalChain(chain: string): chain is ExternalChain {
  return chain === "bnb" || chain === "xlayer";
}

export function isCanonicalChain(chain: string): chain is CanonicalChain {
  return chain === "base" || chain === "tempo" || chain === "solana";
}

/**
 * EIP-155 ids for the external chains, and nothing else.
 *
 * **An explicit registry, not a lookup.** Accepting any numeric chain id would mean a typo
 * in a chain name silently bridged somewhere real and expensive, and it would make the set
 * of chains Mitra will send money to depend on whatever a provider happens to support this
 * month. Testnet and mainnet are both listed because the pairing is the security-relevant
 * fact: paying a mainnet address a testnet bridge would strand the funds.
 */
export const EXTERNAL_CHAIN_IDS: Record<ExternalChain, { mainnet: number; testnet: number; label: string }> = {
  bnb: { mainnet: 56, testnet: 97, label: "BNB Chain" },
  xlayer: { mainnet: 196, testnet: 195, label: "X Layer" },
};

export const CAIP2_MAINNET: Record<ExternalChain, string> = {
  bnb: "eip155:56",
  xlayer: "eip155:196",
};
export const CAIP2_TESTNET: Record<ExternalChain, string> = {
  bnb: "eip155:97",
  xlayer: "eip155:195",
};

// ── policy constants ───────────────────────────────────────────────────────────

/** 1.0% — the fee ceiling as a fraction of the payout. */
export const MAX_FEE_BPS = 100n;
/** $2.00 — the absolute fee ceiling, in USD-equivalent units of the asset. */
export const MAX_FEE_USD = 2;
/** 50 bps — the most slippage a quote may require before it is rejected outright. */
export const MAX_SLIPPAGE_BPS = 50n;
const BPS = 10_000n;

/**
 * The largest fee this repository will accept for a payout.
 *
 * `min(1% of amount, $2.00)`, evaluated in integer basis points so the comparison cannot be
 * lost to floating point — a fee of `0.1 + 0.2` compared against a limit of `0.3` is exactly
 * the class of bug a money limit must not have.
 *
 * The smaller of the two caps, so a large payout is not charged 1% of itself and a small one
 * is not charged $2 on a $3 transfer.
 */
export function maxFeeFor(amount: Money): number {
  // Micro-units throughout: `amount_micro * bps / 10_000` is the 1% figure, and dividing by
  // BPS a second time silently yields 1/100th of the intended ceiling. The first version
  // did exactly that, and the boundary test at the cap is what caught it.
  const proportional = (BigInt(Math.round(amount.amount * 1_000_000)) * MAX_FEE_BPS) / BPS;
  const cap = BigInt(Math.round(MAX_FEE_USD * 1_000_000));
  const allowed = proportional < cap ? proportional : cap;
  return Number(allowed) / 1_000_000;
}

// ── validation ──────────────────────────────────────────────────────────────────

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string };

/**
 * A payout address, or a refusal.
 *
 * **Strict EIP-55.** `getAddress(address) !== address` rejects a lower- or upper-case
 * address, which is the correct refusal for a value nobody will ever read back: an address
 * that does not checksum is an address that was not verified by a human or a tool before
 * real money was sent to it. It also rejects a mistyped-but-valid address, because the
 * checksum would not match — which is the entire point of EIP-55.
 *
 * The zero address is refused separately because it *is* a valid checksummed address: it
 * would pass the check above and burn the payout.
 */
export function validatePayoutRecipient(address: string): ValidationResult<Address> {
  if (!isAddress(address)) {
    return { ok: false, reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS", detail: "not an EVM address" };
  }
  if (getAddress(address) !== address) {
    return {
      ok: false,
      reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS",
      detail: "address does not carry a valid EIP-55 checksum; pass it exactly as `getAddress` returns it",
    };
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    return { ok: false, reason: "ZERO_ADDRESS_PAYOUT_REFUSED", detail: "the zero address burns the payout" };
  }
  return { ok: true, value: address as Address };
}

/** Resolve a destination chain name, or refuse. Never guesses. */
export function resolveExternalChain(chain: string): ValidationResult<ExternalChain> {
  if (!isExternalChain(chain)) {
    return {
      ok: false,
      reason: "UNSUPPORTED_PAYOUT_CHAIN",
      detail: `${chain} is not a supported payout destination (known: ${Object.keys(EXTERNAL_CHAIN_IDS).join(", ")})`,
    };
  }
  return { ok: true, value: chain };
}

// ── the relayer interface ───────────────────────────────────────────────────────

export interface BridgeQuoteInput {
  sourceChain: CanonicalChain;
  targetChain: ExternalChain;
  /** Already validated as a strict-checksum address. */
  recipient: Address;
  amount: Money;
}

export interface BridgeQuote {
  bridgeFee: Money;
  /** The slippage the quote REQUIRES. Rejected above {@link MAX_SLIPPAGE_BPS}. */
  slippageBps: number;
  estimatedSeconds?: number;
  /** Opaque handle the provider needs to execute this exact quote. */
  routeId?: string;
}

export interface BridgePayoutInput extends BridgeQuoteInput {
  quote: BridgeQuote;
  /** The canonical-chain transaction that funded the relayer for this payout. */
  sourceTxHash: string;
}

export interface BridgePayoutResult {
  /** Absent when simulated — a simulated run must not mint an explorer-pasteable hash. */
  bridgeTxHash?: string;
  recipient: Address;
  amount: Money;
  bridgeFee: Money;
  isSimulated: boolean;
  evidenceLevel: EvidenceLevel;
}

export interface CrossChainPayoutRelayer {
  readonly name: string;
  quoteBridge(input: BridgeQuoteInput): Promise<BridgeQuote>;
  executeBridgePayout(input: BridgePayoutInput): Promise<BridgePayoutResult>;
}

// ── the policy ──────────────────────────────────────────────────────────────────

export interface CrossChainPayoutPlanInput {
  sourceChain: CanonicalChain;
  targetChain: string;
  recipient: string;
  amount: Money;
  quote: BridgeQuote;
  /**
   * What the payer can still spend, in the payout asset.
   *
   * The fee is an ADDITIONAL debit on top of `amount`, so this must cover both. A guard
   * that checks only `amount` is walkable by exactly the number the destination chain sets.
   */
  remainingHeadroom: Money;
}

/**
 * Decide whether a quoted payout may execute. Pure, and the only place that may say yes.
 *
 * Order matters and is deliberate: **identity, then price, then authority.** A wrong
 * address is reported as a wrong address rather than as an insufficient fee; a caller
 * debugging a refused payout should be told the first thing that is actually wrong.
 */
export function planCrossChainPayout(input: CrossChainPayoutPlanInput): ValidationResult<{
  recipient: Address;
  targetChain: ExternalChain;
  amount: Money;
  bridgeFee: Money;
  /** `amount + fee`, the figure the headroom guard is about. */
  totalDebit: Money;
}> {
  const chain = resolveExternalChain(input.targetChain);
  if (!chain.ok) return chain;

  const recipient = validatePayoutRecipient(input.recipient);
  if (!recipient.ok) return recipient;

  const fee = input.quote.bridgeFee;
  if (fee.asset !== input.amount.asset) {
    return { ok: false, reason: "BRIDGE_FEE_ASSET_MISMATCH", detail: `fee in ${fee.asset}, payout in ${input.amount.asset}` };
  }
  if (!Number.isFinite(fee.amount) || fee.amount < 0) {
    return { ok: false, reason: "INVALID_BRIDGE_FEE", detail: String(fee.amount) };
  }

  // Integer basis points, so a limit cannot be lost to float noise.
  const feeScaled = BigInt(Math.round(fee.amount * 1_000_000));
  const cap = BigInt(Math.round(maxFeeFor(input.amount) * 1_000_000));
  if (feeScaled > cap) {
    return {
      ok: false,
      reason: "EXCEEDS_BRIDGE_FEE_LIMIT",
      detail: `fee ${fee.amount} ${fee.asset} exceeds the ceiling of ${Number(cap) / 1_000_000} ${fee.asset} (min(1% of ${input.amount.amount}, $${MAX_FEE_USD.toFixed(2)}))`,
    };
  }

  if (!Number.isInteger(input.quote.slippageBps) || input.quote.slippageBps < 0) {
    return { ok: false, reason: "INVALID_SLIPPAGE", detail: String(input.quote.slippageBps) };
  }
  if (BigInt(input.quote.slippageBps) > MAX_SLIPPAGE_BPS) {
    return {
      ok: false,
      reason: "EXCEEDS_SLIPPAGE_LIMIT",
      detail: `quote requires ${input.quote.slippageBps} bps; the ceiling is ${MAX_SLIPPAGE_BPS}`,
    };
  }

  const totalDebit = { asset: input.amount.asset, amount: input.amount.amount + fee.amount };
  if (totalDebit.amount > input.remainingHeadroom.amount) {
    return {
      ok: false,
      reason: "PAYOUT_EXCEEDS_HEADROOM",
      detail: `amount ${input.amount.amount} + fee ${fee.amount} exceeds remaining headroom ${input.remainingHeadroom.amount}`,
    };
  }

  return {
    ok: true,
    value: { recipient: recipient.value, targetChain: chain.value, amount: input.amount, bridgeFee: fee, totalDebit },
  };
}

// ── the canonical receipt ──────────────────────────────────────────────────────

export type CrossChainReceiptStatus = "SETTLED_EXTERNALLY";

export interface MitraCrossChainReceipt {
  receiptId: string;
  agreementId: string;
  sourceChain: CanonicalChain;
  targetChain: ExternalChain;
  targetChainId: number;
  recipient: Address;
  amount: Money;
  bridgeFee: Money;
  /** The canonical-chain settlement that funded the relayer. */
  sourceTxHash: string;
  /** The destination-chain bridge transaction. Absent for a simulated run. */
  bridgeTxHash?: string;
  status: CrossChainReceiptStatus;
  evidenceLevel: EvidenceLevel;
  isSimulated: boolean;
  /** Binds the receipt to its contents; see {@link crossChainReceiptHash}. */
  receiptHash: string;
}

/**
 * The receipt's own hash, over everything a reader needs to detect a substituted receipt.
 *
 * Domain-separated for the same reason the route commitment is (F81): without a prefix, the
 * same fields hashed for another purpose would produce the same digest, and a receipt hash
 * that could collide with another kind of hash is not evidence of anything.
 *
 * Sorted where order is not meaningful, so two identical receipts hash identically
 * regardless of how the object was built.
 */
export function crossChainReceiptHash(receipt: Omit<MitraCrossChainReceipt, "receiptHash">): string {
  const canonical = JSON.stringify({
    v: "mitra-cross-chain-receipt.v1",
    receiptId: receipt.receiptId,
    agreementId: receipt.agreementId,
    sourceChain: receipt.sourceChain,
    targetChain: receipt.targetChain,
    targetChainId: receipt.targetChainId,
    recipient: receipt.recipient.toLowerCase(),
    amount: { asset: receipt.amount.asset, amount: receipt.amount.amount },
    bridgeFee: { asset: receipt.bridgeFee.asset, amount: receipt.bridgeFee.asset === receipt.amount.asset ? receipt.bridgeFee.amount : 0 },
    sourceTxHash: receipt.sourceTxHash.toLowerCase(),
    bridgeTxHash: receipt.bridgeTxHash?.toLowerCase() ?? null,
    status: receipt.status,
    evidenceLevel: receipt.evidenceLevel,
    isSimulated: receipt.isSimulated,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Build the receipt anchoring an external settlement to its internal agreement.
 *
 * `agreementId` is in the hash, so a receipt cannot be lifted from one agreement onto
 * another without changing its digest — which is the property that makes the receipt
 * evidence rather than a label.
 */
export function buildCrossChainReceipt(input: {
  agreementId: string;
  sourceChain: CanonicalChain;
  targetChain: ExternalChain;
  testnet: boolean;
  recipient: Address;
  amount: Money;
  bridgeFee: Money;
  sourceTxHash: string;
  result: BridgePayoutResult;
}): MitraCrossChainReceipt {
  const base: Omit<MitraCrossChainReceipt, "receiptHash"> = {
    receiptId: `rcpt_${input.agreementId}`,
    agreementId: input.agreementId,
    sourceChain: input.sourceChain,
    targetChain: input.targetChain,
    targetChainId: input.testnet ? EXTERNAL_CHAIN_IDS[input.targetChain].testnet : EXTERNAL_CHAIN_IDS[input.targetChain].mainnet,
    recipient: input.recipient,
    amount: input.amount,
    bridgeFee: input.bridgeFee,
    sourceTxHash: input.sourceTxHash,
    // Omitted entirely for a simulated run: no hash, rather than a hash-shaped nothing.
    ...(input.result.isSimulated ? {} : { bridgeTxHash: input.result.bridgeTxHash }),
    status: "SETTLED_EXTERNALLY",
    evidenceLevel: input.result.evidenceLevel,
    isSimulated: input.result.isSimulated,
  };
  return { ...base, receiptHash: crossChainReceiptHash(base) };
}

// ── the hermetic simulator ─────────────────────────────────────────────────────

/**
 * The offline relayer. Announces itself on every single result.
 *
 * It quotes a fixed fee and slippage so tests are deterministic, and it **never** returns a
 * `bridgeTxHash`. A simulator that returned a plausible-looking hash would let a test assert
 * "a settlement happened" while nothing did — and the hash would be the only thing that
 * looks like evidence in the record.
 */
export class SimulatedPayoutRelayer implements CrossChainPayoutRelayer {
  readonly name = "simulated";

  constructor(private readonly opts: { fee: Money; slippageBps?: number } = { fee: { asset: "USDC", amount: 0.5 } }) {}

  async quoteBridge(input: BridgeQuoteInput): Promise<BridgeQuote> {
    return { bridgeFee: { ...this.opts.fee, asset: input.amount.asset }, slippageBps: this.opts.slippageBps ?? 10 };
  }

  async executeBridgePayout(input: BridgePayoutInput): Promise<BridgePayoutResult> {
    return {
      // No `bridgeTxHash`. Ever.
      recipient: input.recipient,
      amount: input.amount,
      bridgeFee: input.quote.bridgeFee,
      isSimulated: true,
      evidenceLevel: "LOCAL_PASS",
    };
  }
}

// ── the concrete live relayer ───────────────────────────────────────────────────

/**
 * LiFi as the live transport.
 *
 * Chosen for one reason: a single quote/execute API that routes **from Base to both BNB
 * Chain and X Layer**, so the destination set is not "whatever we happen to have deployed
 * on". LiFi is an aggregator — it will route through a bridge we have never audited — which
 * is precisely why the destination chain is pinned by our own registry above and never
 * inferred from the provider's response.
 *
 * **Fails closed.** Without `LIFI_API_KEY` this throws `UNCONFIGURED_RELAYER` rather than
 * returning a zero-fee quote. A bridge adapter that degrades to "free, just send it" when
 * misconfigured is the exact failure this module exists to prevent, and it would be
 * indistinguishable from a real, cheap route in the settlement record.
 */
export class LiFiPayoutRelayer implements CrossChainPayoutRelayer {
  readonly name = "lifi";
  private readonly endpoint: string;

  constructor(
    private readonly opts: {
      apiKey: string | undefined;
      /** The relayer EOA on the SOURCE chain that receives and forwards the funds. */
      integrator: string;
      testnet: boolean;
      endpoint?: string;
      fetchImpl?: typeof fetch;
      /**
       * Broadcasts the transaction the relayer returns, and resolves its hash.
       *
       * Injected rather than held: this class keeps **no signing key**. A bridge adapter
       * with a key is a key at rest in a process that only needs to ask questions, and the
       * caller that owns the signer is already the caller that owns the canonical rail.
       */
      onBroadcast?: (tx: { to: Address; data: `0x${string}`; value: bigint }) => Promise<string>;
    },
  ) {
    if (!opts.apiKey) {
      throw new Error("UNCONFIGURED_RELAYER: LIFI_API_KEY is not set; refusing to quote or bridge");
    }
    this.endpoint = opts.endpoint ?? "https://li.quest/v1";
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        // LiFi authenticates with the key as a bearer token.
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`LIFI_${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async quoteBridge(input: BridgeQuoteInput): Promise<BridgeQuote> {
    const fromChain = this.opts.testnet ? EXTERNAL_CHAIN_IDS_TESTNET_ONLY(input.sourceChain) : SOURCE_CHAIN_IDS[input.sourceChain];
    const toChain = this.opts.testnet ? EXTERNAL_CHAIN_IDS[input.targetChain].testnet : EXTERNAL_CHAIN_IDS[input.targetChain].mainnet;
    const token = TOKENS[input.sourceChain][input.amount.asset];

    const res = await this.call<{
      estimate: { feeCosts?: Array<{ amount: string }>; slippage?: number };
      transactionRequest?: { value: string; gasPrice?: string };
      tool?: string;
    }>("/quote", {
      method: "POST",
      body: JSON.stringify({
        fromChain,
        toChain,
        fromToken: token,
        toToken: token,
        fromAddress: this.opts.integrator,
        toAddress: input.recipient,
        fromAmount: atomic(input.amount.amount, input.amount.asset),
        slippage: Number(MAX_SLIPPAGE_BPS) / 10_000,
      }),
    });

    // LiFi quotes in the token's atomic units. `feeCosts` is the amount that arrives on the
    // far side, NOT the relayer's fee — the difference between sent and received is the fee.
    const received = BigInt(res.estimate?.feeCosts?.[0]?.amount ?? "0");
    const sent = BigInt(atomic(input.amount.amount, input.amount.asset));
    const fee = sent > received ? Number(sent - received) / 10 ** decimalsFor(input.amount.asset) : 0;

    return {
      bridgeFee: { asset: input.amount.asset, amount: fee },
      slippageBps: Math.round((res.estimate?.slippage ?? 0) * 10_000),
    };
  }

  async executeBridgePayout(input: BridgePayoutInput): Promise<BridgePayoutResult> {
    const fromChain = this.opts.testnet ? EXTERNAL_CHAIN_IDS_TESTNET_ONLY(input.sourceChain) : SOURCE_CHAIN_IDS[input.sourceChain];
    const toChain = this.opts.testnet ? EXTERNAL_CHAIN_IDS[input.targetChain].testnet : EXTERNAL_CHAIN_IDS[input.targetChain].mainnet;
    const token = TOKENS[input.sourceChain][input.amount.asset];

    const res = await this.call<{ transaction: { data: string; to: string; value: string; gasLimit?: string }; estimate: { gasCosts?: Array<{ amount: string }>[] } }>(
      "/swap",
      {
        method: "POST",
        body: JSON.stringify({
          fromChain,
          toChain,
          fromToken: token,
          toToken: token,
          fromAddress: this.opts.integrator,
          toAddress: input.recipient,
          fromAmount: atomic(input.amount.amount, input.amount.asset),
          slippage: Number(MAX_SLIPPAGE_BPS) / 10_000,
        }),
      },
    );

    // The relayer must BROADCAST `res.transaction` with its own key. The SDK call is left to
    // the caller via `onBroadcast`, because this class holds no signing key by design — see
    // the `integrator` note in the constructor.
    if (this.opts.onBroadcast) {
      const bridgeTxHash = await this.opts.onBroadcast({
        to: res.transaction.to as Address,
        data: res.transaction.data as `0x${string}`,
        value: BigInt(res.transaction.value ?? "0"),
      });
      return {
        bridgeTxHash,
        recipient: input.recipient,
        amount: input.amount,
        bridgeFee: input.quote.bridgeFee,
        isSimulated: false,
        evidenceLevel: this.opts.testnet ? "TESTNET_PASS" : "LIVE_PUBLIC_PASS",
      };
    }

    throw new Error("UNCONFIGURED_RELAYER: no onBroadcast signer supplied; refusing to report an unbroadcast bridge");
  }
}

// ── chain/token tables ──────────────────────────────────────────────────────────

const SOURCE_CHAIN_IDS: Record<CanonicalChain, number> = { base: 8453, tempo: 42431, solana: 1151111081099710 };

/** Solana has no EIP-155 id; LiFi uses its own sentinel. */
function EXTERNAL_CHAIN_IDS_TESTNET_ONLY(chain: CanonicalChain): number {
  if (chain === "base") return 84532; // Base Sepolia
  throw new Error(`CROSS_CHAIN_TESTNET_UNSUPPORTED: no testnet chain id configured for ${chain}`);
}

const TOKENS: Record<CanonicalChain, Partial<Record<Money["asset"], string>>> = {
  base: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  tempo: {},
  solana: { USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL: "So11111111111111111111111111111111111111112" },
};

function decimalsFor(asset: Money["asset"]): number {
  // Mira's USDC/USDT/SOL are 6-decimal on every rail used here; Tempo's TIP-20s are 6 too.
  return 6;
}

function atomic(amount: number, asset: Money["asset"]): string {
  const d = decimalsFor(asset);
  return (BigInt(Math.round(amount * 10 ** d))).toString();
}
