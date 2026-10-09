/**
 * The agreement lifecycle ↔ on-chain escrow bridge (LP-6).
 *
 * ## The problem this solves
 *
 * `MitraJobEscrow.sol` (Base Sepolia, Tempo Moderato) and `programs/mitra-vault`
 * (Solana Devnet) hold real capital in real accounts. Nothing connected them to an
 * `Agreement`: `POST /api/v1/agreements` recorded `onChainEscrow` in the database and
 * returned 200, so an agreement could look funded while no escrow existed. That is the
 * "documented ≠ true" failure this repository exists to prevent, and it is why the
 * §15.5 commitment F76 built was, on its own, a hash over an escrow that never got funded.
 *
 * ## The hard part is not calling the contract. It is the dual write.
 *
 * A chain transaction is irreversible and a database write is not, so they cannot be
 * atomic. Two orderings, and both are wrong on their own:
 *
 * - **DB then chain** — the database says funded, the broadcast fails. The agreement
 *   claims capital it does not have, and nothing will ever retry.
 * - **chain then DB** — the broadcast succeeds, the write fails. Capital is escrowed on
 *   chain with no agreement recording it.
 *
 * So this module never assumes the previous attempt finished. **Every entry point probes
 * the chain first** and reconciles against what it finds, and the two halves that make
 * that safe are:
 *
 * 1. **A deterministic escrow identity.** `jobIdFor(agreementId)` means a retry addresses
 *    the identical `bytes32` / PDA. Two spellings of the same agreement cannot become two
 *    escrows, so "already funded" is a decidable question rather than a guess.
 * 2. **A read-before-write probe.** If the escrow already exists with matching terms, the
 *    broadcast is skipped and the caller is told to heal the database instead.
 *
 * A dual write without both of those is a dual write with a coin flip in it.
 *
 * ## No synthetic transaction hashes
 *
 * `AGENTS.md` forbids production code from returning a synthetic transaction hash, and
 * this module returns a discriminated outcome rather than a `txHash` field that is
 * sometimes a string like `"ALREADY_FUNDED"`. A caller that logs a transaction hash must
 * be able to paste it into an explorer; a caller that branches on "did we broadcast or
 * not" must be able to ask that question without string comparison. `alreadyEscrowed`
 * and `skipped` are separate boolean fields precisely so neither job has to be done by
 * inspecting a hash.
 */

import type { Hex } from "viem";
import type { JobRow } from "@/lib/adapters/erc8183-transport";
import type { Agreement } from "@/lib/domain/types";
import { routeCommitment } from "@/lib/domain/canonical";
import { jobIdFor } from "@/lib/solana/vault-program";
import type { OnChainEscrowRef } from "@/lib/kernel/commerce-recovery";

// ── escrow identity ────────────────────────────────────────────────────────────

/**
 * The on-chain escrow identity of an agreement: 32 bytes, identical on both rails.
 *
 * `jobIdFor` is sha256 of the agreement id, which is exactly what `bytes32 jobId` is on
 * the EVM rail and exactly what the PDA seed is on Solana. Sharing the derivation is the
 * point: if the two rails spelled the same job differently, one agreement could occupy
 * two escrows and be paid out of either.
 */
export const escrowIdFor = (agreementId: string): string =>
  `0x${jobIdFor(agreementId).toString("hex")}`;

// ── rails ──────────────────────────────────────────────────────────────────────

/**
 * The subset of `ERC8183Transport` this module uses.
 *
 * Narrow on purpose. The bridge takes a rail as an argument so the hermetic suite can
 * pass a fake without an RPC url, a key file or `deployments.json` — and so the production
 * wiring is one assignment rather than three branches through concrete classes.
 */
