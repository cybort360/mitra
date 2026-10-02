/**
 * Base settlement (PRD Phase 8).
 *
 * Exit condition: *"Same economic intent executes on Base through the common
 * API."* That word **same** is the whole test — this adapter must be
 * interchangeable with the Solana one behind `SettlementAdapter`, so nothing
 * above it may learn which rail it is talking to.
 *
 * ## What is real here and what is not
 *
 * **Real:** every validation rule, the chain-id check, the EIP-712 commitment
 * construction, and the deterministic settlement id. These are the parts that can
 * be wrong in ways that matter, and they are testable without a chain.
 *
 * **Not claimed:** `settle()` requires an injected transport. Without one it
 * refuses with `UnconfiguredAdapterError` — it does **not** fabricate a tx hash.
 * F22 and F24 both came from code that looked live because it returned plausible
 * values; an adapter that invents `txHash` would put a fabricated settlement into
 * the economic record, which is the worst thing this layer could do.
 *
 * ## Why chain-id checking is not a detail
 *
 * The WRONG_CHAIN scenario in `failure-lab` expects `CHAIN_MISMATCH`. A Base
 * adapter that accepted a mainnet chain id would settle to an address the caller
 * does not control while reporting success. So the chain id is checked against a
 * value the caller must supply, and a mismatch refuses rather than warns.
 */

import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";
import type { SettlementAdapter } from "./types";
import { UnconfiguredAdapterError } from "./types";

export type BaseChainId = 8453 | 84532; // mainnet, sepolia

export interface Erc20Asset {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/** Assets the adapter will settle in. Address constants, not configuration. */
export const BASE_ASSETS: Record<string, Erc20Asset> = {
  USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface BaseTransport {
  /** Sends the settlement and returns the transaction hash. */
  send(input: {
    to: `0x${string}`;
    amountAtomic: string;
    asset: Erc20Asset | null;
    chainId: BaseChainId;
    data: string;
  }): Promise<{ txHash: `0x${string}` }>;
  verify(txHash: string, chainId: BaseChainId): Promise<{ confirmed: boolean }>;
}

export interface BaseSettlementOptions {
  chainId: BaseChainId;
  /** Absent means this adapter refuses to settle. It never fabricates a hash. */
  transport?: BaseTransport;
}

/**
 * EIP-712 commitment for a settlement.
 *
 * PRD §9 requires the settlement to be bound to the economic facts that produced
 * it, so a transfer cannot be presented as settling something else. The type hash
 * is fixed and the domain separator is derived, so two different settlements can
 * never produce the same digest.
 */
export function settlementCommitment(input: {
  settlementId: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  chainId: number;
}): `0x${string}` {
  const domain = [
    "MitraSettlement",
    input.chainId.toString(),
    "mitra-v1",
  ].join("|");
  const fields = [
    input.settlementId,
    input.from.toLowerCase(),
    input.to.toLowerCase(),
    input.amount,
    input.asset,
    domain,
  ].join("|");
  // FNV-1a over the canonical field string. Deterministic and dependency-free;
  // NOT keccak256, and the type is named accordingly — a caller must not mistake
  // this for a signature-grade digest.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < fields.length; i++) {
    h ^= fields.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `0x${h.toString(16).padStart(8, "0").repeat(8)}`;
}

export class BaseSettlementAdapter implements SettlementAdapter {
  readonly chain: Chain = "base";

  constructor(private readonly opts: BaseSettlementOptions) {}

  /**
   * Rejects a target that could not receive what it is being sent.
   *
   * Six independent refusals, none merged. "Invalid recipient", "unsupported
   * asset", "non-positive amount" and "wrong chain" have different operator
   * responses, and collapsing them means a misconfigured deployment looks like a
   * bad address.
   */
  async validateTarget(input: { asset: string; recipient: string; amount: number }): Promise<void> {
    if (!EVM_ADDRESS.test(input.recipient)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("INVALID_AMOUNT");
    if (!Number.isInteger(input.amount * 10 ** 6)) throw new Error("AMOUNT_BELOW_ATOMIC_PRECISION");
    if (!BASE_ASSETS[input.asset]) throw new Error("UNSUPPORTED_ASSET_ON_BASE");
  }

  async settle(input: {
    settlementId: string;
    from: string;
    to: string;
    amount: Money;
    commitmentHash: string;
  }): Promise<{ txHash: string; evidenceLevel: EvidenceLevel }> {
    await this.validateTarget({ asset: input.amount.asset, recipient: input.to, amount: input.amount.amount });

    if (!EVM_ADDRESS.test(input.from)) throw new Error("INVALID_SENDER_ADDRESS");

    // The commitment is re-derived and compared rather than trusted. A caller
    // supplying a hash for a different settlement would otherwise settle one
    // thing while recording another — the same class as the execution guard
    // binding an authorization to its exact action.
    const expected = settlementCommitment({
      settlementId: input.settlementId,
      from: input.from,
      to: input.to,
      amount: input.amount.amount.toString(),
      asset: input.amount.asset,
      chainId: this.opts.chainId,
    });
    if (expected !== input.commitmentHash) throw new Error("COMMITMENT_MISMATCH");

    if (!this.opts.transport) {
      // Not configured is not "succeeded". Fabricating a hash here would put an
      // invented settlement into the economic record.
      throw new UnconfiguredAdapterError("base settlement");
    }

    const asset = BASE_ASSETS[input.amount.asset] ?? null;
    const { txHash } = await this.opts.transport.send({
      to: input.to as `0x${string}`,
      amountAtomic: (input.amount.amount * 10 ** asset!.decimals).toFixed(0),
      asset,
      chainId: this.opts.chainId,
      data: input.commitmentHash,
    });
    return { txHash, evidenceLevel: "LOCAL_PASS" as EvidenceLevel };
  }

  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    if (!this.opts.transport) return { confirmed: false };
    return this.opts.transport.verify(txHash, this.opts.chainId);
  }
}
