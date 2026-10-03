/**
 * The Solana vault transport against a scripted cluster.
 *
 * The cluster's accounts are the program's OWN bytes — the Rust-generated golden
 * mandate and permit, patched at the documented offsets for these test keys — so
 * the transport is decoding what the program writes, not what this file imagines.
 * `verify` is fed the very transaction `send` signed, decompiled, so the happy
 * path is not a hand-built shape; each negative breaks exactly one property of it.
 *
 * The live block at the bottom (SOLANA_LIVE=1) needs `mitra-vault` redeployed with
 * the F51 layout. Until then it is UNTESTED, and says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { AssetSymbol } from "@/lib/domain/types";
import { SolanaSettlementAdapter, solanaCommitment } from "@/lib/adapters/solana";
import { VaultTransport, connectionRpc, type SolanaRpc, type SolanaTxView } from "@/lib/adapters/solana-transport";
import {
  VAULT_PROGRAM_ID, authorizationPda, authorizeIx, depositIx, initializeVaultIx, mandatePda, openMandateIx,
  spendAuthorizedIx, vaultPda, decodeMandate,
} from "@/lib/solana/vault-program";

const g = JSON.parse(readFileSync("programs/mitra-vault/tests/golden/vault-layout.json", "utf8"));
const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));

const engine = seeded(7);
const holder = seeded(8).publicKey;
const principal = seeded(9).publicKey;
const recipient = seeded(10).publicKey;
const [vault] = vaultPda(principal);
const [mandateKey] = mandatePda(holder);
const AMOUNT = 3_000n; // lamports; the golden mandate's limit is 5_000
const COMMIT = `0x${"cd".repeat(32)}`;
const ACTION = Buffer.from(COMMIT.slice(2), "hex");
const [permitKey] = authorizationPda(holder, ACTION);
const SIG = "5".repeat(88);

/** The golden mandate, re-keyed for this test's holder, principal and engine. */
function mandateBytes(over: { revoked?: boolean; engine?: PublicKey; principal?: PublicKey; limit?: bigint } = {}) {
  const b = Buffer.from(g.accounts.mandate, "hex");
  holder.toBuffer().copy(b, 8);
  if (over.limit !== undefined) b.writeBigUInt64LE(over.limit, 40);
  b[72] = over.revoked ? 1 : 0;
  (over.principal ?? principal).toBuffer().copy(b, 74);
  (over.engine ?? engine.publicKey).toBuffer().copy(b, 106);
  return b;
}

/** The golden CONSUMED permit, re-keyed. */
function permitBytes(over: { consumed?: boolean; amount?: bigint; recipient?: PublicKey } = {}) {
  const b = Buffer.from(g.accounts.authorizationConsumed, "hex");
  holder.toBuffer().copy(b, 8);
  ACTION.copy(b, 40);
  b.writeBigUInt64LE(over.amount ?? AMOUNT, 72);
  b[96] = over.consumed === false ? 0 : 1;
  (over.recipient ?? recipient).toBuffer().copy(b, 98);
  return b;
}

type Accounts = Map<string, { data: Buffer; owner: PublicKey }>;

