/**
 * The on-chain ERC-1271 / ERC-6492 verifier for a signed request's chain.
 *
 * Only contract wallets reach it: an EOA signature is settled by recovery
 * alone, so EOAs need no RPC. A contract wallet on a chain with no configured
 * RPC is refused (verifyDigestSignature reads the throw as ERC1271_CALL_FAILED),
 * never assumed valid.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { RpcSignatureVerifier } from "@/lib/evm/erc1271";
import type { SignatureVerifier } from "@/lib/evm/eip712";

const RPC_ENV_BY_CHAIN_ID: Record<number, "BASE_RPC_URL" | "TEMPO_RPC_URL"> = {
  8453: "BASE_RPC_URL",
  84532: "BASE_RPC_URL",
  4217: "TEMPO_RPC_URL",
  42431: "TEMPO_RPC_URL",
};

export function signatureVerifierFor(chainId: number, env: NodeJS.ProcessEnv = process.env): SignatureVerifier {
  return {
    async isValidSignature(contract, digest, signature) {
      const name = RPC_ENV_BY_CHAIN_ID[chainId];
      const url = name ? env[name] : undefined;
      if (!url) throw new Error(`RPC_NOT_CONFIGURED_FOR_CHAIN:${chainId}`);
      const client = createPublicClient({ transport: http(url) }) as PublicClient;
      return new RpcSignatureVerifier(client).isValidSignature(contract, digest, signature);
    },
  };
}