export interface EvmEscrowRail {
  readonly address: `0x${string}`;
  depositToEscrow(job: {
    jobId: Hex;
    clientVault: `0x${string}`;
    provider: `0x${string}`;
    evaluator: `0x${string}`;
    token: `0x${string}`;
    amount: bigint;
    timeout: bigint;
    refundRouteHash: Hex;
  }): Promise<Hex>;
  completeJob(jobId: Hex): Promise<Hex>;
  refundJob(jobId: Hex): Promise<Hex>;
  /**
   * Resolves to a **zeroed record** for a job that was never funded — never to `undefined`,
   * which is what `normalizeJobRow` guarantees for the real transport. The probe reads
   * `amount` directly, so `undefined` would be read as "not absent" and would fall through
   * to comparing terms made of `undefined`s (F82).
   */
  getJob(jobId: Hex): Promise<JobRow | undefined>;
}

export interface SolanaEscrowRail {
  /**
   * The escrow's client/authority, as base58.
   *
   * On Solana the `client` is not a caller-supplied address: `vaultPda(client)` derives the
   * vault from it and the program checks it as the authority. So the escrow's `client`
   * term is fixed by the key that will sign, and the route must read it from the rail
   * rather than invent it.
   */
  readonly authority: string;
  /** The escrow PDA's account bytes, or `null` when the account does not exist. */
  readEscrow(jobId: Uint8Array): Promise<Buffer | null>;
  lockEscrow(jobId: Uint8Array, terms: SolanaLockTerms): Promise<string>;
  releaseEscrow(jobId: Uint8Array): Promise<string>;
  refundEscrow(jobId: Uint8Array): Promise<string>;
}

export interface SolanaLockTerms {
  amount: bigint;
  timeout: bigint;
  refundRouteHash: Uint8Array;
  provider: string;
}

export type EscrowChain = "evm" | "solana";

export interface EscrowRail {
  chain: EscrowChain;
  /** `baseSepolia` | `moderato` | `devnet` — which deployment is being addressed. */
  network: string;
  evm?: EvmEscrowRail;
  solana?: SolanaEscrowRail;
}

// ── probe ──────────────────────────────────────────────────────────────────────

/** What the chain says about an escrow, as far as the bridge can tell. */
export type EscrowProbe =
  /** No escrow account/contract entry exists. Safe to broadcast a lock. */
  | { state: "ABSENT" }
  /** Capital is escrowed. `terms` says whether they are the ones we intended. */
  | { state: "FUNDED"; terms: EscrowTerms; onChainRefundRouteHash: string }
  /** The escrow has paid out — completed or refunded. Terminal, and not re-lockable. */
  | { state: "SETTLED"; outcome: "completed" | "refunded"; terms: EscrowTerms }
  /**
   * An escrow exists under this identity with DIFFERENT terms.
   *
   * Never resolved by overwriting or by ignoring it. Refusing is the only safe answer:
   * the alternative is funding a second escrow for an agreement that already has one.
   */
  | { state: "MISMATCH"; reason: string; actual: EscrowTerms };

export interface EscrowTerms {
  amount: bigint;
  provider: string;
  client: string;
  timeout: bigint;
}

/**
 * `JobStatus { None, Funded, Completed, Refunded }` — MitraJobEscrow.sol:39.
 *
 * Transcribed rather than guessed, and pinned by a test against the contract source: an
 * off-by-one here would classify a completed escrow as funded, and the "already settled"
 * skip would never fire on a job that had already paid out.
 */
const EVM_JOB_STATUS = { NONE: 0, FUNDED: 1, COMPLETED: 2, REFUNDED: 3 } as const;

/**
 * Ask the chain what, if anything, is escrowed under this agreement's identity.
 *
 * The read is the whole safety mechanism, so it is deliberately a *read*: `getJob` and
 * `getAccountInfo` are view calls that cannot move capital and cost nothing if called
 * twice.
 */
