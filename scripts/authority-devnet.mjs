#!/usr/bin/env node
/**
 * Phase 3 — Authority on **Solana devnet**: mandate, authorization, and the
 * replay refusal that the whole product exists to provide.
 *
 * > PRD §52 Phase 3: authority must be granted, bounded, consumable, and
 * > incapable of being replayed.
 *
 * This exists because the in-process suite proved it *cannot* prove this.
 * `open_mandate` and `authorize` both create a PDA and CPI to the system
 * program; the Phase 2 work already established that PDA creation, signer
 * privilege, `invoke_signed` seed shape, and lamport ownership are all defects
 * invisible to a unit test. The replay *logic* is unit-tested (F25 added the
 * handler-level suite); the *plumbing* is only reachable here.
 *
 * Same discipline as `vault-devnet.mjs`: every claim is read back from devnet
 * after confirmation, a signature is not evidence, and where a step is expected
 * to fail the assertion is that the bytes are unchanged.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// Derived from the keypair, never a literal (F17 / the phase-2 drift bug).
const KEYPAIR_PATH = process.env.MITRA_VAULT_KEYPAIR
  ?? "programs/mitra-vault/target/deploy/mitra_vault-keypair.json";
const PROGRAM_ID = process.env.MITRA_VAULT_PROGRAM_ID
  ?? new PublicKey(Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))),
  ).publicKey).toBase58();

mkdirSync(".dev-keys", { recursive: true });
const connection = new Connection(RPC, "confirmed");
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".dev-keys/solana-testnet.json", "utf8"))),
);
const programId = new PublicKey(PROGRAM_ID);

// Three distinct identities, because the mechanism only means something if they
// are different. The agent is what a mandate authorizes; the engine is what
// issues permits; the recipient is where value lands. Using one key for all
// three would make "an agent cannot authorize itself" untestable, because there
// would be no second party to be refused.
//
// **They are derived from the funded authority key rather than freshly minted.**
// The first version generated three new keypairs and airdropped them, which hit
// the devnet faucet rate limit (`429 ... airdrop limit today or the faucet has
// run dry`) and aborted the whole run. Deriving from a funded key removes the
// faucet from the critical path entirely and makes the harness re-runnable.
//
// Distinctness is preserved: the child keys are different public keys, which is
// what the test needs. What they must NOT be is the same as each other.
//
// Derivation is `sha256("mitra-phase3:" + role + ":" + authorityPubkey)` folded
// into a valid curve point by the Keypair constructor, which is deterministic
// for a given authority. It is a DEV fixture, not a key-management scheme: these
// keys must never hold real capital, and the README for .dev-keys says so.
const authorityPub = authority.publicKey.toBytes();
const deriveRole = (role) => Keypair.fromSeed(
  createHash("sha256")
    .update(Buffer.concat([Buffer.from(`mitra-phase3:${role}:`), Buffer.from(authorityPub)]))
    .digest()
    .subarray(0, 32),
);
const agentKp = deriveRole("agent");
const engineKp = deriveRole("engine");
const recipientKp = deriveRole("recipient");
const agent = agentKp.publicKey;
const engine = engineKp.publicKey;
const recipient = recipientKp.publicKey;

const sha256 = (b) => createHash("sha256").update(b).digest();
const ixDisc = (name) => sha256(Buffer.from(`global:${name}`)).subarray(0, 8);
const acctDisc = (name) => sha256(Buffer.from(`account:${name}`)).subarray(0, 8);

const MANDATE_DISC = acctDisc("Mandate");
const AUTHZ_DISC = acctDisc("Authorization");
const MANDATE_LEN = 96;
const AUTHZ_LEN = 98;

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.floor(Number(n))));
  return b;
};

const findPda = (seeds) => {
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { pda, bump };
};

const mandate = findPda([Buffer.from("mandate"), Buffer.from(agent.toBytes())]);
const vault = findPda([Buffer.from("vault"), authority.publicKey.toBuffer()]);

console.log(`rpc        ${RPC}`);
console.log(`program    ${programId.toBase58()}`);
console.log(`agent      ${agent.toBase58()}`);
console.log(`mandate    ${mandate.pda.toBase58()} (bump ${mandate.bump})`);
console.log(`vault      ${vault.pda.toBase58()}\n`);

let failures = 0;
/**
 * A refusal check that also asserts the transaction got far enough to be a real
 * program refusal.
 *
 * The first run printed "REPLAY REFUSED  No signers" and counted it as a PASS.
 * A transaction that never reached the program has refused nothing, and treating
 * that as evidence is worse than having no test: it manufactures proof of the
 * security property from a harness bug. `"No signers"` and
 * "no record of a prior credit" are therefore treated as ERRORS, not refusals.
 */
