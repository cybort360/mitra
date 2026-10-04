/**
 * Client for the `mitra-vault` program (PRD §34) — the F51 layout.
 *
 * Instruction builders, account decoders and PDA derivation, and nothing else: no
 * RPC, no keys. Every byte this module produces or reads is pinned to
 * `programs/mitra-vault/tests/golden/vault-layout.json`, which the RUST program
 * generates from its own types and whose instructions its real `dispatch`
 * accepted. `tests/vault-program.test.ts` holds this file to those bytes.
 *
 * That pin is the point. Hand-written encoders on both sides of a boundary agree
 * with themselves and can be wrong together (F12, F45); a TS encoder checked only
 * against a TS decoder proves nothing about what the program will accept.
 *
 * ## The F51 roles, which the account lists encode
 *
 *   principal — owns the vault, grants and amends the mandate
 *   holder    — the agent the mandate authorizes; may only revoke
 *   engine    — the one key that may issue permits under the mandate
 *   recipient — named by the engine inside the permit; the only possible payee
 *
 * `spend_authorized` has no signer at all: anyone may submit it, which is safe only
 * because the vault, the amount and the payee are all read from chain state.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { sha256, toBytes } from "viem";

export const VAULT_PROGRAM_ID = new PublicKey("GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY");

/** Anchor's derivation: the first 8 bytes of sha256 over a namespaced name. */
const anchorDisc = (preimage: string) => Buffer.from(sha256(toBytes(preimage), "bytes").subarray(0, 8));

export const IX = {
  initializeVault: anchorDisc("global:initialize_vault"),
  deposit: anchorDisc("global:deposit"),
  openMandate: anchorDisc("global:open_mandate"),
  authorize: anchorDisc("global:authorize"),
  spendAuthorized: anchorDisc("global:spend_authorized"),
  amendMandate: anchorDisc("global:amend_mandate"),
} as const;

export const ACCOUNT = {
  vault: anchorDisc("account:Vault"),
  mandate: anchorDisc("account:Mandate"),
  authorization: anchorDisc("account:Authorization"),
} as const;

export const VAULT_LEN = 105;
export const MANDATE_LEN = 138;
export const MANDATE_LEN_PRE_BINDING = 97;
export const MANDATE_LEN_PRE_REVOCATION = 96;
export const AUTHORIZATION_LEN = 130;

/** Program error codes the client needs to recognise (anchor_parity::err). */
export const VAULT_ERRORS = {
  6000: "NOT_SIGNER",
  6001: "INVALID_ACCOUNT_OWNER",
  6005: "INSUFFICIENT_AVAILABLE",
  6008: "UNAUTHORIZED",
  6009: "ALREADY_INITIALIZED",
  6010: "EXCEEDS_MANDATE_CEILING",
  6011: "MANDATE_EXPIRED",
  6012: "AUTHORIZATION_CONSUMED",
  6013: "ACTION_HASH_MISMATCH",
  6014: "MANDATE_REVOKED",
  6015: "POLICY_ENGINE_MISMATCH",
  6016: "RECIPIENT_MISMATCH",
  6017: "VAULT_MISMATCH",
  6018: "MANDATE_UNBOUND",
} as const;

// ── PDAs ────────────────────────────────────────────────────────────────────

export const vaultPda = (principal: PublicKey, programId = VAULT_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), principal.toBuffer()], programId);

/**
 * `[b"mandate", principal, holder]` — reseeded in sprint item 7 (was `[b"mandate", holder]`).
 * Matches the program on `feat/solana-reseed-on-v2`; the program deployed
 * before that redeploy still uses the old seed.
 */
export const mandatePda = (principal: PublicKey, holder: PublicKey, programId = VAULT_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("mandate"), principal.toBuffer(), holder.toBuffer()], programId);

/** `[b"authorization", mandate, action]` — keyed by the issuing MANDATE (sprint item 7), not the holder. */
export const authorizationPda = (mandate: PublicKey, action: Uint8Array, programId = VAULT_PROGRAM_ID) => {
  if (action.length !== 32) throw new Error("ACTION_HASH_NOT_32_BYTES");
  return PublicKey.findProgramAddressSync([Buffer.from("authorization"), mandate.toBuffer(), Buffer.from(action)], programId);
};