function fakeCluster(accounts: Accounts, view?: SolanaTxView | null) {
  const sent: Buffer[] = [];
  const rpc: SolanaRpc = {
    getAccountInfo: async (pk) => accounts.get(pk.toBase58()) ?? null,
    getLatestBlockhash: async () => ({ blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" }),
    sendRawTransaction: async (raw) => { sent.push(raw); return SIG; },
    getTransaction: async () => view ?? null,
  };
  return { rpc, sent };
}

const withMandate = (data = mandateBytes()): Accounts =>
  new Map([[mandateKey.toBase58(), { data, owner: VAULT_PROGRAM_ID }]]);

const sendInput = { from: vault.toBase58(), to: recipient.toBase58(), amountAtomic: AMOUNT.toString(), mint: null, commitment: COMMIT };

// ── send ────────────────────────────────────────────────────────────────────

describe("VaultTransport.send — one transaction: authorize, then spend", () => {
  it("signs, as the engine and fee payer, exactly the two instructions the program expects", async () => {
    const c = fakeCluster(withMandate());
    const r = await new VaultTransport({ rpc: c.rpc, engine, holder }).send(sendInput);
    expect(r.txHash).toBe(SIG);

    const tx = Transaction.from(c.sent[0]);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.equals(engine.publicKey)).toBe(true);
    expect(tx.instructions).toHaveLength(2);
    // The builders are pinned to the Rust golden bytes (vault-program.test.ts),
    // so equality here means the program would parse what was signed.
    const auth = authorizeIx({ engine: engine.publicKey, holder, action: ACTION, amount: AMOUNT, recipient });
    const spend = spendAuthorizedIx({ principal, holder, action: ACTION, recipient });
    expect(tx.instructions[0].data.equals(auth.data)).toBe(true);
    expect(tx.instructions[1].data.equals(spend.data)).toBe(true);
    expect(tx.instructions[1].keys.map((k) => k.pubkey.toBase58())).toEqual(spend.keys.map((k) => k.pubkey.toBase58()));
  });

  it.each([
    ["an SPL mint (the vault moves lamports only)", {}, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, "VAULT_SETTLES_NATIVE_SOL_ONLY"],
    ["a commitment that is not 32 bytes", {}, { commitment: "0xabcd" }, "COMMITMENT_NOT_BYTES32"],
    ["a zero amount", {}, { amountAtomic: "0" }, "INVALID_ATOMIC_AMOUNT"],
    ["a malformed recipient", {}, { to: "not-a-key" }, "INVALID_RECIPIENT_ADDRESS"],
    ["no mandate on chain", { accounts: new Map() }, {}, "MANDATE_NOT_FOUND"],
    ["a mandate account another program owns", { accounts: new Map([[mandateKey.toBase58(), { data: mandateBytes(), owner: SystemProgram.programId }]]) }, {}, "MANDATE_NOT_FOUND"],
    ["a pre-F51 (unbound) mandate", { accounts: withMandate(mandateBytes().subarray(0, 97)) }, {}, "MANDATE_UNBOUND"],
    ["a mandate naming a different engine", { accounts: withMandate(mandateBytes({ engine: seeded(66).publicKey })) }, {}, "POLICY_ENGINE_MISMATCH"],
    ["a revoked mandate", { accounts: withMandate(mandateBytes({ revoked: true })) }, {}, "MANDATE_REVOKED"],
    ["an amount above the mandate limit", { accounts: withMandate(mandateBytes({ limit: AMOUNT - 1n })) }, {}, "EXCEEDS_MANDATE_LIMIT"],
    ["a source other than the principal's vault", {}, { from: vaultPda(seeded(55).publicKey)[0].toBase58() }, "VAULT_MISMATCH"],
    ["a commitment that was already authorized", {
      accounts: new Map([...withMandate(), [permitKey.toBase58(), { data: permitBytes(), owner: VAULT_PROGRAM_ID }]]),
    }, {}, "SETTLEMENT_ALREADY_AUTHORIZED"],
  ])("refuses %s, and broadcasts nothing", async (_n, world, override, error) => {
    const c = fakeCluster((world as { accounts?: Accounts }).accounts ?? withMandate());
    await expect(new VaultTransport({ rpc: c.rpc, engine, holder }).send({ ...sendInput, ...override } as typeof sendInput))
      .rejects.toThrow(error);
    expect(c.sent).toHaveLength(0);
  });
});

// ── verify ──────────────────────────────────────────────────────────────────

/** The transaction `send` really signed, decompiled into what an RPC returns. */
async function signedView(): Promise<SolanaTxView> {
  const c = fakeCluster(withMandate());
  await new VaultTransport({ rpc: c.rpc, engine, holder }).send(sendInput);
  const msg = Transaction.from(c.sent[0]).compileMessage();
  const accountKeys = msg.accountKeys.map((k) => k.toBase58());
  const pre = accountKeys.map((k) => (k === vault.toBase58() ? 1_000_000_000 : k === engine.publicKey.toBase58() ? 50_000_000 : 0));
  const post = accountKeys.map((k, i) =>
    k === recipient.toBase58() ? pre[i] + Number(AMOUNT)
      : k === vault.toBase58() ? pre[i] - Number(AMOUNT)
        : k === engine.publicKey.toBase58() ? pre[i] - 5_000 - 1_795_680 // fee + permit rent
          : k === permitKey.toBase58() ? 1_795_680 : pre[i]);
  return {
    err: null,
    usesLookupTables: false,
    accountKeys,
    instructions: msg.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: Buffer.from(i.data) })),
    preBalances: pre,
    postBalances: post,
  };
}