export async function probeEscrowStatus(
  agreement: Agreement,
  rail: EscrowRail,
  intended: EscrowTerms,
): Promise<EscrowProbe> {
  const id = escrowIdFor(agreement.agreementId);

  if (rail.evm) {
    const job = await rail.evm.getJob(id as Hex);
    // An unknown jobId reverts or returns zeroes depending on the contract revision, so
    // "no row" is inferred from the amount rather than trusted from the return value.
    if (!job || job.amount === 0n) return { state: "ABSENT" };
    const terms: EscrowTerms = {
      amount: job.amount,
      provider: job.provider,
      client: job.clientVault,
      timeout: job.timeout,
    };
    if (job.status === EVM_JOB_STATUS.COMPLETED) {
      return { state: "SETTLED", outcome: "completed", terms };
    }
    if (job.status === EVM_JOB_STATUS.REFUNDED) {
      return { state: "SETTLED", outcome: "refunded", terms };
    }
    if (job.status === EVM_JOB_STATUS.NONE) {
      // Status says None but an amount arrived. Treated as a mismatch rather than
      // "absent": re-funding on the strength of a contradictory row is the one outcome
      // that could produce two escrows for one agreement.
      return { state: "MISMATCH", reason: "ESCROW_ROW_CONTRADICTS_STATUS", actual: terms };
    }
    return mismatchOrFunded(terms, intended, job.refundRouteHash as string);
  }

  if (rail.solana) {
    const data = await rail.solana.readEscrow(jobIdFor(agreement.agreementId));
    if (!data) return { state: "ABSENT" };
    // Decoded lazily so an absent account never needs a decoder, and so a corrupt
    // account surfaces as a refusal rather than as "absent" — which would re-fund it.
    const { decodeJobEscrow } = await import("@/lib/solana/vault-program");
    let escrow;
    try {
      escrow = decodeJobEscrow(data);
    } catch (e) {
      return { state: "MISMATCH", reason: `ESCROW_ACCOUNT_UNREADABLE: ${(e as Error).message}`, actual: { amount: 0n, provider: "", client: "", timeout: 0n } };
    }
    const terms: EscrowTerms = {
      amount: escrow.amount,
      provider: escrow.provider.toBase58(),
      client: escrow.client.toBase58(),
      timeout: escrow.timeout,
    };
    if (escrow.completed) return { state: "SETTLED", outcome: "completed", terms };
    if (escrow.refunded) return { state: "SETTLED", outcome: "refunded", terms };
    return mismatchOrFunded(terms, intended, `0x${escrow.refundRouteHash.toString("hex")}`);
  }

  return { state: "ABSENT" };
}

function mismatchOrFunded(
  actual: EscrowTerms,
  intended: EscrowTerms,
  onChainRefundRouteHash: string,
): EscrowProbe {
  if (actual.amount !== intended.amount) {
    return { state: "MISMATCH", reason: "ESCROW_AMOUNT_DIFFERS", actual };
  }
  if (actual.provider.toLowerCase() !== intended.provider.toLowerCase()) {
    return { state: "MISMATCH", reason: "ESCROW_PROVIDER_DIFFERS", actual };
  }
  if (actual.timeout !== intended.timeout) {
    return { state: "MISMATCH", reason: "ESCROW_TIMEOUT_DIFFERS", actual };
  }
  return { state: "FUNDED", terms: actual, onChainRefundRouteHash };
}

// ── outcomes ───────────────────────────────────────────────────────────────────

/**
 * The result of asking the chain to do something.
 *
 * `txHash` is a real transaction hash or **absent** — never a placeholder. `skipped`
 * says the broadcast did not happen because the chain was already in the target state,
 * which is the signal to heal the database rather than to retry the chain.
 */
export type EscrowOutcome =
  | { ok: true; action: "locked" | "released" | "refunded"; txHash: string; skipped: false }
  | { ok: true; action: "locked" | "released" | "refunded"; txHash?: undefined; skipped: true; reason: SkipReason }
  | { ok: false; action: string; reason: string; detail?: string };

export type SkipReason =
  | "ALREADY_FUNDED"
  | "ALREADY_SETTLED"
  | "TERMINAL_ESCROW_CANNOT_BE_RELOCKED";

