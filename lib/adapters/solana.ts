/**
 * Solana settlement (the counterpart to `base.ts`).
 *
 * Exists so Phase 8's exit condition is *testable* rather than asserted. "Same
 * economic intent executes through the common API" is a claim about two
 * implementations being interchangeable behind `SettlementAdapter`; with only one
 * real adapter there is nothing to compare, and the claim would be unfalsifiable.
 *
 * Deliberately shaped like the Base one — same refusal vocabulary, same
 * commitment re-derivation, same refusal to fabricate a hash without a
 * transport. The differences that remain are the ones the chains actually have
 * (address format, atomic unit, asset registry), and nothing above the adapter
 * may depend on which of them applies.
 */

import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";
import type { SettlementAdapter } from "./types";
import { UnconfiguredAdapterError } from "./types";

/** Solana SPL token mints. Registry, not configuration. */
export const SOLANA_ASSETS: Record<string, { symbol: string; mint: string; decimals: number }> = {
  USDC: { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  SOL: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9 },
};

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface SolanaTransport {
  send(input: {
    to: string;
    amountAtomic: string;
    mint: string | null;
    signature: string;
  }): Promise<{ txHash: string }>;
  verify(txHash: string): Promise<{ confirmed: boolean }>;
}

export interface SolanaSettlementOptions {
  transport?: SolanaTransport;
}

export class SolanaSettlementAdapter implements SettlementAdapter {
  readonly chain: Chain = "solana";

  constructor(private readonly opts: SolanaSettlementOptions = {}) {}

  async validateTarget(input: { asset: string; recipient: string; amount: number }): Promise<void> {
    if (!SOLANA_ADDRESS.test(input.recipient)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("INVALID_AMOUNT");
    if (!Number.isInteger(input.amount * 10 ** 6)) throw new Error("AMOUNT_BELOW_ATOMIC_PRECISION");
    if (!SOLANA_ASSETS[input.asset]) throw new Error("UNSUPPORTED_ASSET_ON_SOLANA");
  }

  async settle(input: {
    settlementId: string;
    from: string;
    to: string;
    amount: Money;
    commitmentHash: string;
  }): Promise<{ txHash: string; evidenceLevel: EvidenceLevel }> {
    await this.validateTarget({ asset: input.amount.asset, recipient: input.to, amount: input.amount.amount });
    if (!SOLANA_ADDRESS.test(input.from)) throw new Error("INVALID_SENDER_ADDRESS");

    const expected = solanaCommitment(input);
    if (expected !== input.commitmentHash) throw new Error("COMMITMENT_MISMATCH");

    if (!this.opts.transport) throw new UnconfiguredAdapterError("solana settlement");

    const asset = SOLANA_ASSETS[input.amount.asset];
    const { txHash } = await this.opts.transport.send({
      to: input.to,
      amountAtomic: (input.amount.amount * 10 ** asset.decimals).toFixed(0),
      mint: asset.mint,
      signature: input.commitmentHash,
    });
    return { txHash, evidenceLevel: "LOCAL_PASS" as EvidenceLevel };
  }

  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    if (!this.opts.transport) return { confirmed: false };
    return this.opts.transport.verify(txHash);
  }
}

/** Same construction as the Base commitment, namespaced by chain. */
export function solanaCommitment(input: {
  settlementId: string;
  from: string;
  to: string;
  amount: Money;
  commitmentHash?: string;
}): string {
  const fields = [
    "MitraSettlement",
    "solana",
    "mitra-v1",
    input.settlementId,
    input.from,
    input.to,
    input.amount.amount.toString(),
    input.amount.asset,
  ].join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < fields.length; i++) {
    h ^= fields.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `0x${h.toString(16).padStart(8, "0").repeat(8)}`;
}