const settledWorld = (permit = permitBytes(), mandate = mandateBytes()): Accounts => new Map([
  [mandateKey.toBase58(), { data: mandate, owner: VAULT_PROGRAM_ID }],
  [permitKey.toBase58(), { data: permit, owner: VAULT_PROGRAM_ID }],
]);

async function confirmed(view: SolanaTxView | null, accounts = settledWorld(), h = holder) {
  const c = fakeCluster(accounts, view);
  return (await new VaultTransport({ rpc: c.rpc, engine, holder: h }).verify(SIG)).confirmed;
}

describe("VaultTransport.verify — the transaction's own record, and the permit consumed", () => {
  it("confirms the signed pair with exact lamport movement and a consumed permit", async () => {
    expect(await confirmed(await signedView())).toBe(true);
  });

  const progIdx = (v: SolanaTxView) => v.accountKeys.indexOf(VAULT_PROGRAM_ID.toBase58());
  const recIdx = (v: SolanaTxView) => v.accountKeys.indexOf(recipient.toBase58());
  const vaultIdx = (v: SolanaTxView) => v.accountKeys.indexOf(vault.toBase58());

  it.each<[string, (v: SolanaTxView) => SolanaTxView | null, Accounts?, PublicKey?]>([
    ["the transaction is not found", () => null],
    ["the transaction failed", (v) => ({ ...v, err: { InstructionError: [1, { Custom: 6016 }] } })],
    ["the message used lookup tables", (v) => ({ ...v, usesLookupTables: true })],
    ["there is no authorize instruction", (v) => ({ ...v, instructions: v.instructions.slice(1) })],
    ["there is no spend instruction", (v) => ({ ...v, instructions: v.instructions.slice(0, 1) })],
    ["the instructions target another program", (v) => {
      const keys = [...v.accountKeys]; keys[progIdx(v)] = SystemProgram.programId.toBase58(); return { ...v, accountKeys: keys };
    }],
    ["the spend names a different action", (v) => {
      const ins = v.instructions.map((i) => ({ ...i, data: Buffer.from(i.data) })); ins[1].data[8] ^= 1; return { ...v, instructions: ins };
    }],
    ["the spend pays someone the permit did not name", (v) => {
      const keys = [...v.accountKeys, seeded(77).publicKey.toBase58()];
      const ins = v.instructions.map((i, n) => (n === 1 ? { ...i, accounts: [keys.length - 1, ...i.accounts.slice(1)] } : i));
      return { ...v, accountKeys: keys, instructions: ins, preBalances: [...v.preBalances, 0], postBalances: [...v.postBalances, Number(AMOUNT)] };
    }],
    ["the recipient received less than the permit amount", (v) => {
      const post = [...v.postBalances]; post[recIdx(v)] -= 1; return { ...v, postBalances: post };
    }],
    ["the vault was debited a different amount", (v) => {
      const post = [...v.postBalances]; post[vaultIdx(v)] -= 1; return { ...v, postBalances: post };
    }],
    ["the permit is not consumed", (v) => v, settledWorld(permitBytes({ consumed: false }))],
    ["the permit records a different amount", (v) => v, settledWorld(permitBytes({ amount: AMOUNT + 1n }))],
    ["the permit is missing", (v) => v, withMandate()],
    ["the vault debited is not the mandate principal's", (v) => v, settledWorld(permitBytes(), mandateBytes({ principal: seeded(55).publicKey }))],
    ["the transaction is for a different holder", (v) => v, settledWorld(), seeded(44).publicKey],
    // Isolates the principal-vault check: the principal's vault ALSO moved by
    // exactly the amount, but the spend debited a different account.
    ["the spend debited an account other than the principal's vault", (v) => {
      const other = seeded(88).publicKey.toBase58();
      const keys = [...v.accountKeys, other];
      const ins = v.instructions.map((i, n) => (n === 1 ? { ...i, accounts: [i.accounts[0], keys.length - 1, ...i.accounts.slice(2)] } : i));
      return { ...v, accountKeys: keys, instructions: ins, preBalances: [...v.preBalances, 1_000_000_000], postBalances: [...v.postBalances, 1_000_000_000 - Number(AMOUNT)] };
    }],
    ["the permit lookalike is owned by another program", (v) => v,
      new Map([...withMandate(), [permitKey.toBase58(), { data: permitBytes(), owner: SystemProgram.programId }]])],
  ])("does not confirm when %s", async (_n, mutate, accounts, h) => {
    expect(await confirmed(mutate(await signedView()), accounts ?? settledWorld(), h ?? holder)).toBe(false);
  });

  it("does not ask the cluster about a malformed signature", async () => {
    const c = fakeCluster(settledWorld(), await signedView());
    let asked = false;
    c.rpc.getTransaction = async () => { asked = true; return null; };
    expect((await new VaultTransport({ rpc: c.rpc, engine, holder }).verify("0xnot-base58")).confirmed).toBe(false);
    expect(asked).toBe(false);
  });
});

