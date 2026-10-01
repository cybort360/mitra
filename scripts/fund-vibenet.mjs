#!/usr/bin/env node
/**
 * Claim test funds from the Base Vibenet faucet, reproducibly.
 *
 * Vibenet is the only one of the three PRD §34 chains with a *programmatic*
 * faucet, so this is the only funding step that does not need a human at a
 * browser. The others (Solana devnet, Tempo Moderato) are browser-only and are
 * recorded as `PARTIAL` in the proof ledger.
 *
 * Read-only with respect to keys: it never generates or rotates anything. That
 * separation is deliberate — see F14, where a "just re-run it" invocation of the
 * generator destroyed funded keys.
 */
import { existsSync, readFileSync } from "node:fs";

const RPC = process.env.VIBENET_RPC_URL ?? "https://rpc.vibes.base.org";
const FAUCET = "https://api.vibes.base.org/api/vibenet/faucet/drip";
const CHAIN_ID = 84538453;
const ADDR_FILE = ".dev-keys/evm-testnet.address";

if (!existsSync(ADDR_FILE)) {
  console.error("No EVM key found. Run scripts/generate-dev-keys.mjs first.");
  process.exit(1);
}
const address = readFileSync(ADDR_FILE, "utf8").trim();

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  return r.json();
};

const chain = await rpc("eth_chainId");
const id = parseInt(chain.result ?? "0x0", 16);
if (id !== CHAIN_ID) {
  console.error(`Refusing: expected Vibenet chainId ${CHAIN_ID}, got ${chain.result}. ` +
    `Set VIBENET_RPC_URL if this is a misconfiguration.`);
  process.exit(1);
}

const before = BigInt((await rpc("eth_getBalance", [address, "latest"])).result ?? "0x0");
console.log(`address   ${address}`);
console.log(`chain     ${id} (Vibenet)`);
console.log(`balance   ${Number(before) / 1e18} ETH`);

if (before > 0n && !process.argv.includes("--top-up")) {
  console.log("\nAlready funded. Use --top-up to request more anyway.");
  process.exit(0);
}

const res = await fetch(FAUCET, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address }),
  signal: AbortSignal.timeout(30_000),
});
const out = await res.json();
if (!out.tx_hash) {
  console.error("Faucet did not return a transaction:", JSON.stringify(out).slice(0, 200));
  process.exit(1);
}

// Confirm the claim is real rather than trusting the faucet response.
await new Promise((r) => setTimeout(r, 4000));
const receipt = await rpc("eth_getTransactionReceipt", [out.tx_hash]);
if (receipt.result?.status !== "0x1") {
  console.error(`Claim mined but did not succeed (status=${receipt.result?.status}).`);
  process.exit(1);
}
const after = BigInt((await rpc("eth_getBalance", [address, "latest"])).result ?? "0x0");

console.log(`\nclaim     ${out.tx_hash}`);
console.log(`status    0x1 (mined in block ${parseInt(receipt.result.blockNumber, 16)})`);
console.log(`balance   ${Number(before) / 1e18} -> ${Number(after) / 1e18} ETH`);

if (after <= before) {
  console.error("\nBalance did not increase. The claim is not usable.");
  process.exit(1);
}
console.log(`\nVerified on-chain: +${Number(after - before) / 1e18} ETH.`);
console.log("Note: Vibenet is a preview network and may be reset without notice,");
console.log("so this is NOT durable evidence. Base Sepolia is the durable testnet.");