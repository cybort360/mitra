/**
 * Where a card lives, per chain, from the repository's own registries — never retyped:
 * the vault from lib/evm/deployments.json (`deployedVault`), the token from the adapters'
 * asset tables. And the chain reader card sync uses, over the RPC this engine is
 * configured with.
 */
import { createPublicClient, defineChain, http, parseAbi, type Chain as ViemChain } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_ASSETS } from "@/lib/adapters/base";
import { TEMPO_CHAIN_IDS, TEMPO_TOKENS } from "@/lib/adapters/tempo";
import { deployedVault } from "@/lib/settlement/rails";
import type { CardChain, CardNetwork, CardReader } from "./card-sync";

const VAULT_READS = parseAbi([
  "function mandates(address principal, address holder, address token) view returns (address principal, address holder, uint64 limit, uint64 ceiling, uint64 spent, uint64 expiresAt, uint32 version, address policyEngine, bool revoked)",
  "function vaults(address principal, address token) view returns (uint256 total, uint256 available, uint256 reserved, uint256 escrowed, uint256 encumbered, uint256 settling, uint256 frozen, bool emergencyFreeze)",
]);

const tempoModerato = (rpc: string) => defineChain({
  id: TEMPO_CHAIN_IDS.moderato, name: "Tempo Moderato",
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [rpc] } },
});

export function cardNetwork(
  chain: CardChain,
  env: Record<string, string | undefined> = process.env,
): { network: CardNetwork; viemChain: ViemChain; rpc: string } | { missing: string } {
  if (chain === "base") {
    if (!env.BASE_RPC_URL) return { missing: "BASE_RPC_URL" };
    const usdc = BASE_ASSETS[84532].USDC;
    return {
      network: { chainId: 84532, vault: deployedVault(84532), token: usdc.address as `0x${string}`, asset: "USDC", decimals: usdc.decimals },
      viemChain: baseSepolia,
      rpc: env.BASE_RPC_URL,
    };
  }
  if (!env.TEMPO_RPC_URL) return { missing: "TEMPO_RPC_URL" };
  const path = TEMPO_TOKENS.PathUSD;
  return {
    network: { chainId: TEMPO_CHAIN_IDS.moderato, vault: deployedVault(TEMPO_CHAIN_IDS.moderato), token: path.mint, asset: "PathUSD", decimals: path.decimals },
    viemChain: tempoModerato(env.TEMPO_RPC_URL),
    rpc: env.TEMPO_RPC_URL,
  };
}

export function rpcCardReader(network: CardNetwork, viemChain: ViemChain, rpc: string): CardReader {
  const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
  return {
    async mandate(principal, holder) {
      const [p, , limit, ceiling, spent, expiresAt, version, policyEngine, revoked] = await client.readContract({
        address: network.vault, abi: VAULT_READS, functionName: "mandates", args: [principal, holder, network.token],
      });
      return { principal: p, limit, ceiling, spent, expiresAt, version: Number(version), policyEngine, revoked };
    },
    async position(principal) {
      const [total, available, reserved, escrowed, encumbered, settling, frozen, emergencyFreeze] = await client.readContract({
        address: network.vault, abi: VAULT_READS, functionName: "vaults", args: [principal, network.token],
      });
      return { total, available, reserved, escrowed, encumbered, settling, frozen, emergencyFreeze };
    },
  };
}
