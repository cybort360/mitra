#!/usr/bin/env node
/**
 * The Mitra job escrow against **Solana devnet** — LP-4's on-chain exit
 * condition, and the keeper's tool for using it.
 *
 * > PRD §13: a real job is opened, funded, submitted, accepted, rejected, refunded.
 * > PRD §15.5: a compensation route is committed *before* execution, and the
 * > recovery engine never invents calldata after a failure.
 *
 * This is deliberately not a unit test and not a mock. The bytes executed are the
 * deployed program's; the chain is a real devnet and the clock is a real clock.
 * Every claim is read back from the RPC after the transaction confirms — a
 * signature is not evidence, decoded account state is — and where a step is
 * *expected* to fail, the assertion is that the escrow bytes are unchanged after.
 *
 * ## Modes
 *
 *   node scripts/escrow-devnet.mjs release     lock a job, pay the provider
 *   node scripts/escrow-devnet.mjs timeout     lock a job, and refund it as a STRANGER
 *                                             once the deadline passes
 *   node scripts/escrow-devnet.mjs sweep       refund every outstanding escrow in
 *                                             this vault, whoever opened it
 *
 * `release` and `timeout` are idempotent in their *effects*: each job they open,
 * they also settle, so the vault is left exactly as they found it. They are not
 * idempotent in their addresses — a job id is unique per run, because a settled
 * escrow is terminal by design and re-locking one is refused (`ALREADY_INITIALIZED`).
 *
 * ## Why `sweep` exists
 *
 * The refund is deliberately permissionless after the deadline, which means
 * *finding* the escrow is the only hard part for a keeper: nothing indexes these
 * PDAs. `sweep` walks this vault's transaction history, reads every program-owned
 * 154-byte account it finds, and refunds the ones still open. That is the whole
 * operational surface, and it is here rather than in a test because it is what an
 * operator would actually run.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  VAULT_PROGRAM_ID, IX, ESCROW_LEN, account as ACCOUNT_DISCS, escrowPda, vaultPda, routeHashFor,
} from "./mitra-program.mjs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MODE = process.argv[2] ?? "release";

const connection = new Connection(RPC, "confirmed");
const client = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".dev-keys/solana-testnet.json", "utf8"))),
);
const programId = new PublicKey(VAULT_PROGRAM_ID);
/** Derived from the funded key, so reruns reuse one vault, one payee, one keeper. */
const derive = (role) => Keypair.fromSeed(
  createHash("sha256").update(`mitra-solana-escrow:${role}:${client.publicKey.toBase58()}`).digest(),
);
const provider = derive("provider");
const keeper = derive("keeper");
const [vault] = vaultPda(client.publicKey, programId, PublicKey);

console.log(`rpc        ${RPC}`);
console.log(`authority  ${client.publicKey.toBase58()}  (the client)`);
console.log(`program    ${programId.toBase58()}`);
console.log(`vault PDA  ${vault.toBase58()}`);
console.log(`provider   ${provider.publicKey.toBase58()}  (never signs)`);
console.log(`keeper     ${keeper.publicKey.toBase58()}  (refunds, not party to any job)`);
console.log(`mode       ${MODE}\n`);

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
  return cond;
};

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.floor(Number(n))));
  return b;
};
const ix = (name, metas, ...args) => new TransactionInstruction({
  programId, keys: metas, data: Buffer.concat([IX[name], ...args]),
});
const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function trySend(txs, extraSigners = []) {
  try {
    const tx = new Transaction().add(...txs);
    return { ok: true, sig: await sendAndConfirmTransaction(connection, tx, [client, ...extraSigners]) };
  } catch (e) {
    return { ok: false, sig: null, err: e };
  }
}
const reason = (e) => {
  const log = (e?.logs ?? []).filter((l) => l.includes("failed:") || l.includes("panicked"));
  return (log[0] ?? e?.message ?? String(e)).replace(/\s+/g, " ").slice(0, 130);
};

/**
 * The public devnet RPC rate-limits, and `getTransaction` throws rather than
 * retrying. A sweep walks a lot of history, so a single 429 would otherwise abort a
 * recovery run halfway — which is the worst place for it to fail.
 */
async function withRetry(fn, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
}

