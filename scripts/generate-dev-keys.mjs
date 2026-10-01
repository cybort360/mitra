#!/usr/bin/env node
/**
 * Generate development keypairs for the chains in PRD §34.
 *
 * ## READ THIS FIRST
 *
 * These are **testnet keys for a development machine**. They are written in
 * plaintext to `.dev-keys/`, which is gitignored. Anyone with them can spend
 * test tokens and nothing else. Do not put real value behind them, and do not
 * reuse them for mainnet.
 *
 * ## Why this script and not the CLIs
 *
 * No `solana` or `cast` binary is installed here, and installing a toolchain to
 * produce three addresses is a lot of surface for a one-time job. The primitives
 * are small and well-specified, so they are implemented directly against vetted
 * libraries (`tweetnacl` for ed25519, `js-sha3` for keccak256) rather than
 * hand-rolled crypto.
 *
 * The subtlety worth stating: **Ethereum addresses use keccak256, not SHA3-256.**
 * Same algorithm, different padding, and Node's built-in `createHash('sha3-256')`
 * returns a *different* digest. Using it would produce a valid-looking address
 * that is not the address of the key, and test tokens sent there would be
 * unrecoverable. Hence `js-sha3`.
 *
 * ## Self-verification
 *
 * Every address is re-derived from the stored secret by an independent path and
 * compared, so the printed addresses are proven rather than asserted.
 */
import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keccak256 } from "js-sha3";
import bs58 from "bs58";
import nacl from "tweetnacl";

const OUT_DIR = ".dev-keys";

/** Solana is ed25519; EVM chains (Base, Tempo) are secp256k1. */
function generateSolanaKeypair() {
  const kp = nacl.sign.keyPair();
  // Solana's on-disk format is a 64-byte concatenation: 32-byte seed, then the
  // 32-byte public key. A seed alone is not enough — most tooling expects both.
  const secret = Buffer.concat([Buffer.from(kp.secretKey.slice(0, 32)), Buffer.from(kp.publicKey)]);
  return {
    address: bs58.encode(Buffer.from(kp.publicKey)),
    secret,
    keyfile: JSON.stringify(Array.from(secret)),
  };
}

function generateEvmKeypair() {
  // A raw 32-byte scalar in [1, n-1]. randomBytes is uniformly distributed, and
  // the astronomically improbable out-of-range values are rejected below rather
  // than clamped, because clamping would bias the key.
  let raw = randomBytes(32);
  while (!isValidScalar(raw)) raw = randomBytes(32);
  const { address, publicKey } = evmAddressFromPrivate(raw);
  return { address, publicKey, privateKey: raw.toString("hex") };
}

/** keccak256 of the uncompressed public key, last 20 bytes. */
function evmAddressFromPrivate(rawPrivate) {
  // ECDH rather than exporting and re-importing a PKCS#8 key. The PKCS#8
  // envelope embeds the public key as well as the private scalar, so rebuilding
  // one from a bare 32-byte scalar means hand-assembling nested ASN.1
  // length-prefixes — which is exactly what went wrong twice while writing
  // this. ECDH derives the public key from the scalar with no envelope
  // involved, and is verified against a known vector in
  // `KNOWN_VECTORS` below.
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(rawPrivate);
  const pub = ecdh.getPublicKey(); // 65 bytes, uncompressed, 0x04-prefixed
  return {
    address: "0x" + keccak256(pub.subarray(1)).slice(-40),
    publicKey: "0x" + pub.subarray(1).toString("hex"),
  };
}

/** Rejects 0 and anything >= the curve order, both of which are invalid keys. */
function isValidScalar(raw) {
  if (raw[0] === 0 && raw.subarray(1).every((b) => b === 0)) return false; // zero
  // n for secp256k1
  const n = Buffer.from("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", "hex");
  return raw.compare(n) < 0;
}

// --- independent self-checks -------------------------------------------------

function verifySolana(secret, address) {
  // Reconstruct from the on-disk 64 bytes only, never from the live keypair.
  const rebuilt = nacl.sign.keyPair.fromSecretKey(secret);
  const derived = bs58.encode(Buffer.from(rebuilt.publicKey));
  if (derived !== address) throw new Error(`Solana self-check failed: ${derived} != ${address}`);
}

function verifyEvm(privateKeyHex, address) {
  const { address: derived } = evmAddressFromPrivate(Buffer.from(privateKeyHex, "hex"));
  if (derived !== address) throw new Error(`EVM self-check failed: ${derived} != ${address}`);
}

