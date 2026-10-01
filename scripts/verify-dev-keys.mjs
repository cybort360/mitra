#!/usr/bin/env node
/**
 * Re-derive every address in `.dev-keys/` from the stored secret and compare.
 *
 * Exists because an address that cannot be independently re-derived is not
 * evidence of anything. It is the same principle as the Phase 0 registry audit
 * and the canonical-serialization tests: read the source of truth, do not trust
 * the copy. Run this before sending a faucet request to an address you generated
 * some time ago.
 */
import { createECDH } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { keccak256 } from "js-sha3";
import bs58 from "bs58";
import nacl from "tweetnacl";

const DIR = ".dev-keys";
const fail = [];

function check(label, expected, actual) {
  const ok = expected === actual;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`       expected ${expected}`);
    console.log(`       actual   ${actual}`);
    fail.push(label);
  }
  return ok;
}

console.log("Re-deriving development keypairs from stored secrets.\n");

// --- Solana ------------------------------------------------------------------
const solanaFile = `${DIR}/solana-testnet.json`;
if (existsSync(solanaFile)) {
  const bytes = Buffer.from(JSON.parse(readFileSync(solanaFile, "utf8")));
  check("solana secret is 64 bytes (32 seed + 32 pubkey)", true, bytes.length === 64);
  const fromSecret = nacl.sign.keyPair.fromSecretKey(bytes).publicKey;
  const fromPubBytes = bytes.subarray(32);
  check("solana address agrees with the stored public key",
    bs58.encode(Buffer.from(fromPubBytes)),
    bs58.encode(Buffer.from(fromSecret)));
  const stated = readFileSync(`${DIR}/solana-testnet.address`, "utf8").trim();
  console.log(`  solana: ${stated}`);
} else {
  fail.push("solana key file missing");
}

// --- EVM ---------------------------------------------------------------------
const evmFile = `${DIR}/evm-testnet.key`;
if (existsSync(evmFile)) {
  const raw = Buffer.from(readFileSync(evmFile, "utf8").trim(), "hex");
  check("evm secret is 32 bytes", true, raw.length === 32);
  check("evm scalar is non-zero", true, !(raw[0] === 0 && raw.subarray(1).every((b) => b === 0)));
  const n = Buffer.from("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", "hex");
  check("evm scalar is below the curve order", true, raw.compare(n) < 0);
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(raw);
  const derived = "0x" + keccak256(ecdh.getPublicKey().subarray(1)).slice(-40);
  const stated = readFileSync(`${DIR}/evm-testnet.address`, "utf8").trim();
  check("evm address re-derives from the stored key", stated, derived);
  console.log(`  evm:    ${stated}`);
} else {
  fail.push("evm key file missing");
}

console.log("");
if (fail.length) {
  console.error(`FAILED: ${fail.join(", ")}`);
  process.exit(1);
}
console.log("All keys re-derive correctly.");