export interface EscrowLockRequest {
  agreement: Agreement;
  /** The terms the parties agreed. `amount` in the asset's smallest unit. */
  intended: EscrowTerms;
  /** §15.5. Must equal the value the kernel committed; checked below. */
  refundRouteHash: string;
  rail: EscrowRail;
  /** EVM only: the vault the tokens come from, and the token. */
  evm?: { clientVault: Hex; token: Hex; evaluator: Hex };
}

// ── lock ───────────────────────────────────────────────────────────────────────

/**
 * Escrow capital for an agreement, or report that it is already escrowed.
 *
 * **Order is load-bearing: probe, then broadcast.** The probe is not an optimisation.
 */
export async function executeEscrowLock(req: EscrowLockRequest): Promise<EscrowOutcome> {
  const probe = await probeEscrowStatus(req.agreement, req.rail, req.intended);

  switch (probe.state) {
    case "MISMATCH":
      return {
        ok: false, action: "locked", reason: probe.reason,
        detail: `an escrow already exists for this agreement with different terms (amount ${probe.actual.amount}, provider ${probe.actual.provider})`,
      };
    case "FUNDED":
      // The commitment is the one thing that must NOT be taken on trust: if the chain
      // holds a different route hash, the §15.5 guarantee is not in force for this
      // escrow, and F76's redirect check would refuse every refund. Detected here
      // rather than at refund time, because at refund time it is too late to fix.
      if (!sameHash(probe.onChainRefundRouteHash, req.refundRouteHash)) {
        return {
          ok: false, action: "locked", reason: "ESCROW_REFUND_ROUTE_MISMATCH",
          detail: `on-chain ${probe.onChainRefundRouteHash} vs committed ${req.refundRouteHash}`,
        };
      }
      // Already in the target state. The caller heals the database; nothing is broadcast.
      return { ok: true, action: "locked", skipped: true, reason: "ALREADY_FUNDED" };
    case "SETTLED":
      return { ok: true, action: "locked", skipped: true, reason: "TERMINAL_ESCROW_CANNOT_BE_RELOCKED" };
    case "ABSENT":
      break;
  }

  try {
    if (req.rail.evm) {
      if (!req.evm) return { ok: false, action: "locked", reason: "EVM_TERMS_MISSING" };
      const txHash = await req.rail.evm.depositToEscrow({
        jobId: escrowIdFor(req.agreement.agreementId) as Hex,
        clientVault: req.evm.clientVault,
        provider: req.intended.provider as Hex,
        evaluator: req.evm.evaluator,
        token: req.evm.token,
        amount: req.intended.amount,
        timeout: req.intended.timeout,
        refundRouteHash: req.refundRouteHash as Hex,
      });
      return { ok: true, action: "locked", txHash, skipped: false };
    }
    if (req.rail.solana) {
      const txHash = await req.rail.solana.lockEscrow(jobIdFor(req.agreement.agreementId), {
        amount: req.intended.amount,
        timeout: req.intended.timeout,
        refundRouteHash: Buffer.from(req.refundRouteHash.replace(/^0x/, ""), "hex"),
        provider: req.intended.provider,
      });
      return { ok: true, action: "locked", txHash, skipped: false };
    }
    return { ok: false, action: "locked", reason: "RAIL_HAS_NO_ESCROW_TRANSPORT" };
  } catch (e) {
    return { ok: false, action: "locked", reason: "BROADCAST_FAILED", detail: (e as Error).message };
  }
}

// ── release ────────────────────────────────────────────────────────────────────

/**
 * Pay the provider: `completeJob` on EVM, `release_escrow` on Solana.
 *
 * Idempotent for the same reason `executeEscrowLock` is: a retry after a lost receipt
 * must not double-pay. The probe distinguishes "already settled" from "funded", so a
 * replay is a skip rather than a revert.
 */
