/**
 * The on-chain `SignatureVerifier` (ERC-1271, PRD P0; ERC-6492, PRD P1) — sprint
 * item 3.
 *
 * `verifyAuthorisation` (lib/evm/eip712.ts) has always routed contract-wallet
 * signatures through a `SignatureVerifier`, but no implementation existed, so the
 * contract path had only ever met a test stub. This one asks the chain.
 *
 * ## Two cases
 *
 * - **Deployed account (ERC-1271):** `isValidSignature(digest, signature)` is called
 *   on the account itself, and its return value is passed back UNCHANGED.
 *   `verifyAuthorisation` compares it with the magic value, so a contract answering
 *   anything else — or reverting — is refused there, not reinterpreted here.
 * - **Counterfactual account (ERC-6492):** an account that does not exist yet has no
 *   `isValidSignature` to call. A 6492 signature carries the factory call that would
 *   deploy it; viem's `verifyHash` runs that deployment and the 1271 check together
 *   in a single `eth_call` (the universal validator), which changes no state. Only a
 *   signature carrying the 6492 magic suffix takes this path.
 *
 * A signature from an undeployed account WITHOUT the 6492 wrapper calls an address
 * with no code; viem throws, and `verifyAuthorisation` reports `ERC1271_CALL_FAILED`.
 */

import { parseAbi, type PublicClient } from "viem";
import { ERC1271_MAGIC_VALUE, type SignatureVerifier } from "./eip712";

const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/** ERC-6492's magic suffix: the last 32 bytes of a wrapped signature. */
export const ERC6492_MAGIC_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

export const isErc6492Signature = (signature: `0x${string}`) => signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX);

/** Returned for a 6492 signature the universal validator rejected. Not the magic value. */
export const ERC6492_INVALID = "0xffffffff";

export class RpcSignatureVerifier implements SignatureVerifier {
  constructor(private readonly client: PublicClient) {}

  async isValidSignature(contract: `0x${string}`, digest: `0x${string}`, signature: `0x${string}`): Promise<string> {
    if (isErc6492Signature(signature)) {
      const ok = await this.client.verifyHash({ address: contract, hash: digest, signature });
      return ok ? ERC1271_MAGIC_VALUE : ERC6492_INVALID;
    }
    return this.client.readContract({
      address: contract,
      abi: ERC1271_ABI,
      functionName: "isValidSignature",
      args: [digest, signature],
    });
  }
}
