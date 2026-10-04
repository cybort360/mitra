/**
 * Settlement rails: one configured `SettlementAdapter` per chain, plus what a
 * caller needs to drive it (the account it debits, and the rail's commitment).
 *
 * ## Configured from the environment, or absent
 *
 * A rail with no configuration is ABSENT, not stubbed. `settle-agreement.ts` maps
 * an absent rail to `SETTLEMENT_RAIL_NOT_CONFIGURED` before anything is claimed or
 * consumed, so an unconfigured deployment refuses honestly rather than settling
 * into a fake transport. There is no dev transport here and there must not be one.
 *
 * Testnets only. Each rail pins its network (Base Sepolia 84532, Tempo Moderato,
 * Solana devnet program) rather than reading a chain id from the environment, so a
 * mainnet RPC URL in the wrong variable cannot turn this into a mainnet payer: the
 * adapters check chain ids and commitments bind them.
 *
 * Signing on testnet uses the relayer key (lead, seq 55). With
 * `MITRA_BASE_SETTLEMENT_ACCOUNT=erc4337` the Base payer is instead a smart account
 * (Coinbase Smart Wallet) owned by that key, settling through UserOperations the
 * relayer submits to the EntryPoint (`base-4337-transport.ts`) — the production
 * Phase 8 shape. Its address is read from the factory, which is why building the
 * rails is async.
 *
 * | Rail   | Variables |
 * |--------|-----------|
 * | base   | `MITRA_EVM_SETTLEMENT_KEY_FILE`, `BASE_RPC_URL`; optional `MITRA_BASE_SETTLEMENT_ACCOUNT=erc4337\|vault` |
 * | tempo  | `MITRA_EVM_SETTLEMENT_KEY_FILE`, `TEMPO_RPC_URL`; optional `MITRA_TEMPO_SETTLEMENT_ACCOUNT=vault` |
 *
 * `vault` (package B.4) pays THROUGH the deployed canonical v2 `contracts/MitraVault.sol`
 * (`lib/evm/deployments.json`, the chain's non-`__` entry): the key is principal, mandate engine and relayer on
 * testnet; `MITRA_EVM_VAULT_HOLDER` names the agent holding the mandate. The payer is
 * the principal whose vault position pays.
 * | solana | `SOLANA_RPC_URL`, `MITRA_SOLANA_ENGINE_KEY_FILE`, `MITRA_SOLANA_HOLDER`, `MITRA_SOLANA_VAULT` |
 */

import { existsSync, readFileSync } from "node:fs";
import { defineChain, http, type Chain as ViemChain } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";
import type { SettlementAdapter } from "@/lib/adapters/types";
import { BASE_ASSETS, BaseSettlementAdapter, settlementCommitment, type BaseTransport } from "@/lib/adapters/base";
import { BaseRpcTransport } from "@/lib/adapters/base-transport";
import { Erc4337Transport } from "@/lib/adapters/base-4337-transport";
import { TEMPO_CHAIN_IDS, TEMPO_TOKENS, TempoSettlementAdapter, tempoCommitment } from "@/lib/adapters/tempo";
import { MitraVaultTransport } from "@/lib/adapters/evm-vault-transport";
import { networkName } from "@/lib/evm/evidence";
import { ModeratoTransport, createTempoRpc } from "@/lib/adapters/tempo-transport";
import { SolanaSettlementAdapter, solanaCommitment } from "@/lib/adapters/solana";
import { VaultTransport, connectionRpc } from "@/lib/adapters/solana-transport";

export interface CommitmentInput {
  settlementId: string;
  from: string;
  to: string;
  amount: Money;
}

export interface SettlementRail {
  readonly chain: Chain;
  readonly adapter: SettlementAdapter;
  /**
   * The on-chain account this rail debits. A Mitra vault may use the rail only if
   * its recorded `address` is this account; otherwise the vault record and the
   * money would describe different accounts.
   */
  readonly payer: string;
  /** The commitment `adapter.settle` re-derives and requires. */
  commitment(input: CommitmentInput): string;
  /** The evidence level a settlement confirmed on this rail has earned. */
  readonly confirmedEvidence: EvidenceLevel;
  /** The network, from the chain id (`networkName`): what receipts and evidence bundles name. */
  readonly network: string;
}

export type Rails = Partial<Record<Chain, SettlementRail>>;

const BASE_SEPOLIA = 84532 as const;

function readEvmKey(path: string) {
  return privateKeyToAccount(`0x${readFileSync(path, "utf8").trim().replace(/^0x/, "")}`);
}

