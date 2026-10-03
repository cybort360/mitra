/**
 * Solana transport — the live half of `SolanaSettlementAdapter`, against
 * `mitra-vault` with the F51 layout.
 *
 * ## A settlement is one transaction: `authorize` then `spend_authorized`
 *
 * The engine issues the permit (naming the payee and the amount) and the same
 * transaction spends it. Packing both means a permit never sits on chain unspent:
 * Solana applies the transaction atomically, so either the permit is created AND
 * consumed, or neither happens. A permit issued in one transaction and spent in a
 * later one would be a public, redeemable object for the gap between them — safe
 * since F51 bound the payee, but a gap with nothing to gain.
 *
 * The commitment is the permit's `action_hash`, so the permit PDA is keyed by the
 * settlement itself: a second settlement with the same commitment cannot be
 * authorized again (the account already exists), which is the replay guard.
 *
 * ## The engine key is a relayer, not root authority
 *
 * Per the lead's decision (shared context seq 55): on testnet the engine key signs
 * and pays fees as an execution relayer under the mandate the PRINCIPAL granted.
 * It can only issue permits within that mandate's limit, from that principal's
 * vault — the program enforces all of it. The checks `send` makes first are there
 * to refuse a doomed transaction before paying for it, not as the guarantee.
 *
 * ## Confirmation is the transaction's own record
 *
 * `verify` requires the pair of instructions in one successful transaction, reads
 * the recipient's and the vault's lamport change from that transaction's meta —
 * runtime-recorded per-transaction balances, not a later balance read that other
 * activity could have moved — and reads the permit back as consumed.
 */

import { PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import type { SolanaTransport } from "./solana";
import type { ChainObservation } from "./types";
import {
  IX, VAULT_PROGRAM_ID,
  authorizationPda, authorizeIx, decodeAuthorization, decodeMandate, mandatePda, spendAuthorizedIx, vaultPda,
} from "@/lib/solana/vault-program";

/** The slice of a transaction `verify` reads. Legacy messages only. */
export interface SolanaTxView {
  err: unknown;
  /** True when the message used address lookup tables; `verify` then refuses. */
  usesLookupTables: boolean;
  accountKeys: string[];
  instructions: Array<{ programIdIndex: number; accounts: number[]; data: Buffer }>;
  preBalances: number[];
  postBalances: number[];
  /** The slot the transaction landed in, as the node reported it. Used as the evidence "block". */
  slot?: number;
}

/** The RPC surface the transport needs. `connectionRpc` adapts a web3.js `Connection`. */
export interface SolanaRpc {
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer; owner: PublicKey } | null>;
  getLatestBlockhash(): Promise<{ blockhash: string }>;
  sendRawTransaction(raw: Buffer): Promise<string>;
  getTransaction(signature: string): Promise<SolanaTxView | null>;
}

export interface VaultTransportOptions {
  rpc: SolanaRpc;
  /** Signs `authorize` and pays fees. Must be the mandate's named policy engine. */
  engine: Keypair;
  /** The agent the mandate authorizes. Its key never signs here. */
  holder: PublicKey;
  programId?: PublicKey;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export class VaultTransport implements SolanaTransport {
  private readonly programId: PublicKey;

  constructor(private readonly opts: VaultTransportOptions) {
    this.programId = opts.programId ?? VAULT_PROGRAM_ID;
  }

  async send(input: { from: string; to: string; amountAtomic: string; mint: string | null; commitment: string }): Promise<{ txHash: string }> {
    // ── refusals that need no network ──────────────────────────────────────
    if (input.mint !== null) throw new Error("VAULT_SETTLES_NATIVE_SOL_ONLY");
    if (!BYTES32.test(input.commitment)) throw new Error("COMMITMENT_NOT_BYTES32");
    if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("INVALID_ATOMIC_AMOUNT");
    const amount = BigInt(input.amountAtomic);
    const action = Buffer.from(input.commitment.slice(2), "hex");
    let recipient: PublicKey;
    try { recipient = new PublicKey(input.to); } catch { throw new Error("INVALID_RECIPIENT_ADDRESS"); }

    // ── the mandate as the chain holds it ──────────────────────────────────
    const [mandateKey] = mandatePda(this.opts.holder, this.programId);
    const acct = await this.opts.rpc.getAccountInfo(mandateKey);
    if (!acct || !acct.owner.equals(this.programId)) throw new Error("MANDATE_NOT_FOUND");
    const mandate = decodeMandate(acct.data);
    if (!mandate.binding) throw new Error("MANDATE_UNBOUND");
    if (!mandate.binding.policyEngine.equals(this.opts.engine.publicKey)) throw new Error("POLICY_ENGINE_MISMATCH");
    if (mandate.revoked) throw new Error("MANDATE_REVOKED");
    if (amount > mandate.limit) throw new Error("EXCEEDS_MANDATE_LIMIT");

    // The source is not the caller's to choose: it is the vault of the principal
    // that granted this mandate. A `from` naming anything else is refused here
    // rather than silently replaced, so a mis-wired caller finds out.
    const [vault] = vaultPda(mandate.binding.principal, this.programId);
    if (input.from !== vault.toBase58()) throw new Error("VAULT_MISMATCH");

    const [permitKey] = authorizationPda(this.opts.holder, action, this.programId);
    if (await this.opts.rpc.getAccountInfo(permitKey)) throw new Error("SETTLEMENT_ALREADY_AUTHORIZED");

    // ── one transaction: issue the permit, then spend it ───────────────────
    const tx = new Transaction();
    tx.feePayer = this.opts.engine.publicKey;
    tx.recentBlockhash = (await this.opts.rpc.getLatestBlockhash()).blockhash;
    tx.add(
      authorizeIx({ engine: this.opts.engine.publicKey, holder: this.opts.holder, action, amount, recipient }, this.programId),
      spendAuthorizedIx({ principal: mandate.binding.principal, holder: this.opts.holder, action, recipient }, this.programId),
    );
    tx.sign(this.opts.engine);
    const txHash = await this.opts.rpc.sendRawTransaction(tx.serialize());
    if (!BASE58_SIG.test(txHash)) throw new Error("NODE_RETURNED_MALFORMED_SIGNATURE");
    return { txHash };
  }

  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    return { confirmed: (await this.observe(txHash)) !== null };
  }

