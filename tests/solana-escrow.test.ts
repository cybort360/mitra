/**
 * LP-4 — the Solana job escrow, twice over.
 *
 * **Part 1 (always runs):** the TypeScript client against bytes the RUST program
 * produced. `programs/mitra-vault/tests/golden/vault-layout.json` is generated
 * from the program's own types, and every escrow instruction in it was accepted by
 * the program's real `dispatch` — the two jobs in the golden file are locked,
 * released and refunded there, not merely encoded. So this compares TS output
 * against Rust output, and a drift on either side fails here rather than on devnet.
 *
 * Two hand-written encoders agreeing with each other is the failure this repository
 * keeps paying for (F12, F45). Nothing below compares the TS client with itself.
 *
 * **Part 2 (`SOLANA_ESCROW_LIVE=1`):** the deployed program on devnet — lock,
 * client release, and an *autonomous* refund triggered by a third party who is
 * neither client nor provider, at the job's deadline. That last one is the whole
 * point of the package and the only thing that can be claimed about it: the
 * in-process suite cannot run the `create_account` CPI, cannot move real lamports,
 * and cannot make a real clock reach a deadline.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ACCOUNT, ESCROW_LEN, IX,
  decodeJobEscrow, decodeVault, escrowPda, hasRefundCommitment, isEscrowSettled,
  jobIdFor, lockEscrowIx, refundEscrowIx, releaseEscrowIx, routeHashFor, vaultPda,
  depositIx, initializeVaultIx,
} from "@/lib/solana/vault-program";

const g = JSON.parse(readFileSync("programs/mitra-vault/tests/golden/vault-layout.json", "utf8"));
const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");
const I = {
  principal: new PublicKey(g.inputs.principal),
  provider: new PublicKey(g.inputs.provider),
  keeper: new PublicKey(g.inputs.keeper),
  jobId: Buffer.from(g.inputs.jobId, "hex"),
  jobIdB: Buffer.from(g.inputs.jobIdB, "hex"),
  jobAmount: BigInt(g.inputs.jobAmount),
  jobAmountB: BigInt(g.inputs.jobAmountB),
  jobTimeout: BigInt(g.inputs.jobTimeout),
  refundRoute: Buffer.from(g.inputs.refundRoute, "hex"),
};

// ── part 1: the client against the program's bytes ────────────────────────────

describe("escrow identifiers match the program", () => {
  it("instruction and account discriminators", () => {
    expect(hex(IX.lockEscrow)).toBe(g.discriminators.lock_escrow);
    expect(hex(IX.releaseEscrow)).toBe(g.discriminators.release_escrow);
    expect(hex(IX.refundEscrow)).toBe(g.discriminators.refund_escrow);
    expect(hex(ACCOUNT.jobEscrow)).toBe(g.discriminators["account:JobEscrow"]);
  });

  it("every PDA and bump", () => {
    const [vault] = vaultPda(I.principal);
    const [escrow, bump] = escrowPda(vault, I.jobId);
    const [escrowB, bumpB] = escrowPda(vault, I.jobIdB);
    expect([escrow.toBase58(), bump]).toEqual([g.pdas.escrow.address, g.pdas.escrow.bump]);
    expect([escrowB.toBase58(), bumpB]).toEqual([g.pdas.escrowB.address, g.pdas.escrowB.bump]);
  });

  it("a job id must be 32 bytes — the seed is at the runtime's per-seed cap", () => {
    // Asserted rather than assumed: a longer id throws here instead of producing
    // an address the program will never re-derive.
    expect(() => escrowPda(vaultPda(I.principal)[0], Buffer.alloc(31))).toThrow("JOB_ID_NOT_32_BYTES");
  });
});

describe("escrow instruction data is byte-identical to what dispatch accepted", () => {
  const lockOf = (jobId: Buffer, amount: bigint) =>
    lockEscrowIx({
      client: I.principal, provider: I.provider, jobId,
      amount, timeout: I.jobTimeout, refundRouteHash: I.refundRoute,
    });

  it("lock_escrow, for two different jobs", () => {
    expect(hex(lockOf(I.jobId, I.jobAmount).data)).toBe(g.instructions.lock_escrow);
    expect(hex(lockOf(I.jobIdB, I.jobAmountB).data)).toBe(g.instructions.lock_escrow_b);
  });

  it("release_escrow and refund_escrow carry a job id and nothing else", () => {
    // The structural claim, in the place it matters: 8 + 32. There is no
    // argument through which a caller could name an amount or a payee.
    const release = releaseEscrowIx({ client: I.principal, jobId: I.jobId, provider: I.provider });
    const refund = refundEscrowIx({ caller: I.keeper, escrowClient: I.principal, jobId: I.jobIdB });
    expect(release.data.length).toBe(40);
    expect(refund.data.length).toBe(40);
    expect(hex(release.data)).toBe(g.instructions.release_escrow);
    expect(hex(refund.data)).toBe(g.instructions.refund_escrow);
  });
});

describe("account order is what dispatch was handed (golden accountMetas)", () => {
  type Meta = [string, boolean, boolean];
  const keys = (ix: { keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }): Meta[] =>
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

  it("lock_escrow: the client signs and pays, with the program account LAST on chain", () => {
    const ix = lockEscrowIx({
      client: I.principal, provider: I.provider, jobId: I.jobId,
      amount: I.jobAmount, timeout: I.jobTimeout, refundRouteHash: I.refundRoute,
    });
    const k = keys(ix);
    const golden = g.accountMetas.lock_escrow as Meta[];
    expect(k.slice(0, golden.length)).toEqual(golden);
    // The extra account is exactly the program id, for the create_account CPI the
    // in-process golden run skips.
    expect(k.slice(golden.length)).toEqual([[new PublicKey(g.programId).toBase58(), false, false]]);
    expect(ix.keys[0].pubkey.equals(I.principal) && ix.keys[0].isSigner).toBe(true);
  });

  it("release_escrow: the client signs, the provider is writable and is not a signer", () => {
    const ix = releaseEscrowIx({ client: I.principal, jobId: I.jobId, provider: I.provider });
    expect(keys(ix)).toEqual(g.accountMetas.release_escrow);
    // The payee never signs: an agent being paid for work does not hold the
    // client's key, and requiring it would make every payment a co-signature.
    expect(ix.keys[3].pubkey.equals(I.provider) && ix.keys[3].isSigner).toBe(false);
    expect(ix.keys.some((k, i) => k.isSigner && i !== 0)).toBe(false);
  });

  it("refund_escrow: exactly three accounts, and the sole signer is not the client", () => {
    // The autonomous-recovery shape. Three accounts, one of them writable, and a
    // signer who is the keeper rather than the vault's authority — because after
    // the deadline nobody's authority is required.
    const ix = refundEscrowIx({ caller: I.keeper, escrowClient: I.principal, jobId: I.jobIdB });
    expect(ix.keys).toHaveLength(3);
    expect(keys(ix)).toEqual(g.accountMetas.refund_escrow);
    expect(ix.keys[0].pubkey.equals(I.keeper) && ix.keys[0].isSigner).toBe(true);
    expect([...ix.keys].some((k) => k.pubkey.equals(I.principal) && k.isSigner)).toBe(false);
  });
});

describe("decoders read the program's own escrow bytes", () => {
  it("locked: nothing settled, the route is committed", () => {
    const e = decodeJobEscrow(Buffer.from(g.accounts.escrowLocked, "hex"));
    expect(e.client.equals(I.principal)).toBe(true);
    expect(e.provider.equals(I.provider)).toBe(true);
    expect([e.amount, e.timeout]).toEqual([I.jobAmount, I.jobTimeout]);
    expect([hex(e.jobId), hex(e.refundRouteHash)]).toEqual([g.inputs.jobId, g.inputs.refundRoute]);
    expect([e.completed, e.refunded, isEscrowSettled(e), hasRefundCommitment(e)]).toEqual([false, false, false, true]);
  });

  it("completed and refunded are distinct terminal states", () => {
    // Both recorded, because the golden file ran one job each way: a release by
    // the client and a refund by a stranger. A decoder that read one flag for both
    // would say these are the same account.
    const done = decodeJobEscrow(Buffer.from(g.accounts.escrowCompleted, "hex"));
    const back = decodeJobEscrow(Buffer.from(g.accounts.escrowRefunded, "hex"));
    expect([done.completed, done.refunded]).toEqual([true, false]);
    expect([back.completed, back.refunded]).toEqual([false, true]);
    expect(hex(done.jobId)).not.toBe(hex(back.jobId));
    expect([isEscrowSettled(done), isEscrowSettled(back)]).toEqual([true, true]);
    // The refunded job kept its route; recovery consumed the escrow, not the term.
    expect(hasRefundCommitment(back)).toBe(true);
  });

  it("a corrupt flag byte reads as settled, not as live", () => {
    const b = Buffer.from(g.accounts.escrowLocked, "hex");
    b[120] = 0xff;
    expect(isEscrowSettled(decodeJobEscrow(b))).toBe(true);
  });

  it("an all-zero route is the absence of a commitment", () => {
    // The one value `refund_escrow` refuses (6019), pinned where a client can see
    // it. The golden fixture deliberately uses a non-zero route, so this is the
    // only place that value appears.
    const b = Buffer.from(g.accounts.escrowLocked, "hex");
    b.fill(0, 122, 154);
    expect(hasRefundCommitment(decodeJobEscrow(b))).toBe(false);
  });

  it("an escrow account is 154 bytes and refuses anything else", () => {
    expect(Buffer.from(g.accounts.escrowLocked, "hex").length).toBe(ESCROW_LEN);
    expect(() => decodeJobEscrow(Buffer.from(g.accounts.escrowLocked, "hex").subarray(0, 100)))
      .toThrow("NOT_A_JOB_ESCROW_ACCOUNT");
  });

  it("a vault is not an escrow", () => {
    // A PDA can hold any bytes; the discriminator is what stops an attacker
    // pointing a release at an account they control.
    expect(() => decodeJobEscrow(Buffer.from(g.accounts.vault, "hex"))).toThrow("NOT_A_JOB_ESCROW_ACCOUNT");
    expect(decodeVault(Buffer.from(g.accounts.vault, "hex")).escrowed).toBe(0n);
  });
});

describe("job id and route derivation", () => {
  it("two spellings of one job cannot become two escrows", () => {
    // The narrowing is where the identity of a job is decided, so it is tested
    // where it happens. Deterministic, and distinct across ids.
    expect(hex(jobIdFor("erc8183:job-1"))).toBe(hex(jobIdFor("erc8183:job-1")));
    expect(hex(jobIdFor("erc8183:job-1"))).not.toBe(hex(jobIdFor("erc8183:job-2")));
    expect(jobIdFor("anything at all").length).toBe(32);
  });

  it("a route hash is domain-separated, so it cannot collide with a job id hash", () => {
    // Same sha256, different preimage domain. Without the prefix a caller could
    // present a job id as if it were the commitment to a recovery route.
    expect(hex(routeHashFor("x"))).not.toBe(hex(createHash("sha256").update("x", "utf8").digest()));
    expect(hex(routeHashFor("x"))).toBe(hex(routeHashFor("x")));
    expect(routeHashFor("x").length).toBe(32);
    // Never all-zero, so a derived route can never be mistaken for no commitment.
    // Asserted on a real escrow record rather than a stub: the helper under test
    // reads one field, and a hand-made object could agree with it for the wrong
    // reason.
    const blank = Buffer.from(g.accounts.escrowLocked, "hex");
    blank.fill(0, 122, 154);
    const withRoute = decodeJobEscrow(blank);
    expect(hasRefundCommitment(withRoute)).toBe(false);
    withRoute.refundRouteHash = routeHashFor("");
    expect(hasRefundCommitment(withRoute)).toBe(true);
  });
});

// ── part 2: the deployed program on devnet ────────────────────────────────────

const KEY = ".dev-keys/solana-testnet.json";
const live = process.env.SOLANA_ESCROW_LIVE === "1" && existsSync(KEY);

describe.skipIf(!live)("live: lock, release, and an autonomous timeout refund on devnet (SOLANA_ESCROW_LIVE=1)", () => {
  const rpc = () => process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = () => new Connection(rpc(), "confirmed");
  const client = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
  /** Derived from the funded key, so reruns reuse one vault and one payee. */
  const derive = (role: string) =>
    Keypair.fromSeed(createHash("sha256").update(`mitra-solana-escrow:${role}:${client.publicKey.toBase58()}`).digest());
  const provider = derive("provider");
  const keeper = derive("keeper");

  const send = async (ixs: Parameters<typeof Transaction.prototype.add>[0][], signers: Keypair[]) => {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(conn(), tx, signers);
  };
  const lamportsOf = async (k: PublicKey) => (await conn().getAccountInfo(k))?.lamports ?? 0;
  /** Unique per run, so a rerun cannot collide with an escrow that already settled. */
  const jobId = (tag: string) => jobIdFor(`escrow-live:${tag}:${Date.now()}:${Math.random()}`);

  async function provision() {
    const c = conn();
    const [vault] = vaultPda(client.publicKey);
    if (!(await c.getAccountInfo(vault))) {
      await send([initializeVaultIx(client.publicKey)], [client]);
    }
    // Both the provider and the keeper need a balance: the provider to receive,
    // the keeper to pay the fee for a refund it has no other stake in.
    for (const [who, want] of [[provider, 2_000_000n], [keeper, 10_000_000n]] as const) {
      if ((await c.getBalance(who.publicKey)) < want) {
        await send([SystemProgram.transfer({
          fromPubkey: client.publicKey, toPubkey: who.publicKey, lamports: Number(want),
        })], [client]);
      }
    }
    if (decodeVault(Buffer.from((await c.getAccountInfo(vault))!.data)).available < 3_000_000n) {
      await send([depositIx(client.publicKey, vault, 2_000_000n)], [client]);
    }
    return vault;
  }

  it("a locked job holds real lamports in its own account", async () => {
    const vault = await provision();
    const id = jobId("lock");
    const amount = 1_000_000n;
    const route = routeHashFor("refund to the client's own vault headroom");
    const before = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));
    const providerBefore = await lamportsOf(provider.publicKey);

    const sig = await send([lockEscrowIx({
      client: client.publicKey, provider: provider.publicKey, jobId: id,
      amount, timeout: BigInt(Math.floor(Date.now() / 1000) + 3_600), refundRouteHash: route,
    })], [client]);

    const [escrowKey] = escrowPda(vault, id);
    const escrow = decodeJobEscrow(Buffer.from((await conn().getAccountInfo(escrowKey))!.data));
    const after = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));

    // The claim a `reserve` could not make: the capital is in ANOTHER account, and
    // the vault's balance no longer contains it.
    expect([escrow.amount, escrow.completed, escrow.refunded]).toEqual([amount, false, false]);
    expect(hex(escrow.refundRouteHash)).toBe(hex(route));
    expect(await lamportsOf(escrowKey)).toBeGreaterThanOrEqual(Number(amount));
    expect(after.available).toBe(before.available - amount);
    expect(after.escrowed).toBe(before.escrowed + amount);
    expect(after.total).toBe(before.total);
    expect(await lamportsOf(provider.publicKey)).toBe(providerBefore);
    // eslint-disable-next-line no-console
    console.log(`  lock_escrow  ${sig}  escrow=${escrowKey.toBase58()} amount=${amount}`);
  });

  it("the client releases, the provider is paid exactly the escrow amount", async () => {
    const vault = await provision();
    const id = jobId("release");
    const amount = 750_000n;
    await send([lockEscrowIx({
      client: client.publicKey, provider: provider.publicKey, jobId: id,
      amount, timeout: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      refundRouteHash: routeHashFor("release on client acceptance"),
    })], [client]);

    const [escrowKey] = escrowPda(vault, id);
    const paidBefore = await lamportsOf(provider.publicKey);
    const vaultBefore = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));

    const sig = await send([releaseEscrowIx({
      client: client.publicKey, jobId: id, provider: provider.publicKey,
    })], [client]);

    const escrow = decodeJobEscrow(Buffer.from((await conn().getAccountInfo(escrowKey))!.data));
    const after = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));

    expect([escrow.completed, escrow.refunded]).toEqual([true, false]);
    expect(await lamportsOf(provider.publicKey) - paidBefore).toBe(Number(amount));
    expect(after.total).toBe(vaultBefore.total - amount);
    expect(after.escrowed).toBe(vaultBefore.escrowed - amount);

    // A replay is refused by the program, and pays nothing. Asserted from the
    // rejection rather than from an error message: a transaction that fails is
    // proof the guard fired, and the provider's balance is proof nothing moved.
    await expect(send([releaseEscrowIx({
      client: client.publicKey, jobId: id, provider: provider.publicKey,
    })], [client])).rejects.toThrow();
    expect(await lamportsOf(provider.publicKey) - paidBefore).toBe(Number(amount));
    // eslint-disable-next-line no-console
    console.log(`  release_escrow ${sig}  escrow=${escrowKey.toBase58()} paid=${amount}`);
  });

  it("a refund before the deadline is refused; at the deadline a stranger may trigger it", async () => {
    const vault = await provision();
    const id = jobId("timeout");
    const amount = 500_000n;
    // A deadline seconds away rather than days: this test waits for a real clock,
    // and a 3_600-second wait is a test that never runs.
    const deadline = Math.floor(Date.now() / 1000) + 12;
    await send([lockEscrowIx({
      client: client.publicKey, provider: provider.publicKey, jobId: id,
      amount, timeout: BigInt(deadline), refundRouteHash: routeHashFor("autonomous timeout refund"),
    })], [client]);

    const [escrowKey] = escrowPda(vault, id);
    const vaultBefore = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));

    // Before the deadline, the keeper is nobody.
    await expect(send([refundEscrowIx({
      caller: keeper.publicKey, escrowClient: client.publicKey, jobId: id,
    })], [keeper])).rejects.toThrow();

    const secondsLeft = deadline - Math.floor(Date.now() / 1000) + 2;
    // eslint-disable-next-line no-console
    console.log(`  waiting ${secondsLeft}s for the job's deadline…`);
    await new Promise((r) => setTimeout(r, secondsLeft * 1_000));

    const sig = await send([refundEscrowIx({
      caller: keeper.publicKey, escrowClient: client.publicKey, jobId: id,
    })], [keeper]);

    const escrow = decodeJobEscrow(Buffer.from((await conn().getAccountInfo(escrowKey))!.data));
    const after = decodeVault(Buffer.from((await conn().getAccountInfo(vault))!.data));
    expect([escrow.completed, escrow.refunded]).toEqual([false, true]);
    // The capital returned to the client's own headroom; Mitra's total never moved,
    // because the money was never out of it.
    expect(after.available).toBe(vaultBefore.available + amount);
    expect(after.escrowed).toBe(vaultBefore.escrowed - amount);
    expect(after.total).toBe(vaultBefore.total);
    // eslint-disable-next-line no-console
    console.log(`  refund_escrow  ${sig}  escrow=${escrowKey.toBase58()} returned=${amount}`);
  });
});
