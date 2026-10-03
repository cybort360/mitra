/**
 * The Solana settlement commitment from atomic units: sha256 over the ABI encoding
 * of the settlement, which `mitra-vault` stores as the permit's `action_hash`.
 *
 * A leaf module (viem only) so that both the adapter (`lib/adapters/solana.ts`,
 * which builds bundles) and the verifier (`lib/evm/evidence.ts`, which re-derives
 * them) can import it without importing each other.
 *
 * ABI strings are length-prefixed, so no field can bleed into its neighbour; the
 * program id and atomic amount are bound, so a commitment for one deployment or one
 * amount cannot authorize another. See `solanaCommitment` for the history.
 */
import { encodeAbiParameters, sha256 } from "viem";

export function solanaCommitmentAtomic(input: {
  settlementId: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  asset: string;
  programId: string;
}): `0x${string}` {
  return sha256(encodeAbiParameters(
    [
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string" }, { type: "string" }, { type: "uint64" }, { type: "string" },
    ],
    [
      "MitraSettlement/v1", "solana", input.programId,
      input.settlementId, input.from, input.to,
      input.amountAtomic, input.asset,
    ],
  ));
}