// ── encoding helpers ────────────────────────────────────────────────────────

const u64 = (n: bigint) => {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("U64_OUT_OF_RANGE");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const readU64 = (b: Buffer, at: number) => b.readBigUInt64LE(at);
const readKey = (b: Buffer, at: number) => new PublicKey(b.subarray(at, at + 32));

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

// ── instructions ────────────────────────────────────────────────────────────

/** `[authority (signer, payer), vault, system_program, program]`, arg `[bump]`. */
export function initializeVaultIx(principal: PublicKey, programId = VAULT_PROGRAM_ID): TransactionInstruction {
  const [vault, bump] = vaultPda(principal, programId);
  return new TransactionInstruction({
    programId,
    keys: [meta(principal, true, true), meta(vault, false, true), meta(SystemProgram.programId, false, false), meta(programId, false, false)],
    data: Buffer.concat([IX.initializeVault, Buffer.from([bump])]),
  });
}

/** `[depositor (signer), vault, system_program]`, arg `[u64 amount]`. */
export function depositIx(depositor: PublicKey, vault: PublicKey, lamports: bigint, programId = VAULT_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [meta(depositor, true, true), meta(vault, false, true), meta(SystemProgram.programId, false, false)],
    data: Buffer.concat([IX.deposit, u64(lamports)]),
  });
}

/**
 * `[principal (signer, payer), holder, mandate, vault, system_program, program]`,
 * args `[u64 limit][u64 ceiling][u64 expires_at][32 policy_engine][u8 bump]`.
 */
export function openMandateIx(
  input: { principal: PublicKey; holder: PublicKey; limit: bigint; ceiling: bigint; expiresAt: bigint; policyEngine: PublicKey },
  programId = VAULT_PROGRAM_ID,
): TransactionInstruction {
  const [mandate, bump] = mandatePda(input.principal, input.holder, programId);
  const [vault] = vaultPda(input.principal, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(input.principal, true, true),
      meta(input.holder, false, false),
      meta(mandate, false, true),
      meta(vault, false, false),
      meta(SystemProgram.programId, false, false),
      meta(programId, false, false),
    ],
    data: Buffer.concat([
      IX.openMandate, u64(input.limit), u64(input.ceiling), u64(input.expiresAt),
      input.policyEngine.toBuffer(), Buffer.from([bump]),
    ]),
  });
}

/**
 * `[engine (signer, payer), holder, mandate, authorization, system_program, program]`,
 * args `[32 action_hash][u64 amount][32 recipient][u8 bump]`.
 */
export function authorizeIx(
  input: { engine: PublicKey; principal: PublicKey; holder: PublicKey; action: Uint8Array; amount: bigint; recipient: PublicKey },
  programId = VAULT_PROGRAM_ID,
): TransactionInstruction {
  const [mandate] = mandatePda(input.principal, input.holder, programId);
  const [authorization, bump] = authorizationPda(mandate, input.action, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(input.engine, true, true),
      meta(input.holder, false, false),
      meta(mandate, false, false),
      meta(authorization, false, true),
      meta(SystemProgram.programId, false, false),
      meta(programId, false, false),
    ],
    data: Buffer.concat([IX.authorize, Buffer.from(input.action), u64(input.amount), input.recipient.toBuffer(), Buffer.from([bump])]),
  });
}

/**
 * `[recipient, vault, authorization, mandate (read-only)]`, arg `[32 action_hash]`.
 *
 * No signer. The mandate is read-only on purpose: it is a policy INPUT to the
 * spend, and a writable mandate would let a transaction that only spends appear
 * to have changed policy.
 */
export function spendAuthorizedIx(
  input: { principal: PublicKey; holder: PublicKey; action: Uint8Array; recipient: PublicKey },
  programId = VAULT_PROGRAM_ID,
): TransactionInstruction {
  const [vault] = vaultPda(input.principal, programId);
  const [mandate] = mandatePda(input.principal, input.holder, programId);
  const [authorization] = authorizationPda(mandate, input.action, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(input.recipient, false, true),
      meta(vault, false, true),
      meta(authorization, false, true),
      meta(mandate, false, false),
    ],
    data: Buffer.concat([IX.spendAuthorized, Buffer.from(input.action)]),
  });
}