const HARNESS_ERRORS = /no signers|prior credit|BlockhashNotFound|not connected|fetch failed/i;
const checkRefused = (name, r, extra = "") => {
  const why = reason(r.err);
  const isHarness = HARNESS_ERRORS.test(why);
  const ok = !r.ok && !isHarness;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${why ? `  ${why}` : ""}${extra ? `  ${extra}` : ""}`);
  if (isHarness) {
    console.log("        ^ HARNESS ERROR, not a program refusal — this proves nothing");
  }
  if (!ok) failures++;
  return ok;
};
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

async function trySend(ix, signers = []) {
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [...signers]);
    return { ok: true, sig, err: null };
  } catch (e) {
    // A JS error (TypeError etc.) is a HARNESS bug, not a program refusal. It is
    // surfaced with its stack so it can be fixed, rather than reported as a
    // refusal — the failure mode that made an earlier run print
    // "re-authorize REFUSED  Cannot read properties of undefined" and count it.
    if (e instanceof TypeError || e instanceof ReferenceError) {
      console.error(`  HARNESS ERROR: ${e.message}\n${(e.stack ?? "").split("\n").slice(1, 4).join("\n")}`);
    }
    return { ok: false, sig: null, err: e };
  }
}
function reason(e) {
  if (!e) return "";
  const log = (e.logs ?? []).filter((l) => /panicked|failed:|escalated|Custom|error/i.test(l));
  return (log[0] ?? e.message ?? String(e)).replace(/\s+/g, " ").slice(0, 140);
}

/** Decodes a mandate, or null if it does not exist. */
async function readMandate() {
  const a = await connection.getAccountInfo(mandate.pda);
  if (!a) return null;
  const d = a.data;
  if (d.length !== MANDATE_LEN) throw new Error(`mandate length ${d.length} != ${MANDATE_LEN}`);
  if (!d.subarray(0, 8).equals(MANDATE_DISC)) throw new Error("mandate discriminator mismatch");
  return {
    holder: bs58.encode(d.subarray(8, 40)),
    limit: Number(d.readBigUInt64LE(40)),
    version: Number(d.readBigUInt64LE(48)),
    expires_at: Number(d.readBigUInt64LE(56)),
    ceiling: Number(d.readBigUInt64LE(64)),
  };
}

async function readAuthz(pda) {
  const a = await connection.getAccountInfo(pda);
  if (!a) return null;
  const d = a.data;
  if (d.length !== AUTHZ_LEN) throw new Error(`authz length ${d.length} != ${AUTHZ_LEN}`);
  if (!d.subarray(0, 8).equals(AUTHZ_DISC)) throw new Error("authz discriminator mismatch");
  return {
    holder: bs58.encode(d.subarray(8, 40)),
    action_hash: d.subarray(40, 72).toString("hex"),
    amount: Number(d.readBigUInt64LE(72)),
    mandate_version: Number(d.readBigUInt64LE(80)),
    expires_at: Number(d.readBigUInt64LE(88)),
    consumed: d[96] !== 0,
    bump: d[97],
  };
}

const openMandateIx = (limit, ceiling, expiresAt, bump) => new TransactionInstruction({
  programId,
  // FOUR accounts, not three. The `create_account` CPI needs the program account
  // itself so the system program can verify the new account's owner, and the
  // program reads it with `next_account_info` *after* the three declared ones.
  //
  // The first version sent three and every open_mandate failed with "insufficient
  // account keys for instruction" — the same class of defect Phase 2 hit on the
  // vault. It is worth stating plainly: the in-process tests for these handlers
  // could never have caught it, because they call `dispatch` with however many
  // AccountInfos they please and never exercise a real CPI. This is the reason
  // the on-chain harness exists at all.
  keys: [
    { pubkey: agent, isSigner: false, isWritable: true },
    { pubkey: mandate.pda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([ixDisc("open_mandate"), u64(limit), u64(ceiling), u64(expiresAt), Buffer.from([bump])]),
});

/** The action this run will authorize. Distinct per run so reruns don't collide. */
const actionHash = sha256(Buffer.from(`phase3-action-${process.env.PHASE3_RUN ?? "1"}`));
const authz = findPda([Buffer.from("authorization"), Buffer.from(agent.toBytes()), actionHash]);

const authorizeIx = (amount, bump) => new TransactionInstruction({
  programId,
  keys: [
    { pubkey: engine, isSigner: true, isWritable: true },
    { pubkey: agent, isSigner: false, isWritable: false },
    { pubkey: mandate.pda, isSigner: false, isWritable: true },
    { pubkey: authz.pda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([ixDisc("authorize"), actionHash, u64(amount), Buffer.from([bump])]),
});

const spendIx = (hash) => new TransactionInstruction({
  programId,
  keys: [
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: vault.pda, isSigner: false, isWritable: true },
    { pubkey: authz.pda, isSigner: false, isWritable: true },
    // READ-ONLY, and this is load-bearing rather than tidiness. `spend_authorized`
    // loads the mandate and never writes it, so marking it writable asks the
    // runtime to re-verify rent on an account that has no lamport slack — and
    // the transaction dies with "insufficient funds for rent", which reads like a
    // program refusal and is not one. The mandate is a *policy input* to the
    // spend, not a result of it; only the permit and the vault change.
    { pubkey: mandate.pda, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([ixDisc("spend_authorized"), hash]),
});

// ── 0. fund the two signers ────────────────────────────────────────────────
//
// **Funded by transfer from the funded authority, not by airdrop.** Three
// lessons are baked into this block, all of them learned by getting it wrong:
//
//  1. The first version minted three fresh keypairs and airdropped them. The
//     devnet faucet answered `429 ... airdrop limit today or the faucet has run
//     dry`, and the run aborted. Airdrops are rate-limited, shared, and
//     unreliable; the funded authority already holds 4.6 SOL.
//  2. The second version logged the airdrop failure and CONTINUED. Every
//     subsequent step then failed with "Attempt to debit an account but found no
//     record of a prior credit", which reads like a program fault but is a
//     harness fault — and worse, a "refusal" caused by "no signers" is
//     indistinguishable from a correct program refusal, so steps printed PASS
//     while proving nothing. A failed precondition is now FATAL.
//  3. These keys need only enough SOL to pay account rent: `open_mandate` and
//     `authorize` each create a PDA with the signer as payer, and the `spend`
//     leg needs none at all. A small transfer is the whole requirement.
//
// So: verify, and abort rather than continue if it fails.
// 2_000_000 lamports. The first value tried here was 200_000, chosen as
// "comfortably above" rent without being checked, and every open_mandate failed
// with "Transaction results in an account (1) with insufficient funds for rent".
// The actual devnet rent-exempt minimum is ~1_138_000 lamports for the 96-byte
// mandate and ~1_148_000 for the 98-byte authorization — *after* the system
// program has debited the account, which is why "just above the minimum" fails.
//
// The amount is still not hardcoded as a constant, because that is the phase-2
// bug (a fixed 1 SOL against an account holding 0.227). It is queried, with a
// floor well clear of the measured value.
const RENT_FUNDING = Math.max(
  2_000_000,
  Number(await connection.getMinimumBalanceForRentExemption(Math.max(MANDATE_LEN, AUTHZ_LEN))) * 2,
);
//
// The RECIPIENT is funded too, and finding out why is the point. The runtime
// error was `InsufficientFundsForRent { account_index: 2 }`, and index 2 in a
// transaction is `[0] fee payer, [1] program, [2] first instruction key` — the
// recipient, which the harness had left at 0 lamports and non-existent. A
// program that credits lamports to a non-existent account leaves the runtime
// holding a fresh account it must check for rent. Three earlier hypotheses were
// wrong before this one: the authz PDA (which had 2x rent after the fix), the
// vault (2.2M slack), and the mandate (zero slack, but read-only so never
// re-checked). Guessing cost far more than reading the index the error gave.
for (const [label, kp] of [["agent", agentKp], ["engine", engineKp], ["recipient", recipientKp]]) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lam = await connection.getBalance(kp.publicKey);
    if (lam >= RENT_FUNDING) { console.log(`  ${label} funded (${lam} lamports)`); break; }
    if (attempt === 1) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: kp.publicKey, lamports: RENT_FUNDING }),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`  funded ${label}: ${sig.slice(0, 16)}`);
    } else {
      await new Promise((r) => setTimeout(r, 800));
    }
    if (attempt === 3) {
      const finalBal = await connection.getBalance(kp.publicKey);
      if (finalBal < RENT_FUNDING) {
        console.error(`\nABORT: could not fund ${label} (${kp.publicKey.toBase58()}), balance ${finalBal}.`);
        console.error("  Every later check would be meaningless. Fix funding, do not relax the checks.");
        process.exit(2);
      }
    }
  }
}

