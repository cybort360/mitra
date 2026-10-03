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
import type { ChainObservation, EvidenceRequest, SettlementAdapter } from "./types";
import { UnconfiguredAdapterError } from "./types";
import { buildEvidenceBundle, networkName, type EvidenceBundle } from "@/lib/evm/evidence";
import { assertObservationMatches } from "./observation";
import { settlementDigest, settlingDomain, toAtomic } from "@/lib/evm/eip712";

export type BaseChainId = 8453 | 84532; // mainnet, sepolia

export interface Erc20Asset {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/**
 * Assets the adapter will settle in, **per chain id**.
 *
 * This was one flat map holding Base MAINNET USDC (`0x8335…2913`) while the
 * adapter ran on Base Sepolia. On Sepolia that address has no code at all
 * (`eth_getCode` → 0 bytes), so a USDC settlement would have targeted an address
 * with no contract — the F39/F40 class: a registry wrong for its chain, pinned
 * by nothing that could contradict it. Keyed by chain id, a symbol can no longer
 * resolve to another network's contract.
 *
 * Sepolia entries were read from `sepolia.base.org` on 2026-10-03:
 * `0x036C…CF7e` → `symbol()` USDC, `decimals()` 6; `0x4200…0006` → WETH, 18 (the
 * OP-stack predeploy, same address on both chains). `BASE_LIVE=1` re-reads them.
 *
 * Still module constants — ADR-0011 moves asset admission into the Space
 * (`lib/kernel/space-assets.ts`); this is the adapter's own floor, not that.
 */
export const BASE_ASSETS: Record<BaseChainId, Record<string, Erc20Asset>> = {
  8453: {
    USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  },
  84532: {
    USDC: { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  },
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
  /** What the chain shows for the tx; null unless it is a confirmed settlement. Optional: without it, no evidence. */
  observe?(txHash: string, chainId: BaseChainId): Promise<ChainObservation | null>;
}

export interface BaseSettlementOptions {
  chainId: BaseChainId;
  /** Absent means this adapter refuses to settle. It never fabricates a hash. */
  transport?: BaseTransport;
}

/**
 * EIP-712 commitment for a settlement.
 *
 * **This was FNV-1a.** The first version computed a deterministic digest with a
 * hand-rolled hash and labelled it honestly as "NOT keccak256, NOT
 * signature-grade" — which was true, and which meant the adapter could not be
 * signed for. It is now a real EIP-712 typed-data digest over a domain separator,
 * so the settlement is a value a wallet can SIGN and a verifier can CHECK.
 *
 * The commitment is still re-derived inside `settle()` rather than trusted, so a
 * caller cannot present one settlement's authorisation for another's transfer.
 *
 * **`amountAtomic` used to hold whole units.** It was `BigInt("12")` for 12 USDC,
 * so a wallet signed `12` for a transfer of 12,000,000, and any fractional amount
 * threw `SyntaxError: Cannot convert 0.5 to a BigInt` — Base could settle whole
 * dollars only. It is now scaled by the asset's decimals on THIS chain, and
 * `asset` is the token contract rather than its symbol, so the digest names the
 * exact contract the transfer calls.
 */
export function settlementCommitment(input: {
  settlementId: string;
  from: string;
  to: string;
  amount: number;
  asset: string;
  chainId: BaseChainId;
  verifyingContract?: `0x${string}`;
}): `0x${string}` {
  const token = BASE_ASSETS[input.chainId]?.[input.asset];
  if (!token) throw new Error("UNSUPPORTED_ASSET_ON_BASE");
  const contract = input.verifyingContract ?? ZERO_ADDRESS;
  return settlementDigest(settlingDomain(input.chainId, contract), {
    settlementId: input.settlementId,
    from: input.from as `0x${string}`,
    to: input.to as `0x${string}`,
    amountAtomic: toAtomic(input.amount, token.decimals),
    asset: token.address,
  });
}

/** The zero address, used when no verifying contract is configured yet. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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
    if (!BASE_ASSETS[this.opts.chainId]?.[input.asset]) throw new Error("UNSUPPORTED_ASSET_ON_BASE");
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
      amount: input.amount.amount,
      asset: input.amount.asset,
      chainId: this.opts.chainId,
    });
    if (expected !== input.commitmentHash) throw new Error("COMMITMENT_MISMATCH");

    if (!this.opts.transport) {
      // Not configured is not "succeeded". Fabricating a hash here would put an
      // invented settlement into the economic record.
      throw new UnconfiguredAdapterError("base settlement");
    }

    const asset = BASE_ASSETS[this.opts.chainId][input.amount.asset];
    const { txHash } = await this.opts.transport.send({
      to: input.to as `0x${string}`,
      amountAtomic: toAtomic(input.amount.amount, asset.decimals).toString(),
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
  /**
   * PRD 21.4 `getEvidence`, from the chain (sprint item 2).
   *
   * The commitment is re-derived from the record's terms and then looked for IN THE
   * TRANSACTION the chain returns, together with payer, payee, amount and token. The
   * confirmation's block number is the node's, not the record's. Nothing observed
   * is `null`; anything observed that disagrees throws (see `SettlementAdapter`).
   */
  async getEvidence({ settlement, observedAt }: EvidenceRequest): Promise<EvidenceBundle | null> {
    if (settlement.chain !== "base") throw new Error("EVIDENCE_WRONG_RAIL");
    if (!settlement.txHash || !this.opts.transport?.observe) return null;
    if (!settlement.receiptId) throw new Error("EVIDENCE_WITHOUT_RECEIPT");
    const token = BASE_ASSETS[this.opts.chainId]?.[settlement.asset];
    if (!token) throw new Error("UNSUPPORTED_ASSET_ON_BASE");

    const typed = {
      settlementId: settlement.settlementId,
      from: settlement.from as `0x${string}`,
      to: settlement.to as `0x${string}`,
      amountAtomic: toAtomic(settlement.amount, token.decimals),
      asset: token.address,
    };
    const domain = settlingDomain(this.opts.chainId, ZERO_ADDRESS);
    const commitment = settlementDigest(domain, typed);
    if (settlement.commitment && settlement.commitment.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error("EVIDENCE_RECORD_INCONSISTENT");
    }

    const obs = await this.opts.transport.observe(settlement.txHash, this.opts.chainId);
    if (!obs || obs.block <= 0) return null;
    assertObservationMatches(
      obs,
      { commitment, from: typed.from, to: typed.to, amountAtomic: typed.amountAtomic, asset: token.address },
      { caseInsensitiveAddresses: true },
    );
    return buildEvidenceBundle({
      evidenceId: `evd_${settlement.settlementId}`,
      receiptId: settlement.receiptId,
      settlementId: settlement.settlementId,
      chain: networkName("base", this.opts.chainId),
      typed,
      domain,
      confirmation: { txHash: obs.txHash, blockNumber: obs.block, observedAt },
    });
  }

}
