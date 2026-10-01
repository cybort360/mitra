#!/usr/bin/env node
/**
 * Print the development addresses, and where to get test tokens for each.
 *
 * Separate from the generator on purpose: this is the file to run when you want
 * to copy an address into a faucet, and it should not be capable of creating a
 * key by accident. The generator writes secrets; this only reads them.
 */
import { existsSync, readFileSync } from "node:fs";

const DIR = ".dev-keys";
const read = (f) => (existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, "utf8").trim() : null);

const solana = read("solana-testnet.address");
const evm = read("evm-testnet.address");

if (!solana || !evm) {
  console.error("No development keys found. Run: node scripts/generate-dev-keys.mjs");
  process.exit(1);
}

console.log(`
Development addresses (testnet — no real value)

  Solana devnet
    ${solana}
    Faucet:  https://faucet.solana.com
    Verify:  https://explorer.solana.com/address/${solana}?cluster=devnet

  Base Sepolia  (ERC-20 test USDC)
    ${evm}
    Faucet:  https://portal.cdp.finance/faucets/base-sepolia
    Verify:  https://sepolia.basescan.org/address/${evm}

  Tempo
    ${evm}
    One EVM key covers both EVM chains — same address, different networks.
    Faucet and chain ID are not yet in the PRD; see docs/adr/0004 on
    what remains unverified.

Next: node scripts/verify-dev-keys.mjs
      node scripts/phase2-readiness.mjs
`);
