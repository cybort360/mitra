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
import type { EvidenceBundle } from "@/lib/evm/evidence";
import { encodeAbiParameters, sha256 } from "viem";
import { toAtomic } from "@/lib/evm/eip712";
import { VAULT_PROGRAM_ID } from "@/lib/solana/vault-program";

/**
 * What this adapter can settle: native SOL, and only SOL.
 *
 * Settlement on Solana is `spend_authorized` on `mitra-vault`, and that handler
 * moves LAMPORTS. This registry used to list `USDC` at
 * `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` — the MAINNET SPL mint, which the
 * vault has no instruction to move on any cluster — and `SOL` at the wrapped-SOL
 * SPL mint, which is a token account, not lamports. An adapter that accepted USDC
 * would have validated a settlement no instruction could execute. `mint: null`
 * means native lamports.
 */
export const SOLANA_ASSETS: Record<string, { symbol: string; mint: null; decimals: number }> = {
  SOL: { symbol: "SOL", mint: null, decimals: 9 },
};

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface SolanaTransport {
  send(input: {
    /** The vault the capital leaves. The transport checks it against the mandate on chain. */
    from: string;
    to: string;
    amountAtomic: string;
    mint: string | null;
    /** 32-byte hex. Becomes the program's `action_hash`, binding the permit to this settlement. */
    commitment: string;
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
      from: input.from,
      to: input.to,
      amountAtomic: toAtomic(input.amount.amount, asset.decimals).toString(),
      mint: asset.mint,
      commitment: input.commitmentHash,
    });
    return { txHash, evidenceLevel: "LOCAL_PASS" as EvidenceLevel };
  }

  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    if (!this.opts.transport) return { confirmed: false };
    return this.opts.transport.verify(txHash);
  }
  /**
   * PRD 21.4 `getEvidence`. Returns null rather than a bundle assembled from
   * nothing: a bundle with no observed chain behind it is indistinguishable from
   * one that watched a transfer, and the counterparty has no way to tell.
   */
  async getEvidence(_ref: { settlementId: string }): Promise<EvidenceBundle | null> {
    return null;
  }

}

/**
 * The settlement commitment, and the program's `action_hash` for it.
 *
 * **This was FNV-1a over a `|`-joined string, repeated eight times to look like 32
 * bytes.** It had 32 bits of entropy, so a second settlement colliding with a
 * permit's action was a birthday search away, and the join was ambiguous: a
 * settlement id containing `|` could shift fields (the F45 class). Neither
 * mattered while nothing consumed it. It now becomes the `action_hash` that
 * single-use permits are keyed by on chain, so it has to be a real digest.
 *
 * sha256 over the ABI encoding of the fields: ABI strings are length-prefixed, so
 * no field can bleed into its neighbour, and viem's encoder is the one the EVM
 * rails already use. The program id and the atomic amount are bound, so a
 * commitment for one deployment or one amount cannot authorize another.
 */
export function solanaCommitment(input: {
  settlementId: string;
  from: string;
  to: string;
  amount: Money;
  programId?: string;
}): `0x${string}` {
  const asset = SOLANA_ASSETS[input.amount.asset];
  if (!asset) throw new Error("UNSUPPORTED_ASSET_ON_SOLANA");
  return sha256(encodeAbiParameters(
    [
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string" }, { type: "string" }, { type: "uint64" }, { type: "string" },
    ],
    [
      "MitraSettlement/v1", "solana", input.programId ?? VAULT_PROGRAM_ID.toBase58(),
      input.settlementId, input.from, input.to,
      toAtomic(input.amount.amount, asset.decimals), input.amount.asset,
    ],
  ));
}
