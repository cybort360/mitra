/**
 * The Solana escrow rail: real `lock_escrow` / `release_escrow` / `refund_escrow`.
 *
 * ## Where the signing key comes from
 *
 * `lockEscrowIx` takes `client` as the **signer** and derives the vault PDA from it, so the
 * authority keypair *is* the escrow's client. That is not a choice this module makes — it
 * is how `vaultPda(client)` and the program's `authority` field are defined, and passing
 * anything else would address a vault this key does not control.
 *
 * The key is read from disk per call and never retained on the instance. A long-lived
 * process that holds a signing key in memory is a larger blast radius than one that reads
 * it to sign a single transaction, and this object is constructed at module scope by
 * `escrowRailFor`.
 *
 * ## Confirmation is awaited, and a failure is a failure
 *
 * `sendRawTransaction` returns a signature whether or not the transaction succeeds. LP-2's
 * EVM transport learned this the hard way (its `waitFor` throws on `status !== "success"`),
 * and F82 is the same family of defect on the read side: a transport that reports an
 * unconfirmed or unexecuted transaction as done turns a dual-write system into a
 * dual-*lie*. So every write here waits for the commitment it was configured with and
 * re-reads the resulting account, and a transaction that did not take effect is returned as
 * a refusal.
 *
 * ## The refund is autonomous on purpose
 *
 * `refundEscrowIx` takes a `caller` who pays the fee and needs **no vault authority** —
 * after the deadline anyone may return the capital. That is the property `releaseEscrowIx`
 * cannot offer, and it is why the refund path here uses the same configured authority
 * rather than insisting on a keeper: the rail can demonstrate the recovery route without
 * requiring a second funded identity.
 */

import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  decodeJobEscrow, escrowPda, jobIdFor, lockEscrowIx, refundEscrowIx, releaseEscrowIx,
  vaultPda, VAULT_PROGRAM_ID,
} from "@/lib/solana/vault-program";
import type { SolanaEscrowRail, SolanaLockTerms } from "@/lib/commerce/onchain-escrow";

export interface SolanaEscrowRailOptions {
  /** Required unless `connection` is supplied. */
  rpcUrl?: string;
  /** The escrow's client/authority. Its vault PDA is derived from this key. */
  client: Keypair;
  /** Commitment level for both the write confirmation and the read. */
  commitment?: "confirmed" | "finalized";
  programId?: PublicKey;
  /**
   * A pre-built `Connection`, for tests.
   *
   * The claims worth testing here are about what the rail did to the chain — that it
   * awaited confirmation, that it re-read the resulting account, that it took the provider
   * from the account rather than the caller. None of that is observable without a seam, and
   * monkey-patching a `private readonly` field is the kind of cleverness that outlives its
   * reason.
   */
  connection?: Connection;
  /**
   * The vault PDA the deployment expects, when known.
   *
   * Checked rather than trusted: a keyfile paired with the wrong `MITRA_SOLANA_VAULT`
   * would otherwise derive a *different* vault and move lamports from the wrong account,
   * or fail at the program with an error that does not name the cause.
   */
  expectVault?: string;
}

export class SolanaEscrowRailImpl implements SolanaEscrowRail {
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(private readonly opts: SolanaEscrowRailOptions) {
    if (!opts.connection && !opts.rpcUrl) {
      throw new Error("SOLANA_RAIL_NEEDS_RPC_URL: supply rpcUrl or a pre-built connection");
    }
    this.connection = opts.connection ?? new Connection(opts.rpcUrl!, opts.commitment ?? "confirmed");
    this.programId = opts.programId ?? new PublicKey(VAULT_PROGRAM_ID);
    const [vault] = vaultPda(opts.client.publicKey, this.programId);
    if (opts.expectVault && opts.expectVault !== vault.toBase58()) {
      throw new Error(
        `SOLANA_VAULT_MISMATCH: ${opts.client.publicKey.toBase58()} derives vault ${vault.toBase58()}, deployment says ${opts.expectVault}`,
      );
    }
  }

  /** The escrow's client, as base58. `client` is derived from the signing key. */
  get authority(): string {
    return this.opts.client.publicKey.toBase58();
  }

  /** The vault this rail moves lamports out of. Surfaced so a refusal can name it. */
  get vault(): PublicKey {
    return vaultPda(this.opts.client.publicKey, this.programId)[0];
  }

