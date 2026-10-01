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

/**
 * Tempo Moderato is EVM-compatible but NOT Ethereum-shaped, so `blockNumber`
 * alone does not identify it. The chain ID is asserted instead: a probe that
 * answers "ok" against the wrong chain is a readiness check that has verified
 * nothing. Mainnet is 4217; if we ever see that here, we are pointed at
 * production and the script must fail loudly.
 */
await rpcReachable("Tempo Moderato RPC", process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
  { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
const tempo = checks.find((c) => c.name === "Tempo Moderato RPC");
if (tempo?.ok) {
  const seen = String(tempo.detail).replace(/^live — /, "");
  const id = parseInt(seen, 16);
  if (id === 42431) {
    tempo.detail = "live — chainId 42431 (Moderato)";
  } else {
    tempo.ok = false;
    tempo.detail = id === 4217
      ? "chainId 4217 = TEMPO MAINNET — refusing to treat production as a testnet"
      : `unexpected chainId ${seen} (expected 42431)`;
  }
}

// --- Solana toolchain --------------------------------------------------------
//
// Phase 2 needs a real deployable program, so "is the CLI installed" is the
// wrong question — a version banner proves nothing. `cargo-build-sbf` is the one
// that matters, because that is what turns Rust into the eBPF ELF a validator
// will actually run. Installed via the official Anza installer.

const SOLANA_BIN = `${process.env.HOME}/.local/share/solana/install/active_release/bin`;
const solanaBin = existsSync(SOLANA_BIN) ? SOLANA_BIN : null;
add("Solana CLI (Agave)", Boolean(solanaBin), solanaBin
  ? "installed (official Anza installer)"
  : "not installed — sh <(curl -sSfL https://release.anza.xyz/stable/install)");
// A version check is a claim about a banner. Compiling a program is a claim
// about a deployable artifact, so that is what gets asserted.
const sbf = solanaBin && existsSync(`${SOLANA_BIN}/cargo-build-sbf`);
add("cargo-build-sbf (Rust→eBPF)", Boolean(sbf), sbf
  ? "present — Rust can be compiled to a deployable program"
  : "absent — Rust cannot become an on-chain program without it");

/** Reads a devnet SOL balance from the node, so funding is never taken on trust. */
async function solanaBalance(address) {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: c.signal,
    });
    clearTimeout(t);
    const lamports = (await r.json())?.result?.value;
    return typeof lamports === "number" ? lamports / 1e9 : null;
  } catch {
    return null;
  }
}
if (solana) {
  const address = readFileSync(".dev-keys/solana-testnet.address", "utf8").trim();
  const balance = await solanaBalance(address);
  add("Solana devnet funded", balance !== null && balance > 0, balance === null
    ? "could not read balance"
    : balance > 0 ? `${balance} SOL` : "0 SOL — needs faucet.solana.com (browser)");
}

/**
 * Base Vibenet is a *preview* network: 200ms blocks and B20 tokens, but the docs
 * state its "state may be reset without notice." That makes it excellent for
 * proving the vault controller works, and useless as durable evidence — a
 * balance verified today may be gone tomorrow, so a VERIFIED claim must not rest
 * on it. Base Sepolia is the durable testnet; Vibenet is the fast one.
 *
 * So this check reports funding *and* the caveat, rather than a single green.
 */
async function vibenet() {
  const url = process.env.VIBENET_RPC_URL ?? "https://rpc.vibes.base.org";
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const call = async (method, params = []) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: c.signal,
      });
      return r.json().catch(() => ({}));
    };
    const chain = await call("eth_chainId");
    clearTimeout(t);
    if (chain.error !== undefined || chain.result === undefined) {
      return add("Base Vibenet (preview)", false, `unreachable: ${JSON.stringify(chain.error ?? chain).slice(0, 70)}`);
    }
    const id = parseInt(chain.result, 16);
    if (id !== 84538453) {
      return add("Base Vibenet (preview)", false, `unexpected chainId ${chain.result} (expected 84538453)`);
    }
    if (!evm) return add("Base Vibenet (preview)", false, "chainId 84538453 confirmed; no EVM key to fund");

    const bal = await call("eth_getBalance", [
      readFileSync(".dev-keys/evm-testnet.address", "utf8").trim(), "latest",
    ]);
    const wei = bal.result ? BigInt(bal.result) : 0n;
    const eth = Number(wei) / 1e18;
    add("Base Vibenet (preview)", wei > 0n,
      wei > 0n
        ? `chainId 84538453, ${eth.toFixed(4)} ETH — RESETTABLE, not durable evidence`
        : "chainId 84538453 confirmed; unfunded (POST api.vibes.base.org/api/vibenet/faucet/drip)");
  } catch (e) {
    add("Base Vibenet (preview)", false, `unreachable: ${e.name}`);
  }
}
await vibenet();

/**
 * Tempo has no native gas token. `eth_getBalance` does not return 0 as the
 * docs state — it returns a large constant placeholder, identical for every
 * address including 0x1111…1111. Verified against Moderato 2026-01-10; see
 * forge/FAILURES.md F12.
 *
 * This is recorded as a precondition because it is a live hazard for exactly
 * the code Phase 2 is about to write: a vault controller that trusts
 * `eth_getBalance` to decide whether the vault is funded will conclude it is
 * unimaginably rich and proceed. Balances must come from TIP-20 `balanceOf`
 * via the Tempo API, never from native balance.
 */
const tempoTrap = existsSync(".dev-keys/evm-testnet.address");
add("Tempo: no native-token balance trust", tempoTrap, tempoTrap
  ? "use TIP-20 balanceOf — eth_getBalance returns a constant placeholder"
  : "needs an EVM key to be meaningful");

console.log("\nPRD §52 Phase 2 readiness\n");
let ready = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "READY" : "BLOCKED"}  ${c.name.padEnd(24)} ${c.detail}`);
  if (c.ok) ready++;
}
console.log(`\n${ready}/${checks.length} preconditions met.`);
console.log("Phase 2 exit condition requires a *funded devnet vault* — a funded key is");
console.log("necessary, not sufficient. See docs/adr/0004.\n");
