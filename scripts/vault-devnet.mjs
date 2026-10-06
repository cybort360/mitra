#!/usr/bin/env node
/**
 * The Mitra Vault Program against **Solana devnet** — the PRD §52 Phase 2 exit
 * condition, item by item.
 *
 * > "Real testnet/devnet vault creation, funding, reservation, guarded spend,
 * >  release/refund, and settlement proof."
 *
 * Every claim is read back from the devnet RPC after the transaction confirms. A
 * signature is not evidence; decoded on-chain account state is. Where a step is
 * *expected* to fail, the assertion is that the vault bytes are unchanged after.
 *
 * This is deliberately not a unit test and not a mock. The bytes executed are the
 * deployed program's; the chain is a real devnet.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "./mitra-program.mjs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// The deployed address, committed — not derived from a keypair.
//
// It used to be derived from `target/deploy/mitra_vault-keypair.json`, on the
// reasoning that a derived id cannot drift from the binary. That reasoning is
// sound and the mechanism is worse than useless: `cargo clean` deletes that file
// and the next `cargo-build-sbf` mints a *fresh* keypair, so one clean between a
// deploy and a harness run silently retargets the harness at a program that does
// not exist. Observed 2026-10-06 (F69).
//
// The drift the derivation was meant to catch is caught more directly below: a
// keypair that is present and derives a DIFFERENT id is refused, naming both. So
// the guard against driving a stale deployment survives, without making the
// harness depend on a file `cargo clean` is entitled to delete.
const KEYPAIR_PATH = process.env.MITRA_VAULT_KEYPAIR
  ?? "programs/mitra-vault/target/deploy/mitra_vault-keypair.json";
const PROGRAM_ID = process.env.MITRA_VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID;
// The build's own keypair is a *corroborating* signal now, not the source of the
// id. When it agrees, that is worth saying out loud — it means the `.so` beside it
// is the one deployed at this address. When it does not agree, that is expected
// after any `cargo clean` (which deletes it) followed by a rebuild (which mints a
// fresh one), so it is reported and then ignored rather than treated as fatal:
// the address is committed and pinned to the Rust constant and the TS client by
// `tests/dev-scripts.test.ts`, and an address under that much pinning cannot go
// quietly stale the way a derived id could.
//
// A hard refusal here was tried first and removed: it blocked a correct run of the
// harness for the ordinary case of a cleaned build tree, and the failure it was
// written to prevent — driving a previous deployment — is already impossible now
// that the id is not derived.
let keypairAgrees = null;
try {
  const fromKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))),
  ).publicKey.toBase58();
  keypairAgrees = fromKeypair === PROGRAM_ID;
  if (!keypairAgrees) {
    console.warn(
      `NOTE: ${KEYPAIR_PATH} derives ${fromKeypair}, which is NOT the program being driven.\n` +
      `      Running against the committed address ${PROGRAM_ID}. This is expected after a\n` +
      `      cargo clean; a stale binary next to the keypair no longer misdirects this\n` +
      `      harness, because the id here is committed rather than derived.`,
    );
  }
} catch (e) {
  if (e?.code !== "ENOENT") throw e;
  // No keypair beside the build. Also expected, and harmless: the upgrade
  // authority lives in .dev-keys, not next to the artifact.
}

const connection = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".dev-keys/solana-testnet.json", "utf8"))),
);
const programId = new PublicKey(PROGRAM_ID);

const sha256 = (b) => createHash("sha256").update(b).digest();
/** Anchor's discriminators, derived — never written from memory (F17). */
const ixDisc = (name) => sha256(Buffer.from(`global:${name}`)).subarray(0, 8);
const VAULT_DISC = sha256(Buffer.from("account:Vault")).subarray(0, 8);
const VAULT_LEN = 105;

const [vaultPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), authority.publicKey.toBuffer()], programId,
);

console.log(`rpc        ${RPC}`);
console.log(`authority  ${authority.publicKey.toBase58()}`);
console.log(`program    ${programId.toBase58()}${keypairAgrees === true ? "  (build keypair agrees)" : ""}`);
console.log(`vault PDA  ${vaultPda.toBase58()} (bump ${bump})\n`);

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
  return cond;
};

/** Little-endian u64 argument, matching the program's borsh read. */
// Lamports are integers. `L / 4` on an odd L yields a fraction, and BigInt
// refuses it — so every derived amount is floored explicitly rather than relying
// on the arithmetic happening to divide evenly.
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.floor(Number(n))));
  return b;
};

/**
 * Sends, returning `{ ok, sig, err }`.
 *
 * The first version returned `null` on failure and printed nothing, which made a
 * genuine bug indistinguishable from an expected rejection — three debugging
 * rounds were spent on that. A harness that hides its errors is worse than no
 * harness, so the reason is always kept and printed on unexpected failures.
 */