export async function executeEscrowRelease(
  agreement: Agreement,
  rail: EscrowRail,
  intended: EscrowTerms,
): Promise<EscrowOutcome> {
  const probe = await probeEscrowStatus(agreement, rail, intended);
  if (probe.state === "MISMATCH") {
    return { ok: false, action: "released", reason: probe.reason };
  }
  if (probe.state === "SETTLED") {
    // Already paid out — including "refunded", which is not the outcome we asked for but
    // is final and must not be re-paid. Reported as a skip with the reason, so a caller
    // can tell a benign replay from a wrong-direction release.
    return {
      ok: true, action: "released", skipped: true,
      reason: probe.outcome === "completed" ? "ALREADY_SETTLED" : "TERMINAL_ESCROW_CANNOT_BE_RELOCKED",
    };
  }
  if (probe.state === "ABSENT") {
    return { ok: false, action: "released", reason: "NO_ESCROW_TO_RELEASE" };
  }

  try {
    const id = escrowIdFor(agreement.agreementId);
    const txHash = rail.evm
      ? await rail.evm.completeJob(id as Hex)
      : await rail.solana!.releaseEscrow(jobIdFor(agreement.agreementId));
    return { ok: true, action: "released", txHash, skipped: false };
  } catch (e) {
    return { ok: false, action: "released", reason: "BROADCAST_FAILED", detail: (e as Error).message };
  }
}

// ── refund ─────────────────────────────────────────────────────────────────────

/**
 * Return the capital: `refundJob` on EVM, `refund_escrow` on Solana.
 *
 * The §15.5 route was committed at funding, so this carries the route's **identity**
 * (the job) and nothing else. No calldata is synthesised here — the contract and the
 * program each consult the hash they were given at lock time and refuse without it. That
 * is why this function takes no route argument: if it did, it would be inventing
 * compensation after the fact, which is the thing the section forbids.
 */
export async function executeEscrowRefund(
  agreement: Agreement,
  rail: EscrowRail,
  intended: EscrowTerms,
): Promise<EscrowOutcome> {
  const probe = await probeEscrowStatus(agreement, rail, intended);
  if (probe.state === "MISMATCH") {
    return { ok: false, action: "refunded", reason: probe.reason };
  }
  if (probe.state === "SETTLED") {
    return {
      ok: true, action: "refunded", skipped: true,
      reason: probe.outcome === "refunded" ? "ALREADY_SETTLED" : "TERMINAL_ESCROW_CANNOT_BE_RELOCKED",
    };
  }
  if (probe.state === "ABSENT") {
    return { ok: false, action: "refunded", reason: "NO_ESCROW_TO_REFUND" };
  }

  try {
    const id = escrowIdFor(agreement.agreementId);
    const txHash = rail.evm
      ? await rail.evm.refundJob(id as Hex)
      : await rail.solana!.refundEscrow(jobIdFor(agreement.agreementId));
    return { ok: true, action: "refunded", txHash, skipped: false };
  } catch (e) {
    return { ok: false, action: "refunded", reason: "BROADCAST_FAILED", detail: (e as Error).message };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Case-insensitive hash comparison. Chains echo hex in mixed case. */
function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The §15.5 commitment an escrow for `agreement` must carry.
 *
 * Exposed so the route can hand the chain the same value the kernel committed rather than
 * recomputing it — two computations of "the" commitment is one too many.
 */
export function refundRouteHashFor(agreement: Agreement): string | undefined {
  if (agreement.refundRouteHash) return agreement.refundRouteHash;
  if (!agreement.escrowRef) return undefined;
  // Only reachable for an agreement funded before F76 committed a hash; the route is
  // rebuilt from the ref, which F80 showed is lossy — so this is a refusal case upstream,
  // not a reconstruction to rely on.
  return routeCommitment(`evm:refundEscrow:${agreement.escrowRef}`);
}

/** Re-exported so callers need not import the kernel type alongside this module. */
export type { OnChainEscrowRef };