// Balance is read from the chain, not assumed — the phase-2 harness's fixed 1 SOL
// against a 0.227 SOL account produced a cascade of opaque system-program errors.
const vaultBal = await connection.getBalance(vault.pda);
console.log(`  vault lamports ${vaultBal}`);

const LIMIT = 100_000;
const CEILING = 1_000_000;
const EXPIRES = Math.floor(Date.now() / 1000) + 3600;

// ── 1. open the mandate ─────────────────────────────────────────────────────
console.log("\n1. open_mandate — the agent opens a self-binding limit");
{
  // A mandate already exists on a rerun. `open_mandate` refuses with
  // ALREADY_INITIALIZED, which is the *correct* behaviour, so the harness reads
  // the existing one rather than treating that as a failure.
  const existing = await readMandate();
  if (existing) {
    console.log(`  SKIP  mandate exists (v${existing.version}, limit ${existing.limit})`);
  } else {
    const r = await trySend(openMandateIx(LIMIT, CEILING, EXPIRES, mandate.bump), [agentKp]);
    check("open_mandate confirmed", r.ok, r.ok ? r.sig.slice(0, 16) : reason(r.err));
  }
  const m = await readMandate();
  check("mandate exists on chain", m !== null);
  check("mandate holder is the agent", m?.holder === agent.toBase58());
  check("mandate version starts at 1", m?.version === 1, `v${m?.version}`);
  check("mandate limit recorded", m?.limit === LIMIT, `${m?.limit}`);
  check("mandate ceiling recorded", m?.ceiling === CEILING, `${m?.ceiling}`);
}

