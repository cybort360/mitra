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
import type { ChainObservation, EvidenceRequest, SettlementAdapter } from "./types";
import { UnconfiguredAdapterError } from "./types";
import { buildSolanaEvidenceBundle, networkName, type EvidenceBundle } from "@/lib/evm/evidence";
import { assertObservationMatches } from "./observation";

import { toAtomic } from "@/lib/evm/eip712";
import { VAULT_PROGRAM_ID } from "@/lib/solana/vault-program";
import { solanaCommitmentAtomic } from "@/lib/solana/commitment";

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
  /** What the chain shows for the tx; null unless it is a confirmed settlement. Optional: without it, no evidence. */
  observe?(txHash: string): Promise<ChainObservation | null>;
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
   * PRD 21.4 `getEvidence`, from the chain (sprint item 2). Same contract as the
   * EVM adapters; the commitment is the permit's `action_hash`, and the bundle uses
   * the Solana scheme because EIP-712 has no meaning on this rail.
   */
  async getEvidence({ settlement, observedAt }: EvidenceRequest): Promise<EvidenceBundle | null> {
    if (settlement.chain !== "solana") throw new Error("EVIDENCE_WRONG_RAIL");
    if (!settlement.txHash || !this.opts.transport?.observe) return null;
    if (!settlement.receiptId) throw new Error("EVIDENCE_WITHOUT_RECEIPT");
    const asset = SOLANA_ASSETS[settlement.asset];
    if (!asset) throw new Error("UNSUPPORTED_ASSET_ON_SOLANA");

    const typed = {
      settlementId: settlement.settlementId,
      from: settlement.from,
      to: settlement.to,
      amountAtomic: toAtomic(settlement.amount, asset.decimals),
      asset: settlement.asset,
      programId: VAULT_PROGRAM_ID.toBase58(),
    };
    const commitment = solanaCommitmentAtomic(typed);
    if (settlement.commitment && settlement.commitment.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error("EVIDENCE_RECORD_INCONSISTENT");
    }

    const obs = await this.opts.transport.observe(settlement.txHash);
    if (!obs || obs.block <= 0) return null;
    // Base58 is case-sensitive: addresses are compared exactly.
    assertObservationMatches(
      obs,
      { commitment, from: typed.from, to: typed.to, amountAtomic: typed.amountAtomic, asset: null },
      { caseInsensitiveAddresses: false },
    );
    return buildSolanaEvidenceBundle({
      evidenceId: `evd_${settlement.settlementId}`,
      receiptId: settlement.receiptId,
      settlementId: settlement.settlementId,
      chain: networkName("solana"),
      typed,
      confirmation: { txHash: obs.txHash, blockNumber: obs.block, observedAt },
    });
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
  return solanaCommitmentAtomic({
    settlementId: input.settlementId, from: input.from, to: input.to,
    amountAtomic: toAtomic(input.amount.amount, asset.decimals), asset: input.amount.asset,
    programId: input.programId ?? VAULT_PROGRAM_ID.toBase58(),
  });
}

export { solanaCommitmentAtomic };