/** `[signer, mandate]`, args `[u64 limit][u64 ceiling][u64 expires_at][u8 revoke]`. */
export function amendMandateIx(
  input: { signer: PublicKey; principal: PublicKey; holder: PublicKey; limit: bigint; ceiling: bigint; expiresAt: bigint; revoke: boolean },
  programId = VAULT_PROGRAM_ID,
): TransactionInstruction {
  const [mandate] = mandatePda(input.principal, input.holder, programId);
  return new TransactionInstruction({
    programId,
    keys: [meta(input.signer, true, true), meta(mandate, false, true)],
    data: Buffer.concat([IX.amendMandate, u64(input.limit), u64(input.ceiling), u64(input.expiresAt), Buffer.from([input.revoke ? 1 : 0])]),
  });
}

// ── accounts ────────────────────────────────────────────────────────────────

export interface VaultAccount {
  authority: PublicKey;
  bump: number;
  available: bigint;
  reserved: bigint;
  escrowed: bigint;
  encumbered: bigint;
  settling: bigint;
  frozen: bigint;
  total: bigint;
}

export function decodeVault(data: Buffer): VaultAccount {
  if (data.length !== VAULT_LEN || !data.subarray(0, 8).equals(ACCOUNT.vault)) throw new Error("NOT_A_VAULT_ACCOUNT");
  const at = (i: number) => readU64(data, 41 + i * 8);
  return {
    authority: readKey(data, 8),
    bump: data[40],
    available: at(0), reserved: at(1), escrowed: at(2), encumbered: at(3), settling: at(4), frozen: at(5), total: at(6),
  };
}

export interface MandateAccount {
  holder: PublicKey;
  limit: bigint;
  version: bigint;
  expiresAt: bigint;
  ceiling: bigint;
  revoked: boolean;
  /** Null for a mandate written before binding: inert on chain (6018). */
  binding: { principal: PublicKey; policyEngine: PublicKey } | null;
}

/** Accepts the same three lengths the program does, with the same meanings. */
export function decodeMandate(data: Buffer): MandateAccount {
  const okLen = [MANDATE_LEN, MANDATE_LEN_PRE_BINDING, MANDATE_LEN_PRE_REVOCATION].includes(data.length);
  if (!okLen || !data.subarray(0, 8).equals(ACCOUNT.mandate)) throw new Error("NOT_A_MANDATE_ACCOUNT");
  const version = readU64(data, 48);
  if (version === 0n) throw new Error("NOT_A_MANDATE_ACCOUNT");
  return {
    holder: readKey(data, 8),
    limit: readU64(data, 40),
    version,
    expiresAt: readU64(data, 56),
    ceiling: readU64(data, 64),
    revoked: data.length > 72 && data[72] !== 0,
    // The flag byte is required, exactly as in the program: a zeroed principal
    // must not read as bound to the system program.
    binding: data.length === MANDATE_LEN && data[73] === 1
      ? { principal: readKey(data, 74), policyEngine: readKey(data, 106) }
      : null,
  };
}

export interface AuthorizationAccount {
  holder: PublicKey;
  action: Buffer;
  amount: bigint;
  mandateVersion: bigint;
  expiresAt: bigint;
  consumed: boolean;
  bump: number;
  recipient: PublicKey;
}

/** 130 bytes only. A pre-F51 98-byte permit names no payee and is refused. */
export function decodeAuthorization(data: Buffer): AuthorizationAccount {
  if (data.length !== AUTHORIZATION_LEN || !data.subarray(0, 8).equals(ACCOUNT.authorization)) {
    throw new Error("NOT_AN_AUTHORIZATION_ACCOUNT");
  }
  return {
    holder: readKey(data, 8),
    action: Buffer.from(data.subarray(40, 72)),
    amount: readU64(data, 72),
    mandateVersion: readU64(data, 80),
    expiresAt: readU64(data, 88),
    // Any non-zero byte reads as consumed — the program's safe direction.
    consumed: data[96] !== 0,
    bump: data[97],
    recipient: readKey(data, 98),
  };
}