  async readEscrow(jobId: Uint8Array): Promise<Buffer | null> {
    const [escrow] = escrowPda(this.vault, jobId, this.programId);
    const info = await this.connection.getAccountInfo(escrow, this.opts.commitment ?? "confirmed");
    // `data` is a Buffer when the encoding is binary. Anything else is not an escrow we can
    // read, and returning it as-is would hand `decodeJobEscrow` a string.
    if (!info) return null;
    return Buffer.from(info.data);
  }

  async lockEscrow(jobId: Uint8Array, terms: SolanaLockTerms): Promise<string> {
    return this.send(
      lockEscrowIx({
        client: this.opts.client.publicKey,
        provider: new PublicKey(terms.provider),
        jobId,
        amount: terms.amount,
        timeout: terms.timeout,
        refundRouteHash: terms.refundRouteHash,
      }, this.programId),
      [this.opts.client],
      { jobId, what: "lockEscrow" },
    );
  }

  async releaseEscrow(jobId: Uint8Array): Promise<string> {
    const provider = await this.recordedProvider(jobId);
    return this.send(
      releaseEscrowIx({ client: this.opts.client.publicKey, jobId, provider }, this.programId),
      [this.opts.client],
      { jobId, what: "releaseEscrow" },
    );
  }

  async refundEscrow(jobId: Uint8Array): Promise<string> {
    return this.send(
      refundEscrowIx({ caller: this.opts.client.publicKey, escrowClient: this.opts.client.publicKey, jobId }, this.programId),
      [this.opts.client],
      { jobId, what: "refundEscrow" },
    );
  }

  /**
   * The provider recorded at funding, for `releaseEscrow`.
   *
   * `releaseEscrowIx` names the provider as a positional account because Solana requires
   * every account in the message; the program then refuses the instruction unless it is
   * the key the escrow recorded. So it must be **read**, not supplied — a caller-chosen
   * provider would pay whoever was named, and reading it here means the payment can only
   * go to the party the escrow committed to.
   */
  private async recordedProvider(jobId: Uint8Array): Promise<PublicKey> {
    const data = await this.readEscrow(jobId);
    if (!data) throw new Error(`NO_ESCROW_FOR_JOB: ${Buffer.from(jobId).toString("hex")}`);
    return decodeJobEscrow(data).provider;
  }

  /**
   * Send, wait for the signature to be observed, and **verify the effect**.
   *
   * The re-read is the part that matters. A confirmed transaction with a real signature is
   * not the same claim as "the escrow now exists", and the second is what the caller is
   * about to record.
   */
  private async send(
    ix: TransactionInstruction,
    signers: Keypair[],
    ctx: { jobId: Uint8Array; what: string },
  ): Promise<string> {
    const tx = new Transaction().add(ix);
    tx.feePayer = this.opts.client.publicKey;

    // Fetched ONCE. Two calls mean two different blockhashes, and the one that ends up on
    // the transaction is not the one paired with `lastValidBlockHeight` for the confirmation
    // — which surfaces as an intermittent "block height exceeded" on a transaction that was
    // perfectly valid.
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.opts.commitment ?? "confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(...signers);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: this.opts.commitment ?? "confirmed",
    });

    try {
      await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, this.opts.commitment ?? "confirmed");
    } catch (e) {
      throw new Error(`${ctx.what} NOT CONFIRMED (${signature}): ${(e as Error).message}`);
    }

    // Confirm the effect, not just the transaction. A confirmed tx that reverted is
    // possible on Solana if the preflight commitment is weaker than the final one.
    if (ctx.what === "lockEscrow") {
      const data = await this.readEscrow(ctx.jobId);
      if (!data) throw new Error(`${ctx.what} CONFIRMED BUT NO ESCROW EXISTS (${signature})`);
      const escrow = decodeJobEscrow(data);
      if (escrow.amount === 0n) throw new Error(`${ctx.what} CONFIRMED BUT ESCROW IS EMPTY (${signature})`);
      if (!escrow.refundRouteHash.some((b) => b !== 0)) {
        // §15.5: an escrow with no commitment cannot be refunded. Reaching this means the
        // route hash did not reach the account, which is worth failing loudly over rather
        // than discovering at refund time.
        throw new Error(`${ctx.what} CONFIRMED WITHOUT A §15.5 COMMITMENT (${signature})`);
      }
    }

    return signature;
  }
}

/** Reads a Solana secret key from a JSON array of bytes, as `scripts/dev-keys.mjs` writes. */
export function readSolanaKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export { jobIdFor };