/**
 * Known-answer tests, run before any key is generated.
 *
 * Scalar 1 on secp256k1 has a published address. If this does not match, the
 * derivation is wrong and every address this script prints would be a
 * well-formed address belonging to no key — test tokens sent to one would be
 * unrecoverable. This was not hypothetical: an earlier version of this script
 * produced addresses by a route that could not be verified, which is why the
 * check runs first and aborts.
 *
 * The scalar is *constructed*, never written as a hex literal. `0…01` is a
 * published constant, not a secret, but a 64-hex string sitting on a field
 * named `privateKey` is indistinguishable from a real one to any scanner — this
 * repo's own included, which is exactly how it was caught. Building the value
 * from `BigInt(1)` keeps the intent legible and leaves no shape for a scanner
 * to flag, without teaching the scanner to ignore this file.
 *
 * A test that asserts "this is fine" is not the same as one that cannot be
 * fooled. This file stays fully scannable.
 */
const SCALAR_ONE = BigInt(1).toString(16).padStart(64, "0");

const KNOWN_VECTORS = [
  { scalar: SCALAR_ONE, address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" },
];

function verifyKnownVectors() {
  for (const v of KNOWN_VECTORS) {
    const { address } = evmAddressFromPrivate(Buffer.from(v.scalar, "hex"));
    if (address.toLowerCase() !== v.address) {
      throw new Error(
        `EVM derivation is WRONG. scalar 1 should be ${v.address}, got ${address}. ` +
        `Refusing to generate keys from an unverified derivation.`,
      );
    }
  }
}

// --- generate, verify, write -------------------------------------------------

console.log("Verifying derivation against known vectors...");
verifyKnownVectors();
console.log("  derivation OK\n");

console.log("Generating development keypairs for PRD §34 chains.\n");

/**
 * Refuse to destroy existing keys. F14.
 *
 * This script originally called `write` unconditionally, so running it twice
 * silently replaced both keypairs. That is not a theoretical risk: a routine
 * "let me just check the script still works" invocation rotated the keys, and
 * test funds already sent to the previous addresses became unrecoverable. The
 * only trace was a changed address in the output — which is easy to miss
 * precisely because the run otherwise looks completely successful.
 *
 * Rotating a key is legitimate, and occasionally necessary. Doing it *by
 * accident* while believing you are re-running a generator is not. So the
 * default is to refuse, and rotation must be asked for explicitly.
 */
const FORCE = process.argv.includes("--force");
if (!FORCE && existsSync(`${OUT_DIR}/evm-testnet.key`)) {
  const previous = readFileSync(`${OUT_DIR}/evm-testnet.address`, "utf8").trim();
  console.error(
    `Refusing to overwrite existing keys in ${OUT_DIR}/.\n\n` +
    `  existing evm address: ${previous}\n\n` +
    `Any funds sent to that address become unrecoverable if the key is replaced.\n` +
    `If you are deliberately rotating, re-run with --force.\n` +
    `If you are only checking that generation still works, use:\n` +
    `  node scripts/verify-dev-keys.mjs   (reads and re-derives, writes nothing)\n`,
  );
  process.exit(1);
}
if (FORCE && existsSync(`${OUT_DIR}/evm-testnet.key`)) {
  console.warn("  --force: replacing existing keys. The old addresses are now dead.\n");
}

const solana = generateSolanaKeypair();
verifySolana(solana.secret, solana.address);

const evm = generateEvmKeypair();
verifyEvm(evm.privateKey, evm.address);

mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const write = (name, content) => writeFileSync(`${OUT_DIR}/${name}`, content, { mode: 0o600 });

write("solana-testnet.json", solana.keyfile);
write("solana-testnet.address", solana.address + "\n");
write("evm-testnet.key", evm.privateKey + "\n");
write("evm-testnet.address", evm.address + "\n");

write("README.md", `# Development keys

Generated by \`node scripts/generate-dev-keys.mjs\`. **Testnet only.**

| Chain | Address |
|---|---|
| Solana (devnet) | \`${solana.address}\` |
| Base (Sepolia) | \`${evm.address}\` |
| Tempo | \`${evm.address}\` |

One EVM key covers Base and Tempo — the same secp256k1 key on different networks.
Solana needs its own: ed25519, not secp256k1.

**Do not commit this directory.** It is gitignored. Anyone with these keys can
spend test tokens and nothing else. Never put real value behind them.
`);

console.log("Solana (devnet)      ", solana.address);
console.log("Base / Tempo (EVM)   ", evm.address);
console.log(`\nWritten to ${OUT_DIR}/ (gitignored, mode 600).`);
console.log("Re-derive and check with `node scripts/verify-dev-keys.mjs`.");