/** Builds whichever rails the environment fully configures. A partial config builds nothing. */
export async function railsFromEnv(env: Record<string, string | undefined> = process.env): Promise<Rails> {
  const rails: Rails = {};

  if (env.MITRA_EVM_SETTLEMENT_KEY_FILE && env.BASE_RPC_URL) {
    const account = readEvmKey(env.MITRA_EVM_SETTLEMENT_KEY_FILE);
    const mode = env.MITRA_BASE_SETTLEMENT_ACCOUNT ?? "eoa";
    if (mode !== "eoa" && mode !== "erc4337" && mode !== "vault") throw new Error(`MITRA_BASE_SETTLEMENT_ACCOUNT must be eoa, erc4337 or vault, not ${mode}`);
    let transport: BaseTransport;
    let payer: string;
    if (mode === "vault") {
      const v = vaultTransport(env, account, baseSepolia, http(env.BASE_RPC_URL), Object.values(BASE_ASSETS[BASE_SEPOLIA]).map((a) => a.address), 1n);
      transport = v.asBaseTransport(BASE_SEPOLIA);
      payer = account.address;
    } else if (mode === "erc4337") {
      const t = new Erc4337Transport({ owner: account, relayer: account, chainId: BASE_SEPOLIA, transport: http(env.BASE_RPC_URL) });
      transport = t;
      payer = (await t.account()).address;
    } else {
      transport = new BaseRpcTransport({ account, chainId: BASE_SEPOLIA, transport: http(env.BASE_RPC_URL) });
      payer = account.address;
    }
    rails.base = {
      chain: "base",
      adapter: new BaseSettlementAdapter({ chainId: BASE_SEPOLIA, transport }),
      payer,
      commitment: (i) => settlementCommitment({
        settlementId: i.settlementId, from: i.from, to: i.to,
        amount: i.amount.amount, asset: i.amount.asset, chainId: BASE_SEPOLIA,
      }),
      confirmedEvidence: "TESTNET_PASS",
      network: networkName("base", BASE_SEPOLIA),
    };
  }

  if (env.MITRA_EVM_SETTLEMENT_KEY_FILE && env.TEMPO_RPC_URL) {
    const account = readEvmKey(env.MITRA_EVM_SETTLEMENT_KEY_FILE);
    const mode = env.MITRA_TEMPO_SETTLEMENT_ACCOUNT ?? "eoa";
    if (mode !== "eoa" && mode !== "vault") throw new Error(`MITRA_TEMPO_SETTLEMENT_ACCOUNT must be eoa or vault, not ${mode}`);
    const transport = mode === "vault"
      // Tempo's eth_gasPrice lags the effective price; 2x as scripts/tempo-pay.mjs does.
      ? vaultTransport(env, account, tempoModerato(env.TEMPO_RPC_URL), http(env.TEMPO_RPC_URL), Object.values(TEMPO_TOKENS).map((t) => t.mint), 2n).asTempoTransport()
      : new ModeratoTransport({ rpc: createTempoRpc({ url: env.TEMPO_RPC_URL }), account });
    rails.tempo = {
      chain: "tempo",
      adapter: new TempoSettlementAdapter({ network: "moderato", transport }, tempoCommitment),
      payer: account.address,
      commitment: (i) => tempoCommitment({ ...i, network: "moderato" }),
      confirmedEvidence: "TESTNET_PASS",
      network: networkName("tempo", TEMPO_CHAIN_IDS.moderato),
    };
  }

  if (env.SOLANA_RPC_URL && env.MITRA_SOLANA_ENGINE_KEY_FILE && env.MITRA_SOLANA_HOLDER && env.MITRA_SOLANA_VAULT) {
    const engine = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(env.MITRA_SOLANA_ENGINE_KEY_FILE, "utf8")) as number[]),
    );
    rails.solana = {
      chain: "solana",
      adapter: new SolanaSettlementAdapter({
        transport: new VaultTransport({
          rpc: connectionRpc(new Connection(env.SOLANA_RPC_URL, "confirmed")),
          engine,
          holder: new PublicKey(env.MITRA_SOLANA_HOLDER),
        }),
      }),
      payer: env.MITRA_SOLANA_VAULT,
      commitment: (i) => solanaCommitment(i),
      confirmedEvidence: "TESTNET_PASS",
      network: networkName("solana"),
    };
  }

  return rails;
}

/**
 * The CANONICAL MitraVault (v2) for a chain, from lib/evm/deployments.json — or a
 * refusal. The file is keyed by network name (`baseSepolia`, `moderato`); entries whose
 * key carries a `__` suffix (e.g. `__callerVariant`) are other deployments kept for the
 * record and are never chosen, because their ABI is not the one this transport speaks.
 */
function deployedVault(chainId: number): `0x${string}` {
  const file = "lib/evm/deployments.json";
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, { chainId?: number; address?: string }>) : {};
  const hit = Object.entries(all).find(([key, v]) => !key.includes("__") && v.chainId === chainId && v.address);
  if (!hit) throw new Error(`NO_MITRA_VAULT_DEPLOYED_ON_${chainId}: run scripts/deploy-evm-vault.mjs`);
  return hit[1].address as `0x${string}`;
}

function vaultTransport(
  env: Record<string, string | undefined>, account: ReturnType<typeof readEvmKey>, chain: ViemChain,
  transport: ReturnType<typeof http>, tokens: string[], gasPriceMultiplier: bigint,
): MitraVaultTransport {
  if (!env.MITRA_EVM_VAULT_HOLDER) throw new Error("MITRA_EVM_VAULT_HOLDER is required for a vault rail");
  return new MitraVaultTransport({
    chain, vault: deployedVault(chain.id), principal: account.address, holder: env.MITRA_EVM_VAULT_HOLDER as `0x${string}`,
    engine: account, relayer: account, tokens: new Set(tokens.map((t) => t.toLowerCase())), transport, gasPriceMultiplier,
  });
}

const tempoModerato = (rpc: string) => defineChain({
  id: TEMPO_CHAIN_IDS.moderato, name: "Tempo Moderato",
  nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [rpc] } },
});

declare global {
  // eslint-disable-next-line no-var
  var __mitraRails: Promise<Rails> | undefined;
}

/** The rails for this process, built once from the environment. */
export function getRails(): Promise<Rails> {
  globalThis.__mitraRails ??= railsFromEnv();
  return globalThis.__mitraRails;
}

/**
 * Replace the rails for a test. A test that injects a rail supplies its own
 * transport and its own `confirmedEvidence` — the production registry above never
 * contains one. `null` restores environment-built rails on next use.
 */
export function __setRailsForTests(rails: Rails | null): void {
  globalThis.__mitraRails = rails ? Promise.resolve(rails) : undefined;
}
