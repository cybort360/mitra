#!/usr/bin/env node
/**
 * Deploy MitraVault.sol to Base Sepolia and Tempo Moderato.
 *
 * Uses viem rather than `forge create` because the rest of this repository's EVM
 * tooling is viem, and one signing path is easier to audit than two.
 *
 * The addresses land in `lib/evm/deployments.json`, which is where the adapters
 * and the live tests read them. That file is COMMITTED so a deployed address is
 * reproducible rather than a note in someone's shell history.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const OUT = "lib/evm/deployments.json";
const ART = "out/MitraVault.sol/MitraVault.json";

const CHAINS = {
  baseSepolia: { id: 84532, name: "baseSepolia", rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
  moderato:    { id: 42431, name: "moderato",    rpc: process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz" },
};

async function main() {
  const only = process.argv[2];
  const artifact = JSON.parse(readFileSync(ART, "utf8"));
  const bytecode = artifact.bytecode.object;
  if (!bytecode || bytecode === "0x") throw new Error(`no bytecode in ${ART} — run forge build first`);

  const pk = readFileSync(".dev-keys/evm-testnet.key", "utf8").trim();
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);

  let saved = {};
  try { saved = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }

  for (const [key, cfg] of Object.entries(CHAINS)) {
    if (only && only !== key) continue;
    const pub = createPublicClient({ chain: { id: cfg.id, name: cfg.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } }, transport: http(cfg.rpc) });
    const bal = await pub.getBalance({ address: account.address });
    console.log(`\n=== ${key} (${cfg.id}) ===`);
    console.log(`  deployer ${account.address}`);
    console.log(`  balance  ${bal} wei (${Number(bal) / 1e18} ETH)`);
    if (bal === 0n) { console.log("  SKIP: no gas"); continue; }

    const wallet = createWalletClient({ account, chain: pub.chain, transport: http(cfg.rpc) });
    const before = await pub.getBytecode({ address: account.address }).catch(() => undefined);
    if (before) { console.log("  SKIP: address already has code (idempotent)"); continue; }

    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, chain: pub.chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") { console.log(`  FAILED: status ${rc.status}`); continue; }
    console.log(`  deployed  ${rc.contractAddress}`);
    console.log(`  tx        ${hash}`);
    console.log(`  block     ${rc.blockNumber}`);
    saved[key] = { chainId: cfg.id, address: rc.contractAddress, deployTx: hash, deployBlock: Number(rc.blockNumber), deployedAt: new Date().toISOString() };
  }

  writeFileSync(OUT, JSON.stringify(saved, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
