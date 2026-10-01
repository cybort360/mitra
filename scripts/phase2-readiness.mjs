#!/usr/bin/env node
/**
 * What Phase 2 still needs, stated as commands rather than adjectives.
 *
 * ADR-0004: the Phase 2 exit condition requires a *real* devnet vault, so it
 * cannot be satisfied by local tests. This script reports exactly which
 * preconditions are met on this machine, so the gap is actionable rather than
 * a caveat, and so nobody has to guess whether the environment is ready.
 */
import { existsSync, readFileSync } from "node:fs";

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// Keys
const solana = existsSync(".dev-keys/solana-testnet.address");
const evm = existsSync(".dev-keys/evm-testnet.address");
add("Solana devnet key", solana, solana ? readFileSync(".dev-keys/solana-testnet.address", "utf8").trim() : "run scripts/generate-dev-keys.mjs");
add("EVM key (Base/Tempo)", evm, evm ? readFileSync(".dev-keys/evm-testnet.address", "utf8").trim() : "run scripts/generate-dev-keys.mjs");

// Environment
const url = process.env.DATABASE_URL;
add("DATABASE_URL", Boolean(url), url ?? "unset — needed for the durable repository");

// Network reachability
/**
 * Both chains are JSON-RPC over POST, so a GET probe is the wrong test.
 *
 * The first version of this script used a plain GET and reported Base Sepolia as
 * BLOCKED/405. The endpoint was fine — it simply does not accept GET. A
 * readiness check that reports a false blocker is worse than none, because the
 * obvious response is to distrust the finding and then distrust the script.
 */
async function rpcReachable(name, url, body) {
  if (!url) return add(name, false, "no endpoint configured");
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: c.signal,
    });
    clearTimeout(t);
    const json = await r.json().catch(() => ({}));
    const live = r.ok && json.result !== undefined && json.error === undefined;
    add(name, live, live ? `live — ${json.result}` : `HTTP ${r.status} ${JSON.stringify(json.error ?? json).slice(0, 80)}`);
  } catch (e) {
    add(name, false, `unreachable: ${e.name}`);
  }
}
await rpcReachable("Solana devnet RPC", process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  { jsonrpc: "2.0", id: 1, method: "getHealth" });
await rpcReachable("Base Sepolia RPC", process.env.BASE_RPC_URL ?? "https://sepolia.base.org",
  { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

console.log("\nPRD §52 Phase 2 readiness\n");
let ready = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "READY" : "BLOCKED"}  ${c.name.padEnd(24)} ${c.detail}`);
  if (c.ok) ready++;
}
console.log(`\n${ready}/${checks.length} preconditions met.`);
console.log("Phase 2 exit condition requires a *funded devnet vault* — a funded key is");
console.log("necessary, not sufficient. See docs/adr/0004.\n");