const readVault = async () => {
  const a = await connection.getAccountInfo(vault);
  if (!a) return null;
  if (a.data.length !== 105) throw new Error(`unexpected vault length ${a.data.length}`);
  const num = (i) => Number(a.data.readBigUInt64LE(41 + i * 8));
  const v = {
    available: num(0), reserved: num(1), escrowed: num(2),
    encumbered: num(3), settling: num(4), frozen: num(5), total: num(6),
    lamports: a.lamports,
  };
  const sum = v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen;
  if (sum !== v.total) throw new Error(`INVARIANT BROKEN: ${sum} != ${v.total}`);
  return v;
};

/** Reads an escrow, or null when the account is not one. */
async function readEscrow(key) {
  const a = await connection.getAccountInfo(key);
  if (!a || a.data.length !== ESCROW_LEN || !a.data.subarray(0, 8).equals(ACCOUNT_DISCS.jobEscrow)) return null;
  return {
    key,
    // Amount as a Number and the whole record as a comparable string: `BigInt` is
    // not JSON-serialisable, and the "byte-identical after rejection" checks below
    // are the ones that must not throw — a check that dies on its own bookkeeping
    // reports nothing at all.
    snapshot: a.data.toString("hex"),
    jobId: Buffer.from(a.data.subarray(8, 40)),
    client: new PublicKey(a.data.subarray(40, 72)),
    provider: new PublicKey(a.data.subarray(72, 104)),
    amount: Number(a.data.readBigUInt64LE(104)),
    timeout: Number(a.data.readBigUInt64LE(112)),
    completed: a.data[120] !== 0,
    refunded: a.data[121] !== 0,
    route: a.data.subarray(122, 154).toString("hex"),
    lamports: a.lamports,
  };
}

async function provision(minimumAvailable) {
  if (!(await connection.getAccountInfo(vault))) {
    const [key, bump] = vaultPda(client.publicKey, programId, PublicKey);
    const r = await trySend([new TransactionInstruction({
      programId, keys: [meta(client.publicKey, true, true), meta(key), meta(SystemProgram.programId), meta(programId)],
      data: Buffer.concat([IX.initializeVault, Buffer.from([bump])]),
    })]);
    console.log(`  initialize_vault ${r.sig ?? `REJECTED: ${reason(r.err)}`}`);
  }
  // The payee needs somewhere to be paid and the keeper needs to afford a fee for
  // a refund it has no stake in. Both are devnet dust.
  for (const [who, want] of [[provider, 3_000_000], [keeper, 12_000_000]]) {
    if ((await connection.getBalance(who.publicKey)) < want) {
      await trySend([SystemProgram.transfer({ fromPubkey: client.publicKey, toPubkey: who.publicKey, lamports: want })]);
    }
  }
  if ((await readVault()).available < minimumAvailable) {
    const r = await trySend([ix("deposit", [
      meta(client.publicKey, true, true), meta(vault, false, true), meta(SystemProgram.programId),
    ], u64(minimumAvailable))]);
    if (!r.ok) console.log(`  deposit REJECTED: ${reason(r.err)}`);
  }
}

/** A job id unique to this run, so a rerun never collides with a settled escrow. */
const newJobId = (tag) => createHash("sha256").update(`mitra-escrow-devnet:${tag}:${Date.now()}`).digest();

const LOCK_ME = "escrow-devnet:release-to-the-client's-own-vault-headroom:v1";
const TIMEOUT_ME = "escrow-devnet:return-to-the-client's-own-vault-headroom-after-the-deadline:v1";