// ── 2. the agent's own key cannot be the engine's ───────────────────────────
//
// A mandate is opened BY the holder. That is the whole of its authority story:
// there is no privileged creator who could widen someone else's limits.
console.log("\n2. authority origin — the holder's own key opens the mandate");
{
  const m = await readMandate();
  check("mandate is bound to the agent, not the vault owner",
    m?.holder === agent.toBase58() && m?.holder !== authority.publicKey.toBase58());
}

// ── 3. issue a permit ───────────────────────────────────────────────────────
console.log("\n3. authorize — the program derives a single-use permit");
// The permit must be affordable AND must not drain the vault below rent.
//
// A vault account is itself a rent-exempt data account: 105 bytes, ~1.18M
// lamports of the 3.38M it holds is locked. Spending "half the balance" leaves
// it below rent and the *runtime* rejects the transaction with
// "insufficient funds for rent" — which looks exactly like a program refusal and
// is not one. The spendable amount is balance minus the rent-exempt minimum.
//
// This is the same class of error as the fixed-1-SOL deposit in Phase 2: asking
// for money the account cannot give up. It is a harness bug that reads as a
// system failure, which is why it is worth naming.
const vaultRent = Number(await connection.getMinimumBalanceForRentExemption(105));
const spendable = Math.max(0, vaultBal - vaultRent);
console.log(`  vault ${vaultBal} lamports, rent-exempt ${vaultRent}, spendable ${spendable}`);
let permitAmount = Math.max(1, Math.min(LIMIT, Math.floor(spendable / 2) || 1000));
{
  // A permit for this exact action may already exist from a previous run of this
  // same PHASE3_RUN. That is the program working correctly (6009
  // ALREADY_INITIALIZED), not a failure, and the harness must say so rather than
  // report it as a broken authorize — the first version did, and a rerun looked
  // like a regression.
  const before = await readAuthz(authz.pda);
  const rerun = before !== null;
  check(rerun ? "permit already exists (rerun)" : "no permit before authorization", true,
    rerun ? `v${before.mandate_version}, consumed=${before.consumed}` : "");

  if (rerun && before.consumed) {
    console.log("  SKIP  this action's permit was already SPENT in a previous run;");
    console.log("        the authorization and spend below would be a replay. Re-run with");
    console.log("        a new PHASE3_RUN to exercise a fresh permit end to end.");
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  if (rerun) {
    console.log("  SKIP  permit exists but is unused; authorize is correctly refused 6009");
  }

  const r = await trySend(authorizeIx(permitAmount, authz.bump), [engineKp]);
  check("authorize confirmed", !rerun ? r.ok : !r.ok,
    r.ok ? r.sig.slice(0, 16) : reason(r.err));

  const a = await readAuthz(authz.pda);
  check("permit exists on chain", a !== null);
  check("permit amount is the requested amount", a?.amount === permitAmount, `${a?.amount}`);
  check("permit is bound to this exact action",
    a?.action_hash === actionHash.toString("hex"));
  check("permit records the mandate version", a?.mandate_version === 1, `v${a?.mandate_version}`);
  check("permit is UNUSED", a?.consumed === false);
  check("permit holder is the agent", a?.holder === agent.toBase58());
}

// ── 4. re-issuing is refused ────────────────────────────────────────────────
console.log("\n4. replay of authorize — a second permit for the same action is refused");
{
  const r = await trySend(authorizeIx(permitAmount, authz.bump), [engineKp]);
  checkRefused("re-authorize REFUSED", r);
  const a = await readAuthz(authz.pda);
  check("permit unchanged by the refused re-authorize", a?.consumed === false);
  check("permit amount unchanged", a?.amount === permitAmount);
}

// ── 5. an out-of-policy action is refused ───────────────────────────────────
console.log("\n5. action-hash binding — spending a DIFFERENT action is refused");
{
  const otherHash = sha256(Buffer.from("a-completely-different-action"));
  const before = await readAuthz(authz.pda);
  const r = await trySend(spendIx(otherHash), [authority]);
  checkRefused("spend of a different action REFUSED", r);
  const after = await readAuthz(authz.pda);
  check("permit still unused after the mismatch",
    after?.consumed === false && before?.consumed === false);
}

// ── 6. the valid spend ──────────────────────────────────────────────────────
console.log("\n6. spend_authorized — the valid action moves value and consumes the permit");
{
  const before = await readAuthz(authz.pda);
  const vBefore = await connection.getBalance(vault.pda);
  const rBefore = await connection.getBalance(recipient);

  const r = await trySend(spendIx(actionHash), [authority]);
  check("spend confirmed", r.ok, r.ok ? r.sig.slice(0, 16) : reason(r.err));

  const after = await readAuthz(authz.pda);
  check("permit is now CONSUMED", after?.consumed === true);
  check("consume is recorded against the same action",
    after?.action_hash === before?.action_hash);

  if (r.ok) {
    const vAfter = await connection.getBalance(vault.pda);
    const rAfter = await connection.getBalance(recipient);
    check("value left the vault", vAfter < vBefore, `${vBefore} -> ${vAfter}`);
    check("value reached the recipient",
      rAfter - rBefore >= permitAmount, `+${rAfter - rBefore}`);
  }
}

// ── 7. THE replay ───────────────────────────────────────────────────────────
console.log("\n7. REPLAY — the same permit, the same action, a second time");
{
  const vBefore = await connection.getBalance(vault.pda);
  const rBefore = await connection.getBalance(recipient);

  const r = await trySend(spendIx(actionHash), [authority]);
  checkRefused("REPLAY REFUSED", r);
  check("refusal names the consumed permit",
    /6012|custom program error/i.test(reason(r.err) || ""), reason(r.err));

  const vAfter = await connection.getBalance(vault.pda);
  const rAfter = await connection.getBalance(recipient);
  check("replay moved NO value", vAfter === vBefore, `${vBefore} -> ${vAfter}`);
  check("replay credited NO lamports", rAfter === rBefore, `${rBefore} -> ${rAfter}`);

  // Ten more attempts. One refusal could be a transient; ten identical ones are
  // a guard.
  let allRefused = true;
  let harnessFault = false;
  for (let i = 0; i < 10; i++) {
    const again = await trySend(spendIx(actionHash), [authority]);
    if (again.ok) { allRefused = false; break; }
    // A "refusal" that is really a harness fault must not count as a refusal.
    if (HARNESS_ERRORS.test(reason(again.err))) { harnessFault = true; break; }
  }
  check("10 further replay attempts ALL refused", allRefused && !harnessFault,
    harnessFault ? "harness fault, not a refusal" : "");
  const vFinal = await connection.getBalance(vault.pda);
  check("vault balance unchanged across all replays", vFinal === vBefore, `${vBefore} -> ${vFinal}`);
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