  /**
   * What the chain shows for a settlement, or null if it is not a confirmed one.
   * `verify` is exactly `observe(...) !== null`. The carried commitment is the
   * permit's `action_hash`, read from the authorize instruction's own data.
   */
  async observe(txHash: string): Promise<ChainObservation | null> {
    if (!BASE58_SIG.test(txHash)) return null;
    const tx = await this.opts.rpc.getTransaction(txHash);
    if (!tx || tx.err !== null || tx.usesLookupTables) return null;

    const ours = tx.instructions.filter((i) => tx.accountKeys[i.programIdIndex] === this.programId.toBase58());
    const auth = ours.find((i) => i.data.subarray(0, 8).equals(IX.authorize));
    const spend = ours.find((i) => i.data.subarray(0, 8).equals(IX.spendAuthorized));
    if (!auth || !spend || auth.data.length < 80 || spend.data.length !== 40) return null;

    // What the permit said, from the authorize instruction's own data.
    const action = auth.data.subarray(8, 40);
    const amount = auth.data.readBigUInt64LE(40);
    const permitRecipient = new PublicKey(auth.data.subarray(48, 80)).toBase58();
    if (!spend.data.subarray(8, 40).equals(action)) return null;

    const key = (ix: { accounts: number[] }, n: number) => tx.accountKeys[ix.accounts[n]];
    // The permit address is a PDA of (holder, action), and the program refuses an
    // authorization account that is not the PDA of the holder it was handed. So the
    // permit matching OUR holder's PDA is what proves the holder; a separate check
    // of the holder account would be redundant and is not repeated here.
    const [permitKey] = authorizationPda(this.opts.holder, action, this.programId);
    if (key(auth, 3) !== permitKey.toBase58() || key(spend, 2) !== permitKey.toBase58()) return null;
    if (key(spend, 0) !== permitRecipient) return null;

    // The vault debited must be the vault of the principal that granted the mandate.
    const mAcct = await this.opts.rpc.getAccountInfo(mandatePda(this.opts.holder, this.programId)[0]);
    if (!mAcct) return null;
    const binding = decodeMandate(mAcct.data).binding;
    if (!binding) return null;
    const vault = vaultPda(binding.principal, this.programId)[0].toBase58();
    if (key(spend, 1) !== vault) return null;

    // Exact lamport movement, from this transaction's runtime-recorded balances.
    const delta = (addr: string) => {
      const i = tx.accountKeys.indexOf(addr);
      return i < 0 ? null : BigInt(tx.postBalances[i]) - BigInt(tx.preBalances[i]);
    };
    if (delta(permitRecipient) !== amount) return null;
    if (delta(vault) !== -amount) return null;

    // Single use: the permit exists, is this permit, and is consumed.
    const pAcct = await this.opts.rpc.getAccountInfo(permitKey);
    if (!pAcct || !pAcct.owner.equals(this.programId)) return null;
    const permit = decodeAuthorization(pAcct.data);
    const consistent = permit.consumed && permit.amount === amount && permit.recipient.toBase58() === permitRecipient;
    if (!consistent) return null;
    return {
      txHash,
      block: tx.slot ?? 0,
      carriedCommitment: `0x${Buffer.from(action).toString("hex")}`,
      from: vault,
      to: permitRecipient,
      amountAtomic: amount,
      asset: null,
    };
  }
}

/** Adapts a web3.js `Connection` to `SolanaRpc`. */
export function connectionRpc(conn: import("@solana/web3.js").Connection): SolanaRpc {
  return {
    getAccountInfo: async (pk) => {
      const a = await conn.getAccountInfo(pk, "confirmed");
      return a ? { data: Buffer.from(a.data), owner: a.owner } : null;
    },
    getLatestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    sendRawTransaction: (raw) => conn.sendRawTransaction(raw),
    getTransaction: async (sig) => {
      const r = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!r || !r.meta) return null;
      const msg = r.transaction.message;
      return {
        slot: r.slot,
        err: r.meta.err,
        usesLookupTables: msg.addressTableLookups.length > 0,
        accountKeys: msg.staticAccountKeys.map((k) => k.toBase58()),
        instructions: msg.compiledInstructions.map((i) => ({
          programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: Buffer.from(i.data),
        })),
        preBalances: r.meta.preBalances,
        postBalances: r.meta.postBalances,
      };
    },
  };
}
