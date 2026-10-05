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
import { createPublicClient, createWalletClient, http, toFunctionSelector } from "viem";
import { baseSepolia } from "viem/chains";

const OUT = "lib/evm/deployments.json";
/** Bump when a deployment of an earlier source must not be reused. */
const REVISION = "F61";
/** F61's token-keyed mandate getter: present in the F61 source, absent before it. */
const F61_SELECTOR = toFunctionSelector("mandates(address,address,address)").slice(2);
const ART = "out/MitraVault.sol/MitraVault.json";

const CHAINS = {
  baseSepolia: { id: 84532, name: "baseSepolia", rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
  moderato:    { id: 42431, name: "moderato",    rpc: process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz" },
};

/**
 * Runtime code equals the artifact once immutables are masked: the compiler
 * leaves zero placeholders at `immutableReferences`, and the constructor fills
 * them (e.g. the cached EIP-712 domain separator, which embeds chain and address).
 */
function matchesArtifact(code, deployed) {
  let onChain = code.toLowerCase().slice(2);
  for (const ranges of Object.values(deployed.immutableReferences ?? {})) {
    for (const { start, length } of ranges) onChain = onChain.slice(0, start * 2) + "00".repeat(length) + onChain.slice((start + length) * 2);
  }
  return onChain === deployed.object.toLowerCase().slice(2);
}

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

    // F63: the previous "F61" deployment ran pre-F61 bytecode. An entry is kept,
    // labelled, under vaultSuperseded (no chainId, so no rail treats it as canonical).
    if (saved[key]?.address && saved[key].revision !== REVISION) {
      saved.vaultSuperseded ??= [];
      saved.vaultSuperseded.push({ network: key, ...saved[key], supersededAt: new Date().toISOString(),
        reason: "F63: runtime code was pre-F61 (2-key mandates); see forge/FAILURES.md" });
      console.log(`  superseding ${saved[key].address} (${saved[key].revision ?? "unverified"})`);
    } else if (saved[key]?.address) {
      console.log(`  SKIP: ${saved[key].address} is already revision ${REVISION}`);
      continue;
    }
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, chain: pub.chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") { console.log(`  FAILED: status ${rc.status}`); continue; }
    console.log(`  deployed  ${rc.contractAddress}`);
    console.log(`  tx        ${hash}`);
    console.log(`  block     ${rc.blockNumber}`);
    // What landed must be what we compiled: the check whose absence let F63 through.
    let code;
    for (let i = 0; i < 10 && !code; i++) {
      code = await pub.getBytecode({ address: rc.contractAddress });
      if (!code) await new Promise((ok) => setTimeout(ok, 2000));
    }
    const runtimeCodeMatchesArtifact = !!code && matchesArtifact(code, artifact.deployedBytecode);
    if (!runtimeCodeMatchesArtifact) throw new Error(`${key}: runtime code at ${rc.contractAddress} does not match ${ART}`);
    if (!code.toLowerCase().includes(F61_SELECTOR)) throw new Error(`${key}: deployed code lacks mandates(address,address,address)`);
    console.log(`  verified  runtime code == ${ART} with immutables masked (${(code.length - 2) / 2} bytes), F61 selector present`);
    saved[key] = { chainId: cfg.id, address: rc.contractAddress, deployTx: hash, deployBlock: Number(rc.blockNumber),
      deployedAt: new Date().toISOString(), deployer: account.address, revision: REVISION, runtimeCodeMatchesArtifact };
  }

  writeFileSync(OUT, JSON.stringify(saved, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
