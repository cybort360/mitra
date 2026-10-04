#!/usr/bin/env node
/**
 * Independent verification of the Phase 3 on-chain evidence.
 *
 * Separate from `authority-devnet.mjs` on purpose. The harness both *performs*
 * the actions and *asserts* on them, so a bug in its decoder would be invisible
 * to it. This script re-derives the same facts from `getAccountInfo` and
 * `getSignaturesForAddress` with no reference to the harness's own state, so a
 * disagreement between the two would show up as a disagreement.
 *
 * Usage: node scripts/verify-phase3.mjs <phase3-run-id>
 */
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const run = process.argv[2] ?? "final1";
const PID = new PublicKey("GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY");
const VAULT = new PublicKey("5gCCCyxoLfsUfNxHswHiUaPS9E1bgHyNyxh1nbwdxA9T");
const c = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

const a = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".dev-keys/solana-testnet.json", "utf8"))));
const ap = Buffer.from(a.publicKey.toBytes());
const der = (r) => Keypair.fromSeed(createHash("sha256").update(Buffer.concat([Buffer.from(`mitra-phase3:${r}:`), ap])).digest().subarray(0, 32));
const agent = der("agent").publicKey, engine = der("engine").publicKey, recipient = der("recipient").publicKey;
const sha = (b) => createHash("sha256").update(b).digest();
const ah = sha(Buffer.from(`phase3-action-${run}`));

// Reseeded (sprint item 7): mandate by (principal, holder), permit by (mandate, action).
const [mandate] = PublicKey.findProgramAddressSync([Buffer.from("mandate"), a.publicKey.toBuffer(), Buffer.from(agent.toBytes())], PID);
const [authz] = PublicKey.findProgramAddressSync([Buffer.from("authorization"), mandate.toBuffer(), ah], PID);

let bad = 0;
const check = (n, c2, d = "") => { console.log(`  ${c2 ? "PASS" : "FAIL"}  ${n}${d ? `  ${d}` : ""}`); if (!c2) bad++; };

console.log(`run ${run}  agent ${agent.toBase58()}\n`);

const ma = await c.getAccountInfo(mandate);
check("mandate account exists on devnet", ma !== null, mandate.toBase58());
if (ma) {
  const d = ma.data;
  const acctDisc = sha(Buffer.from("account:Mandate")).subarray(0, 8);
  check("mandate discriminator correct", d.subarray(0, 8).equals(acctDisc));
  check("mandate is 96 bytes", d.length === 96, `${d.length}`);
  check("mandate holder == agent", Buffer.from(d.subarray(8, 40)).equals(Buffer.from(agent.toBytes())));
  check("mandate version == 1", Number(d.readBigUInt64LE(48)) === 1, `v${Number(d.readBigUInt64LE(48))}`);
  check("mandate limit == 100000", Number(d.readBigUInt64LE(40)) === 100000);
  // Reported, not asserted, and the distinction matters. This mandate was created
  // BEFORE the F26 headroom fix, so it sits at exactly the bare minimum. That is
  // not a defect in the current program — it is a pre-fix artifact — and a fresh
  // mandate gets 2x. Asserting on it would fail forever and teach nothing; the
  // evidence for the fix is the authorization below, which was created after it.
  const slack = ma.lamports - Number(await c.getMinimumBalanceForRentExemption(96));
  console.log(`  INFO  mandate rent slack ${slack} (0 = pre-F26 artifact, not a defect)`);
}

const aa = await c.getAccountInfo(authz);
check("authorization account exists on devnet", aa !== null, authz.toBase58());
if (aa) {
  const d = aa.data;
  const acctDisc = sha(Buffer.from("account:Authorization")).subarray(0, 8);
  check("authorization discriminator correct", d.subarray(0, 8).equals(acctDisc));
  check("authorization is 98 bytes", d.length === 98, `${d.length}`);
  check("permit action_hash == this run's action", d.subarray(40, 72).toString("hex") === ah.toString("hex"));
  check("permit records mandate version 1", Number(d.readBigUInt64LE(80)) === 1);
  check("permit is CONSUMED on chain", d[96] !== 0, `flag=${d[96]}`);
  const slack = aa.lamports - Number(await c.getMinimumBalanceForRentExemption(98));
  check("permit has rent headroom (F26 fix live)", slack > 0, `slack ${slack}`);
}

const va = await c.getAccountInfo(VAULT);
if (va) {
  const d = va.data;
  const num = (i) => Number(d.readBigUInt64LE(41 + i * 8));
  const sum = num(0) + num(1) + num(2) + num(3) + num(4) + num(5);
  check("VAULT RECONCILES after policy-mediated spends", sum === num(6), `${sum} == ${num(6)}`);
  check("vault available < total (capital was spent)", num(0) < num(6), `${num(0)} < ${num(6)}`);
}

const rBal = await c.getBalance(recipient);
check("recipient was credited", rBal > 2_000_000, `${rBal} lamports`);

const sigs = await c.getSignaturesForAddress(authz, { limit: 10 });
check("authorization account has transaction history", sigs.length >= 2, `${sigs.length} signatures`);
const spendSigs = sigs.filter((s) => !s.err);
check("some authorization transactions succeeded", spendSigs.length >= 2, `${spendSigs.length} ok`);

console.log(`\n${bad === 0 ? "VERIFIED" : `${bad} CHECK(S) FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