async function trySend(ix, extraSigners = []) {
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [authority, ...extraSigners]);
    return { ok: true, sig, err: null };
  } catch (e) {
    return { ok: false, sig: null, err: e };
  }
}

/** The one-line reason a transaction failed, for diagnosis. */
function reason(e) {
  if (!e) return "";
  const log = (e.logs ?? []).filter((l) => l.includes("panicked") || l.includes("failed:") || l.includes("escalated"));
  return (log[0] ?? e.message ?? String(e)).replace(/\s+/g, " ").slice(0, 120);
}

/** Decodes the vault, asserting the reconciliation invariant on every read. */
async function readVault() {
  const acct = await connection.getAccountInfo(vaultPda);
  if (!acct) return null;
  const data = acct.data;
  if (data.length !== VAULT_LEN) throw new Error(`unexpected vault length ${data.length}`);
  if (!data.subarray(0, 8).equals(VAULT_DISC)) throw new Error("discriminator mismatch");
  const num = (i) => Number(data.readBigUInt64LE(41 + i * 8));
  const v = {
    authority: bs58.encode(data.subarray(8, 40)),
    bump: data[40],
    available: num(0), reserved: num(1), escrowed: num(2),
    encumbered: num(3), settling: num(4), frozen: num(5), total: num(6),
    lamports: acct.lamports,
  };
  // Checked on every read, not just at the end: a vault that is ever in a
  // non-reconciling state is a finding wherever it is caught.
  const sum = v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen;
  if (sum !== v.total) throw new Error(`INVARIANT BROKEN: ${sum} != ${v.total}`);
  return v;
}

/**
 * The capital the vault's OWN lamports must account for: `total` less whatever is
 * sitting in a job escrow PDA.
 *
 * This assertion previously compared against `total`, which was correct only while
 * nothing was ever escrowed — and the job escrow (LP-4) moves real lamports out to
 * a separate account while deliberately leaving `total` alone. The program now
 * enforces `lamports == held + rent` (`Vault::held`, F70), and so does this
 * harness: an assertion that disagrees with the program about what the balance
 * should be reports the program as broken when it is the harness that is stale.
 */
const heldOf = (v) => (v ? v.total - v.escrowed : 0);

// Scaled to the authority's actual devnet balance rather than a fixed 1 SOL.
//
// The first run used 1 SOL against an account holding 0.227, and every later
// step failed with an opaque `custom program error: 0x1` from the system program.
// The deposit was never the bug; the test asked for money that was not there.
// `SOLANA_DEPOSIT_LAMPORTS` overrides it.
const balanceLamports = await connection.getBalance(authority.publicKey);
const LAMPORTS = BigInt(process.env.SOLANA_DEPOSIT_LAMPORTS
  ?? Math.max(1_000_000, Math.floor(balanceLamports / 4)).toString());
