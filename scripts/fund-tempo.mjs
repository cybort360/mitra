#!/usr/bin/env node
/**
 * Claim Tempo Moderato test stablecoins, reproducibly and with proof.
 *
 * Two things were believed about this before being measured, and both were
 * wrong:
 *
 * 1. "The Tempo faucet is browser-only." The browser faucet is real, but
 *    Moderato also exposes `tempo_fundAddress` over JSON-RPC, which mints the
 *    same assets programmatically.
 * 2. "Read the balance from api.tempo.xyz." That host indexes **Tempo mainnet**
 *    (its newest block tracked mainnet's, not Moderato's), so it reports an
 *    empty balance for a funded testnet address. An empty response from the
 *    wrong network is indistinguishable from an unfunded account — so this
 *    script reads balances from Moderato logs directly and never from that API.
 *
 * Verified by receipt AND by log: `status == 0x1` alone is not enough, because a
 * successful transaction can still deliver nothing to the address asked for.
 */
import { existsSync, readFileSync } from "node:fs";

const RPC = process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
const CHAIN_ID = 42431;
const ADDR_FILE = ".dev-keys/evm-testnet.address";

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LOG_WINDOW = 99_000; // node rejects ranges wider than 100k blocks

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
};

if (!existsSync(ADDR_FILE)) {
  console.error("No EVM key found. Run scripts/generate-dev-keys.mjs first.");
  process.exit(1);
}
const address = readFileSync(ADDR_FILE, "utf8").trim();

const id = parseInt(await rpc("eth_chainId"), 16);
if (id !== CHAIN_ID) {
  console.error(`Refusing: expected Moderato chainId ${CHAIN_ID}, got ${id}. ` +
    `Tempo MAINNET is 4217 — this script must never run against it.`);
  process.exit(1);
}

/** Sums TIP-20 Transfer amounts received by `address`, per token. */
async function receivedBalances() {
  const latest = parseInt(await rpc("eth_blockNumber"), 16);
  const logs = await rpc("eth_getLogs", [{
    // `to` is topic2, NOT topic1. Filtering on topic1 misses every mint, whose
    // sender is the zero address — which is exactly how the faucet delivers.
    topics: [TRANSFER_TOPIC, null, "0x" + address.slice(2).padStart(64, "0")],
    fromBlock: "0x" + Math.max(0, latest - LOG_WINDOW).toString(16),
    toBlock: "latest",
  }]);
  const totals = new Map();
  for (const l of logs) {
    const amount = BigInt(l.data);
    totals.set(l.address.toLowerCase(), (totals.get(l.address.toLowerCase()) ?? 0n) + amount);
  }
  return totals;
}

const NOTE = [
  "",
  "Note: read from Moderato directly. api.tempo.xyz indexes MAINNET and",
  "reports an empty balance here — do not use it to check testnet funds.",
].join("\n");

const before = await receivedBalances();
console.log(`address   ${address}`);
console.log(`chain     ${id} (Moderato)`);
console.log(`received  ${before.size ? before.size + " token(s)" : "nothing yet"}\n`);

if (before.size > 0 && !process.argv.includes("--top-up")) {
  console.log("Already funded. Use --top-up to mint more.");
  for (const [t, v] of before) console.log(`  ${t}  ${Number(v) / 1e6}`);
  console.log(NOTE);
  process.exit(0);
}

const hashes = await rpc("tempo_fundAddress", [address]);
console.log(`tempo_fundAddress returned ${hashes.length} transaction(s); verifying each...\n`);

// A successful receipt proves the transaction landed, not that we were paid.
const credited = new Set();
for (const h of hashes) {
  const receipt = await rpc("eth_getTransactionReceipt", [h]);
  if (receipt.status !== "0x1") {
    console.error(`  ${h.slice(0, 14)}… status=${receipt.status} — FAILED`);
    continue;
  }
  const toUs = receipt.logs.some(
    (l) => l.topics.length >= 3 &&
      l.topics[2].toLowerCase().endsWith(address.slice(2).toLowerCase()),
  );
  credited.add(receipt.to.toLowerCase());
  console.log(`  ${h.slice(0, 14)}… block ${parseInt(receipt.blockNumber, 16)} ` +
    `token ${receipt.to} ${toUs ? "credited to us" : "NOT credited to us"}`);
}

const after = await receivedBalances();
console.log("\nBalances from Moderato logs (6dp):");
let total = 0n;
for (const [t, v] of after) {
  console.log(`  ${t}  ${Number(v) / 1e6}`);
  total += v;
}

if (after.size === 0) {
  console.error("\nNo TIP-20 transfers found. The mint did not reach this address.");
  process.exit(1);
}
const uncredited = [...credited].filter((t) => !after.has(t));
if (uncredited.length) {
  console.error(`\nTokens minted but not received: ${uncredited.join(", ")}`);
  process.exit(1);
}
console.log(`\nVerified on-chain: ${after.size} token(s), ${Number(total) / 1e6} total units.`);
console.log(NOTE);