// ── through the adapter ─────────────────────────────────────────────────────

describe("SolanaSettlementAdapter over VaultTransport", () => {
  it("settles: the commitment is the program's action_hash", async () => {
    const c = fakeCluster(withMandate());
    const adapter = new SolanaSettlementAdapter({ transport: new VaultTransport({ rpc: c.rpc, engine, holder }) });
    const intent = { settlementId: "s1", from: vault.toBase58(), to: recipient.toBase58(), amount: { asset: "SOL" as AssetSymbol, amount: 0.000003 } };
    const commitmentHash = solanaCommitment(intent);
    await adapter.settle({ ...intent, commitmentHash });

    const tx = Transaction.from(c.sent[0]);
    expect(tx.instructions[0].data.subarray(8, 40).toString("hex")).toBe(commitmentHash.slice(2));
    expect(tx.instructions[0].data.readBigUInt64LE(40)).toBe(3_000n);
  });

  it("a second settlement with the same commitment is refused before it is sent", async () => {
    const intent = { settlementId: "s1", from: vault.toBase58(), to: recipient.toBase58(), amount: { asset: "SOL" as AssetSymbol, amount: 0.000003 } };
    const commitmentHash = solanaCommitment(intent);
    const [pk] = authorizationPda(holder, Buffer.from(commitmentHash.slice(2), "hex"));
    const c = fakeCluster(new Map([...withMandate(), [pk.toBase58(), { data: permitBytes(), owner: VAULT_PROGRAM_ID }]]));
    const adapter = new SolanaSettlementAdapter({ transport: new VaultTransport({ rpc: c.rpc, engine, holder }) });
    await expect(adapter.settle({ ...intent, commitmentHash })).rejects.toThrow("SETTLEMENT_ALREADY_AUTHORIZED");
    expect(c.sent).toHaveLength(0);
  });
});