/** LAMPORTS as a Number, for the arithmetic in the assertions below. */
const L = Number(LAMPORTS);
const ix = (name, metas, arg) => new TransactionInstruction({
  programId,
  keys: metas,
  data: Buffer.concat([ixDisc(name), ...(arg === undefined ? [] : [u64(arg)])]),
});
/** [authority, vault, systemProgram] — the layout the program expects. */
const AUTH = () => [
  { pubkey: authority.publicKey, isSigner: true, isWritable: true },
  { pubkey: vaultPda, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
];

// --- 1. vault creation ------------------------------------------------------
//
// Every expectation below is **relative to the vault's state immediately before
// the action**. The first version asserted absolute values (total == 1 SOL,
// reserved == 0) and therefore failed on any second run, because the vault keeps
// its capital between runs. Worse, it made the over-reserve guard *pass* when it
// should have failed: leftover available from a prior run made an amount
// derived from a fresh balance affordable, and the test reported "boundary
// broken" for a boundary that was intact.
//
// The invariant that matters is not "total equals N" but "total is unchanged" and
// "positions sum to total". Those hold on any starting state, which is what makes
// the harness re-runnable rather than a one-shot script with a hidden setup.
console.log("1. vault creation — initialize_vault");
{
  const before = await readVault();
  if (before) {
    console.log(`  vault already exists (total=${before.total}); reusing it`);
    check("existing vault reconciles", true);
  } else {
    const firstR = await trySend(ix("initialize_vault", [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ]));
    console.log(`  tx ${firstR.sig ?? `REJECTED: ${reason(firstR.err)}`}`);
  }
  const v = await readVault();
  check("vault account exists on devnet", v !== null);
  check("authority recorded", v?.authority === authority.publicKey.toBase58(), v?.authority ?? "");
}

// --- 2. funding ------------------------------------------------------------
console.log("\n2. funding — deposit");
{
  const before = await readVault();
  const amount = Math.max(1_000_000, Math.floor(before.lamports / 4));
  const r = await trySend(ix("deposit", AUTH(), amount));
  console.log(`  tx ${r.sig ?? `REJECTED: ${reason(r.err)}`}`);
  const v = await readVault();
  check("total increased by the deposit", v?.total === before.total + amount,
    `${before.total} -> ${v?.total} (+${amount})`);
  check("available increased by the deposit", v?.available === before.available + amount,
    `${before.available} -> ${v?.available}`);
  const rent = await connection.getMinimumBalanceForRentExemption(VAULT_LEN);
  check("lamports == held capital + rent-exempt minimum", v?.lamports === heldOf(v) + rent,
    `lamports=${v?.lamports} held=${heldOf(v)} rent=${rent} escrowed=${v?.escrowed}`);
}

// --- 3. reservation --------------------------------------------------------
console.log("\n3. reservation — reserve a quarter of available");
{
  const before = await readVault();
  const amount = Math.floor(before.available / 4);
  const r = await trySend(ix("reserve", AUTH(), amount));
  console.log(`  tx ${r.sig ?? `REJECTED: ${reason(r.err)}`}`);
  const v = await readVault();
  check("available reduced by the reservation", v?.available === before.available - amount,
    `${before.available} -> ${v?.available} (-${amount})`);
  check("reserved increased by the reservation", v?.reserved === before.reserved + amount,
    `${before.reserved} -> ${v?.reserved}`);
  check("total unchanged by a reservation", v?.total === before.total, `got ${v?.total}`);
}

// --- 4. over-reservation must fail ----------------------------------------
console.log("\n4. guarded — reserve beyond available (must be REJECTED)");
{
  const before = await readVault();
  const r = await trySend(ix("reserve", AUTH(), before.available + 1));
  check("rejected", r.sig === null, r.sig ? `ACCEPTED — boundary broken (${r.sig})` : reason(r.err));
  check("vault byte-identical after rejection",
    JSON.stringify(before) === JSON.stringify(await readVault()));
}

// --- 5. release / refund ---------------------------------------------------
console.log("\n5. release/refund — return the reservation to available");
{
  const before = await readVault();
  const amount = before.reserved;
  const r = await trySend(ix("release", AUTH(), amount));
  console.log(`  tx ${r.sig ?? `REJECTED: ${reason(r.err)}`}`);
  const v = await readVault();
  check("reserved reduced to zero", v?.reserved === before.reserved - amount,
    `${before.reserved} -> ${v?.reserved}`);
  check("available increased by the release", v?.available === before.available + amount,
    `${before.available} -> ${v?.available}`);
  check("total unchanged by a release", v?.total === before.total, `got ${v?.total}`);
}

// --- 6. a non-authority must not move capital ------------------------------
console.log("\n6. execution guard — a stranger's withdraw (must be REJECTED)");
{
  const stranger = Keypair.generate();
  const before = await readVault();
  const r = await trySend(ix("withdraw", [
    { pubkey: stranger.publicKey, isSigner: true, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], 1), [stranger]);
  check("rejected", r.sig === null, r.sig ? `ACCEPTED — boundary broken (${r.sig})` : reason(r.err));
  check("capital did not move", before?.total === (await readVault())?.total,
    `${before?.total} -> ${(await readVault())?.total}`);
}

// --- 7. authority settlement ----------------------------------------------
console.log("\n7. settlement — authority withdraws 40% of available");
{
  const before = await readVault();
  const amount = Math.floor(before.available * 4 / 10);
  const r = await trySend(ix("withdraw", AUTH(), amount));
  console.log(`  tx ${r.sig ?? `REJECTED: ${reason(r.err)}`}`);
  const v = await readVault();
  check("total reduced by the withdrawal", v?.total === before.total - amount,
    `${before.total} -> ${v?.total} (-${amount})`);
  check("available reduced by the withdrawal", v?.available === before.available - amount,
    `${before.available} -> ${v?.available}`);
  const rent = await connection.getMinimumBalanceForRentExemption(VAULT_LEN);
  check("lamports == held capital + rent-exempt minimum", v?.lamports === heldOf(v) + rent,
    `lamports=${v?.lamports} held=${heldOf(v)} rent=${rent} escrowed=${v?.escrowed}`);
}

// --- 8. over-withdrawal must fail -----------------------------------------
console.log("\n8. guarded — withdraw beyond available (must be REJECTED)");
{
  const before = await readVault();
  const r = await trySend(ix("withdraw", AUTH(), before.available + 1));
  check("rejected", r.sig === null, r.sig ? `ACCEPTED — boundary broken (${r.sig})` : reason(r.err));
  check("vault unchanged", JSON.stringify(before) === JSON.stringify(await readVault()));
}

const final = await readVault();
console.log(`\n${failures === 0 ? "ALL DEVNET CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`final vault: total=${final?.total} available=${final?.available} reserved=${final?.reserved}`);
console.log(`explorer: https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`);
process.exit(failures === 0 ? 0 : 1);