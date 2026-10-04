#!/usr/bin/env node
/**
 * Deploy contracts/src/MitraVault.sol (sprint item 6) to Base Sepolia or Tempo Moderato.
 *
 *   (cd contracts && forge build) && node scripts/deploy-evm-vault.mjs base|tempo
 *
 * Signs locally with .dev-keys/evm-testnet.key and sends a raw transaction, the same
 * way scripts/tempo-pay.mjs does, because Tempo's eth_gasPrice lags the effective
 * price (signing at 1x is rejected). Refuses a node whose chain id is not the
 * expected TESTNET. Records the deployment in lib/evm/deployments.json only after the
 * receipt succeeded AND eth_getCode returns the runtime bytecode Foundry compiled
 * (immutable slots masked). EXISTING_TX=<hash> verifies and records a deployment
 * already made by this key instead of deploying again.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const NETWORKS = {
  base: { chainId: 84532, rpc: process.env.BASE_RPC_URL ?? "https://sepolia.base.org", name: "base-sepolia" },
  tempo: { chainId: 42431, rpc: process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz", name: "tempo-moderato" },
};
const net = NETWORKS[process.argv[2]];
if (!net) { console.error("usage: deploy-evm-vault.mjs base|tempo"); process.exit(2); }

const artifact = JSON.parse(readFileSync("contracts/out/MitraVault.sol/MitraVault.json", "utf8"));
const bytecode = artifact.bytecode.object;
const runtime = artifact.deployedBytecode.object;
const owner = privateKeyToAccount(`0x${readFileSync(".dev-keys/evm-testnet.key", "utf8").trim().replace(/^0x/, "")}`);

let id = 0;
async function rpc(method, params = []) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await res.json();
    if (!j.error) return j.result;
    if (j.error.code === -32002 && attempt < 3) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  }
}

const reported = Number(BigInt(await rpc("eth_chainId")));
if (reported !== net.chainId) { console.error(`REFUSING: node reports chain ${reported}, expected testnet ${net.chainId}`); process.exit(1); }

/**
 * The deployed runtime code must equal the artifact's, except at the immutable
 * slots (EIP712 caches the chain id, domain separator and its own address at
 * construction): those ranges are zero in the artifact and filled on chain. Only the
 * ranges Foundry lists in `immutableReferences` are masked — nothing else.
 */
function maskImmutables(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return bytes.toString("hex");
}

let txHash = process.env.EXISTING_TX;
if (!txHash) {
  const nonce = Number(BigInt(await rpc("eth_getTransactionCount", [owner.address, "latest"])));
  const gp = BigInt(await rpc("eth_gasPrice"));
  const est = BigInt(await rpc("eth_estimateGas", [{ from: owner.address, data: bytecode }]));
  const signed = await owner.signTransaction({
    type: "eip1559", chainId: net.chainId, data: bytecode, nonce,
    gas: (est * 13n) / 10n, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp,
  });
  txHash = await rpc("eth_sendRawTransaction", [signed]);
  console.log(`${net.name}: deploy tx ${txHash}`);
} else {
  console.log(`${net.name}: verifying existing deploy tx ${txHash}`);
}

let receipt = null;
for (let i = 0; i < 60 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [txHash]); if (!receipt) await new Promise((r) => setTimeout(r, 2000)); }
if (!receipt || BigInt(receipt.status) !== 1n || !receipt.contractAddress) { console.error("deploy failed", receipt); process.exit(1); }
if (receipt.from.toLowerCase() !== owner.address.toLowerCase()) { console.error("that deployment was not made by this key"); process.exit(1); }
const code = await rpc("eth_getCode", [receipt.contractAddress, "latest"]);
if (maskImmutables(code) !== maskImmutables(runtime)) { console.error("on-chain runtime bytecode differs from the compiled artifact outside the immutable slots"); process.exit(1); }

const file = "lib/evm/deployments.json";
const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
all[String(net.chainId)] = {
  network: net.name, contract: "MitraVault", address: receipt.contractAddress, txHash,
  block: Number(BigInt(receipt.blockNumber)), deployer: owner.address, deployedAt: new Date().toISOString(),
  runtimeCodeMatchesArtifact: true,
};
writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
console.log(`${net.name}: MitraVault at ${receipt.contractAddress}, block ${Number(BigInt(receipt.blockNumber))}, runtime code matches the artifact (immutable slots masked)`);
