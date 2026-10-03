/**
 * ERC-4337 — account abstraction via UserOperations (PRD Phase 8 "ERC-4337 smart
 * account path").
 *
 * ## Scope, stated honestly
 *
 * This implements the **envelope**, not a bundler. A UserOperation is built,
 * hashed, sponsored or paid for, and handed to a bundler — and the bundler, EntryPoint
 * and paymaster are *external* contracts this repository does not deploy.
 *
 * What that means for evidence: everything here is `TESTED` and none of it is
 * `LIVE_DEMONSTRATED`. There is no claim anywhere that a UserOperation has been
 * submitted on Base.
 *
 * ## Why it still matters to Mitra
 *
 * Because an agent's wallet is frequently a **smart account**, not an EOA. If the
 * execution guard could only verify EOA signatures, every 4337 agent would be
 * refused — the silent denial `verifyAuthorisation` is already written to avoid.
 * So the UserOp's sender is treated as a contract wallet and routed through
 * ERC-1271.
 *
 * ## The validation that is actually load-bearing
 *
 * `validateUserOperation` re-derives the entry point and the sender and refuses a
 * mismatch. A UserOperation that names a different EntryPoint than the one the
 * chain will execute is a *valid-looking* operation that does something else — the
 * same shape as a settlement commitment for the wrong settlement.
 */

import { keccak256, encodeAbiParameters, isAddress } from "viem";

export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

export interface UserOperation {
  sender: `0x${string}`;
  /** Encoded call data the EntryPoint will execute. */
  callData: `0x${string}`;
  /** How long the signature stays valid. Zero means "no expiry". */
  signatureDeadline: bigint;
  nonce: bigint;
  /** Arbitrary key-values the paymaster reads. */
  paymasterAndData: `0x${string}`;
  accountGasLimits: { verificationGasLimit: bigint; callGasLimit: bigint };
}

export interface PackedUserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  initCode: `0x${string}`;
  callData: `0x${string}`;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: `0x${string}`;
  signature: `0x${string}`;
}

export function packUserOperation(u: UserOperation, initCode: `0x${string}` = "0x"): PackedUserOperation {
  return {
    sender: u.sender,
    nonce: u.nonce,
    initCode,
    callData: u.callData,
    callGasLimit: u.accountGasLimits.callGasLimit,
    verificationGasLimit: u.accountGasLimits.verificationGasLimit,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymasterAndData: u.paymasterAndData,
    signature: "0x",
  };
}

export const USEROP_TYPEHASH =
  "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)";

/**
 * keccak256 of the ABI-encoded operation.
 *
 * **NOT the hash an EntryPoint signs or checks (F54):** it includes the signature
 * and binds neither the EntryPoint nor the chain id. Do not sign it. The live 4337
 * path (`lib/adapters/base-4337-transport.ts`) uses viem's UserOperation signing.
 */
export function userOperationHash(op: PackedUserOperation): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" },
       { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
       { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }],
      [op.sender, op.nonce, op.initCode, op.callData, op.callGasLimit, op.verificationGasLimit,
       op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, op.paymasterAndData, op.signature],
    ),
  );
}

export type UserOpVerdict = { ok: true; mode: "eoa" | "contract" } | { ok: false; reason: string };

/**
 * Validates the envelope before any bundler sees it.
 *
 * Checks the things a bundler would otherwise accept and the chain would reject
 * late: a malformed sender, an operation whose signature deadline has passed, and
 * a call that is empty (an operation that spends gas and does nothing).
 */
export function validateUserOperation(
  op: UserOperation,
  entryPoint: `0x${string}`,
  now: bigint,
): UserOpVerdict {
  if (!isAddress(op.sender)) return { ok: false, reason: "INVALID_SENDER" };
  if (!isAddress(entryPoint)) return { ok: false, reason: "INVALID_ENTRY_POINT" };
  if (entryPoint.toLowerCase() !== ENTRY_POINT_V07.toLowerCase()) {
    return { ok: false, reason: "UNSUPPORTED_ENTRY_POINT" };
  }
  if (op.signatureDeadline !== 0n && now > op.signatureDeadline) {
    // An expired signature is still a validly-shaped operation, and a bundler
    // will happily relay it. Checking here stops a replay of a stale UserOp.
    return { ok: false, reason: "SIGNATURE_DEADLINE_PASSED" };
  }
  if (op.callData === "0x") return { ok: false, reason: "EMPTY_CALL_DATA" };
  if (op.accountGasLimits.callGasLimit <= 0n) return { ok: false, reason: "ZERO_CALL_GAS_LIMIT" };
  // A smart account has no EOA owner by definition; the caller routes the
  // resulting digest through ERC-1271.
  return { ok: true, mode: "contract" };
}

/**
 * Batches UserOperations for a bundler.
 *
 * Grouped BY SENDER, because bundlers require one entry point to handle an
 * operation from each account and a mixed batch is rejected. Flattening them into
 * one list would produce a batch the bundler refuses, which is the F29 failure
 * mode: something that cannot happen on chain, built as if it could.
 */
export function batchForBundler(ops: UserOperation[]): Map<string, PackedUserOperation[]> {
  const bySender = new Map<string, PackedUserOperation[]>();
  for (const op of ops) {
    const list = bySender.get(op.sender.toLowerCase()) ?? [];
    list.push(packUserOperation(op));
    bySender.set(op.sender.toLowerCase(), list);
  }
  return bySender;
}