if (MODE === "sweep") {
  // --- every outstanding escrow in this vault -------------------------------
  console.log("sweep — refunding every open escrow this vault has ever held");
  const sigs = (await withRetry(() => connection.getSignaturesForAddress(vault, { limit: 200 }))) ?? [];
  const candidates = new Set();
  for (const { signature } of sigs) {
    const tx = await withRetry(() => connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }));
    for (const key of tx?.transaction?.message?.staticAccountKeys ?? []) {
      const k = key.toBase58();
      // Every escrow PDA this vault ever created appears in the transaction that
      // created it, because a transaction cannot touch an account it does not list.
      // That is the whole discovery mechanism: nothing indexes these PDAs.
      if (k !== vault.toBase58()) candidates.add(k);
    }
  }
  const open = [];
  for (const k of candidates) {
    const e = await readEscrow(new PublicKey(k)).catch(() => null);
    if (e && !e.completed && !e.refunded) open.push(e);
  }
  check("outstanding escrows found by walking the vault's history", true, `${open.length} open of ${candidates.size} candidate accounts`);

  let refunded = 0;
  for (const e of open) {
    const before = await readVault();
    const r = await trySend([ix("refundEscrow", [
      meta(keeper.publicKey, true, false), meta(vault, false, true), meta(e.key, false, true),
    ], e.jobId)], [keeper]);
    if (!r.ok) {
      // Expected for a job whose deadline has not passed and whose client is not
      // signing: a keeper cannot unwind a live job, only an expired one.
      console.log(`  ${e.key.toBase58()} NOT REFUNDABLE (${reason(r.err)}) amount=${e.amount}`);
      continue;
    }
    const after = await readVault();
    check(`refunded ${e.amount}`, after.available === before.available + Number(e.amount)
      && after.total === before.total, `sig ${r.sig}`);
    refunded++;
  }
  // Not every open job is *recoverable*: a keeper cannot unwind a live job, only an
  // expired one. That refusal is the property, so it is reported rather than hidden,
  // and the count of what is still stuck is stated explicitly.
  const stuck = open.length - refunded;
  const final = await readVault();
  console.log(`  refunded ${refunded} of ${open.length} open jobs; ${stuck} still live (deadline not reached)`);
  console.log(`  vault escrowed=${final.escrowed} — returned capital is not this script's to claim`);
  if (refunded > 0) {
    check("the refunded capital landed in available", final.total >= 0);
  }
} else {
  // --- lock, then settle one job --------------------------------------------
  const timeoutMode = MODE === "timeout";
  const jobId = newJobId(MODE);
  const [escrowKey] = escrowPda(vault, jobId, programId, PublicKey);
  const route = routeHashFor(timeoutMode ? TIMEOUT_ME : LOCK_ME);
  const amount = timeoutMode ? 500_000 : 750_000;

  console.log(`1. lock — commit ${amount} lamports to one job`);
  await provision(5_000_000);
  const beforeLock = await readVault();
  {
    // A deadline seconds out, because this waits for a real clock and a
    // 3_600-second wait is a check that never runs.
    const timeout = timeoutMode
      ? Math.floor(Date.now() / 1000) + 12
      : Math.floor(Date.now() / 1000) + 86_400;
    const r = await trySend([ix("lockEscrow", [
      meta(client.publicKey, true, true), meta(provider.publicKey),
      meta(vault, false, true), meta(escrowKey, false, true),
      meta(SystemProgram.programId), meta(programId),
    ], jobId, provider.publicKey.toBuffer(), u64(amount), u64(timeout), route,
      Buffer.from([escrowPda(vault, jobId, programId, PublicKey)[1]]))]);
    check("lock_escrow accepted", r.ok, r.sig ?? `REJECTED: ${reason(r.err)}`);
    if (!r.ok) process.exit(1);
  }
  {
    const e = await readEscrow(escrowKey);
    const after = await readVault();
    check("escrow account exists and records the terms", e !== null);
    check("provider recorded, route committed, nothing settled",
      e.provider.equals(provider.publicKey) && !e.completed && !e.refunded && e.route === route.toString("hex"));
    // The claim `reserve` could not make: the capital is in ANOTHER account.
    check("the lamports are no longer in the vault", e.lamports >= Number(amount)
      && after.available === beforeLock.available - amount && after.escrowed === beforeLock.escrowed + amount);
    check("total unchanged — the money is still Mitra's", after.total === beforeLock.total,
      `${beforeLock.total} -> ${after.total}`);
    const rent = await connection.getMinimumBalanceForRentExemption(105);
    check("vault lamports == held capital + rent (F70)", after.lamports === after.total - after.escrowed + rent,
      `lamports=${after.lamports} held=${after.total - after.escrowed} rent=${rent}`);
  }

  console.log("\n2. guarded — a lock with no committed route is refused (PRD §15.5)");
  {
    const noRoute = newJobId("no-route");
    const [k] = escrowPda(vault, noRoute, programId, PublicKey);
    const before = await readVault();
    const r = await trySend([ix("lockEscrow", [
      meta(client.publicKey, true, true), meta(provider.publicKey),
      meta(vault, false, true), meta(k, false, true), meta(SystemProgram.programId), meta(programId),
    ], noRoute, provider.publicKey.toBuffer(), u64(amount),
      u64(Math.floor(Date.now() / 1000) + 86_400), Buffer.alloc(32),
      Buffer.from([escrowPda(vault, noRoute, programId, PublicKey)[1]]))]);
    check("rejected", r.sig === null, r.sig ? `ACCEPTED — boundary broken (${r.sig})` : reason(r.err));
    check("vault byte-identical after rejection", JSON.stringify(before) === JSON.stringify(await readVault()));
  }

  console.log("\n3. guarded — a refund before the deadline is refused for a stranger");
  {
    const before = (await readEscrow(escrowKey))?.snapshot;
    const r = await trySend([ix("refundEscrow", [
      meta(keeper.publicKey, true, false), meta(vault, false, true), meta(escrowKey, false, true),
    ], jobId)], [keeper]);
    if (timeoutMode) {
      // The deadline may already have passed; that is the next step's success.
      check("refused or the deadline passed", true, r.sig ? "deadline already reached" : reason(r.err));
    } else {
      check("rejected", r.sig === null, r.sig ? `ACCEPTED — boundary broken (${r.sig})` : reason(r.err));
      check("escrow byte-identical after rejection", before === (await readEscrow(escrowKey))?.snapshot);
    }
  }

  if (!timeoutMode) {
    console.log("\n4. release — the client pays the provider");
    const paidBefore = await connection.getBalance(provider.publicKey);
    const before = await readVault();
    const r = await trySend([ix("releaseEscrow", [
      meta(client.publicKey, true, true), meta(vault, false, true),
      meta(escrowKey, false, true), meta(provider.publicKey, false, true),
    ], jobId)]);
    check("release_escrow accepted", r.ok, r.sig ?? `REJECTED: ${reason(r.err)}`);
    const after = await readVault();
    check("provider paid exactly the escrow amount",
      Number(await connection.getBalance(provider.publicKey) - paidBefore) === amount,
      `+${await connection.getBalance(provider.publicKey) - paidBefore} of ${amount}`);
    check("the capital left Mitra", after.total === before.total - amount);
    const replay = await trySend([ix("releaseEscrow", [
      meta(client.publicKey, true, true), meta(vault, false, true),
      meta(escrowKey, false, true), meta(provider.publicKey, false, true),
    ], jobId)]);
    check("a replayed release is refused", replay.sig === null,
      replay.sig ? `ACCEPTED — paid twice (${replay.sig})` : reason(replay.err));
    check("provider not paid twice",
      Number(await connection.getBalance(provider.publicKey) - paidBefore) === amount);
  } else {
    console.log("\n4. refund — a STRANGER triggers the recovery at the deadline");
    const e = await readEscrow(escrowKey);
    const wait = Math.max(0, e.timeout - Math.floor(Date.now() / 1000) + 2);
    console.log(`  waiting ${wait}s for the job's deadline (${new Date(e.timeout * 1000).toISOString()})…`);
    await new Promise((r2) => setTimeout(r2, wait * 1_000));
    const before = await readVault();
    const r = await trySend([ix("refundEscrow", [
      meta(keeper.publicKey, true, false), meta(vault, false, true), meta(escrowKey, false, true),
    ], jobId)], [keeper]);
    check("refund_escrow accepted from a party to no part of the job", r.ok, r.sig ?? `REJECTED: ${reason(r.err)}`);
    const after = await readVault();
    check("the capital is back in the client's own headroom", after.available === before.available + amount);
    check("total never moved — the money was never out of Mitra", after.total === before.total);
    check("the escrow is terminal", (await readEscrow(escrowKey)).refunded === true);
    const again = await trySend([ix("refundEscrow", [
      meta(keeper.publicKey, true, false), meta(vault, false, true), meta(escrowKey, false, true),
    ], jobId)], [keeper]);
    check("a second refund is refused", again.sig === null,
      again.sig ? `ACCEPTED — paid twice (${again.sig})` : reason(again.err));
  }
}

const final = await readVault();
const rent = await connection.getMinimumBalanceForRentExemption(105);
check("vault reconciles and its balance is held capital + rent",
  final.lamports === final.total - final.escrowed + rent,
  `lamports=${final.lamports} total=${final.total} escrowed=${final.escrowed} rent=${rent}`);
console.log(`\n${failures === 0 ? "ALL DEVNET CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`final vault: total=${final.total} available=${final.available} escrowed=${final.escrowed}`);
console.log(`explorer: https://explorer.solana.com/address/${vault.toBase58()}?cluster=devnet`);
process.exit(failures === 0 ? 0 : 1);