describe("solanaCommitment — a real digest, now that it keys permits on chain", () => {
  const base = { settlementId: "s1", from: vault.toBase58(), to: recipient.toBase58(), amount: { asset: "SOL" as AssetSymbol, amount: 0.000003 } };

  it("is 32 bytes", () => {
    expect(solanaCommitment(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("binds the program id: a commitment for another deployment differs", () => {
    expect(solanaCommitment({ ...base, programId: SystemProgram.programId.toBase58() })).not.toBe(solanaCommitment(base));
  });

  it("binds the ATOMIC amount: one lamport apart differs", () => {
    expect(solanaCommitment({ ...base, amount: { ...base.amount, amount: 0.000003001 } })).not.toBe(solanaCommitment(base));
  });

  it("fields cannot bleed into each other (the old '|' join could)", () => {
    // Under "a|b" joining these two produced the same preimage.
    const a = solanaCommitment({ ...base, settlementId: "s1|x", from: "y" });
    const b = solanaCommitment({ ...base, settlementId: "s1", from: "x|y" });
    expect(a).not.toBe(b);
  });

  it("refuses an asset the vault cannot move", () => {
    expect(() => solanaCommitment({ ...base, amount: { asset: "USDC" as AssetSymbol, amount: 1 } })).toThrow("UNSUPPORTED_ASSET_ON_SOLANA");
  });
});

// ── live devnet (SOLANA_LIVE=1) ─────────────────────────────────────────────

/**
 * Provisions its own world — principal vault, engine, holder, payee — from the dev
 * key, then settles through the adapter and confirms from the chain.
 *
 * REQUIRES `mitra-vault` redeployed with the F51 layout. Against the program
 * deployed before F51, `open_mandate` fails (the old handler reads the principal
 * as the holder and has no engine argument); that failure means "not redeployed",
 * not "transport broken". Needs ~0.2 devnet SOL on .dev-keys/solana-testnet.json.
 */
const KEY = ".dev-keys/solana-testnet.json";
const live = process.env.SOLANA_LIVE === "1" && existsSync(KEY);
describe.skipIf(!live)("live Solana devnet (SOLANA_LIVE=1)", () => {
  it("provisions, settles through the adapter, and confirms from the cluster", async () => {
    const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const principalKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
    const derive = (role: string) => Keypair.fromSeed(createHash("sha256").update(`mitra-solana-settlement:${role}:${principalKp.publicKey.toBase58()}`).digest());
    const liveEngine = derive("engine");
    const liveHolder = derive("holder").publicKey;
    const payee = derive("payee").publicKey;
    const [liveVault] = vaultPda(principalKp.publicKey);
    const send = (tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(conn, tx, signers);

    if (!(await conn.getAccountInfo(liveVault))) await send(new Transaction().add(initializeVaultIx(principalKp.publicKey)), [principalKp]);
    await send(new Transaction().add(
      depositIx(principalKp.publicKey, liveVault, 2_000_000n),
      // Fees and permit rent for the engine; rent-exemption for a fresh payee,
      // without which the runtime refuses a small credit to an empty account.
      SystemProgram.transfer({ fromPubkey: principalKp.publicKey, toPubkey: liveEngine.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: principalKp.publicKey, toPubkey: payee, lamports: 1_000_000 }),
    ), [principalKp]);

    const mAcct = await conn.getAccountInfo(mandatePda(liveHolder)[0]);
    if (!mAcct) {
      await send(new Transaction().add(openMandateIx({
        principal: principalKp.publicKey, holder: liveHolder, limit: 1_000_000n, ceiling: 10_000_000n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), policyEngine: liveEngine.publicKey,
      })), [principalKp]);
    } else {
      expect(decodeMandate(Buffer.from(mAcct.data)).binding, "mandate must be bound (F51 layout)").not.toBeNull();
    }

    const adapter = new SolanaSettlementAdapter({ transport: new VaultTransport({ rpc: connectionRpc(conn), engine: liveEngine, holder: liveHolder }) });
    const intent = { settlementId: `live-${Date.now()}`, from: liveVault.toBase58(), to: payee.toBase58(), amount: { asset: "SOL" as AssetSymbol, amount: 0.000003 } };
    const { txHash } = await adapter.settle({ ...intent, commitmentHash: solanaCommitment(intent) });

    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      ok = (await adapter.verify(txHash)).confirmed;
    }
    console.log(`live solana settlement ${txHash} confirmed=${ok}`);
    expect(ok).toBe(true);
  }, 180_000);

  /**
   * F51 on the DEPLOYED program, not only in-process: a funded key that is not
   * the mandate's engine tries to issue a permit. Simulated, so it costs nothing
   * and changes nothing. Before F51 this succeeded for any signer.
   */
  it("the deployed program refuses a permit from anyone but the mandate's engine", async () => {
    const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const principalKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
    const derive = (role: string) => Keypair.fromSeed(createHash("sha256").update(`mitra-solana-settlement:${role}:${principalKp.publicKey.toBase58()}`).digest());
    const liveHolder = derive("holder").publicKey;
    // The principal: funded and real, but NOT the engine its own mandate names.
    const stranger = principalKp;
    const tx = new Transaction().add(authorizeIx({
      engine: stranger.publicKey, holder: liveHolder, action: new Uint8Array(32).fill(0x5a), amount: 3_000n, recipient: stranger.publicKey,
    }));
    tx.feePayer = stranger.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(stranger);
    const sim = await conn.simulateTransaction(tx);
    console.log(`simulated stranger authorize err=${JSON.stringify(sim.value.err)}`);
    expect(sim.value.err).toEqual({ InstructionError: [0, { Custom: 6015 }] }); // POLICY_ENGINE_MISMATCH
  }, 60_000);
});
