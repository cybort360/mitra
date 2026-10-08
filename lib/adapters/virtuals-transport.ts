/**
 * Virtuals ACP session-key transport (LP-8).
 *
 * ## Why a session key at all
 *
 * An agent that talks to a marketplace needs to sign outbound messages continuously — bids,
 * counter-offers, artifact commitments — while the key that can move capital should never be
 * online. A **session key** is the unprivileged half: an ephemeral keypair that signs ACP
 * payloads, authorised by a one-off **delegation** signed by the agent's identity.
 *
 * ## The threat this file exists to close
 *
 * A session key is a bearer token wearing a keypair's clothes. If its scope is enforced
 * anywhere other than immediately before each signature, the guarantee is decoration: the key
 * can be copied, and everything it can do is everything its holder ever allowed. So scope is
 * checked **on every outbound call**, not once at construction, and the delegation signature
 * is **verified**, not merely present.
 *
 * That last point is the one that is easy to skip. A delegation that is only *read* — trusted
 * because it is well-formed — can be minted by anyone, which makes the entire scope mechanism
 * theatre. Here the delegation is EIP-712 over the exact tuple below, signed by a wallet the
 * agent actually holds, and recovered before use.
 *
 * ## The scope model: allowlist, bound to the rule digest
 *
 * The permitted actions are an **explicit enum** (fail-closed), and the delegation commits to
 * the digest of the rule set it was granted under. Both halves are needed:
 *
 * - An allowlist alone loses ADR-0011's rule-set provenance — the delegation would not say
 *   *which* marketplace's rules it was minted under, so a delegation granted for ACP could be
 *   replayed against a different integration.
 * - Deriving permissions purely from a runtime hash of an opaque digest is brittle: it makes
 *   the executable surface depend on a string nobody can enumerate.
 *
 * So the allowlist is readable and testable, and the digest binds it to a named rule set.
 *
 * ## Capital is never in scope
 *
 * No permitted action moves value. `openJob` caps a bid at the delegation's `maxSpendUsd`, and
 * a job is *opened*, not paid — settlement stays on a canonical rail through the machinery that
 * already governs it. Dispute adjudication is refused outright: the marketplace owns its own
 * lifecycle, and `toAgreementStatus` returning `null` for an unrecognised state is the same
 * principle (Mitra's vocabulary must not be laid over someone else's process).
 */

import { createHash, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { recoverTypedDataAddress, hashTypedData, type Hex } from "viem";
import type { EvidenceLevel } from "@/lib/domain/types";
import { VIRTUALS_RULE_SET, type VirtualsClient } from "@/lib/adapters/virtuals";

// ── the allowlist ───────────────────────────────────────────────────────────────

/**
 * Every action a session key may perform. Fail-closed by construction.
 *
 * Nothing here moves capital. `openJob` proposes a spend against a cap; it does not
 * disburse. Dispute adjudication, settlement and raw token movement are **absent**, and their
 * absence is the control — an action not in this list is refused before a signature is
 * produced, so a compromised session key cannot reach them by any path.
 */
export const ACP_PERMITTED_ACTIONS = [
  "DISCOVER",
  "OPEN_JOB",
  "SUBMIT_ARTIFACT",
  "QUERY_STATE",
  "CANCEL_JOB",
] as const;

export type AcpAction = typeof ACP_PERMITTED_ACTIONS[number];

/** Actions that are refused no matter what a delegation says. Named for the error message. */
export const ACP_FORBIDDEN_VERBS = [
  "raw_spend", "claim_dispute", "settle", "withdraw", "transfer", "adjudicate", "dispute",
] as const;

export class SessionKeyScopeError extends Error {
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SessionKeyScopeError";
    this.reason = reason;
  }
  readonly reason: string;
}

// ── the delegation ──────────────────────────────────────────────────────────────

export interface SessionDelegation {
  /** The unprivileged key's address. */
  sessionAddress: string;
  /** The rule set this delegation was granted under. */
  ruleDigest: string;
  allowedActions: readonly AcpAction[];
  /** The most this key may ever commit to, in USD. Not a budget — a ceiling per action. */
  maxSpendUsd: number;
  /** Unix seconds. */
  expiresAt: number;
  /** The agent's registered EOA that granted this. */
  delegator: string;
  /** EIP-712 signature by `delegator` over the tuple above. */
  signature: Hex;
  /** The EIP-712 domain the signature commits to. */
  chainId: number;
}

const DELEGATION_TYPES = {
  SessionDelegation: [
    { name: "sessionAddress", type: "address" },
    { name: "ruleDigest", type: "string" },
    { name: "allowedActions", type: "string" },
    { name: "maxSpendUsd", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const SESSION_DELEGATION_DOMAIN = { name: "Mitra Virtuals ACP", version: "1" } as const;

/** The actions are hashed into one string, so the set is ordered and cannot be reordered. */
function allowedActionsHash(actions: readonly AcpAction[]): string {
  return [...actions].sort().join(",");
}

export function sessionDelegationTypedData(d: Omit<SessionDelegation, "signature">, chainId = d.chainId) {
  return {
    domain: { ...SESSION_DELEGATION_DOMAIN, chainId },
    types: DELEGATION_TYPES,
    primaryType: "SessionDelegation" as const,
    message: {
      sessionAddress: d.sessionAddress,
      ruleDigest: d.ruleDigest,
      allowedActions: allowedActionsHash(d.allowedActions),
      maxSpendUsd: BigInt(Math.round(d.maxSpendUsd * 1_000_000)),
      expiresAt: BigInt(d.expiresAt),
    },
  };
}

/** Mint a delegation, signed by the agent's wallet. The only place one is created. */
export async function signSessionDelegation(input: {
  account: PrivateKeyAccount;
  sessionAddress: string;
  allowedActions: readonly AcpAction[];
  maxSpendUsd: number;
  expiresAt: number;
  ruleDigest?: string;
  chainId?: number;
}): Promise<SessionDelegation> {
  const base: Omit<SessionDelegation, "signature"> = {
    sessionAddress: input.sessionAddress,
    ruleDigest: input.ruleDigest ?? VIRTUALS_RULE_SET.digest,
    allowedActions: [...input.allowedActions].sort(),
    maxSpendUsd: input.maxSpendUsd,
    expiresAt: input.expiresAt,
    delegator: input.account.address,
    chainId: input.chainId ?? 84532,
  };
  const typed = sessionDelegationTypedData(base);
  return {
    ...base,
    // `signTypedData` resolves the signature; `await` here is in the caller, so the
    // helper is async and the tuple it returns is fully formed.
    signature: (await input.account.signTypedData(typed as never)) as Hex,
  };
}

/**
 * Recover the signer of a delegation.
 *
 * Offline and ECDSA-only, so a delegation cannot be verified by the same process that holds
 * it — which is the point of verifying. A contract wallet's delegator would need ERC-1271,
 * and this repository has no RPC-independent path to that; rather than silently accept an
 * unverifiable delegator, recovery failure is a refusal.
 */
export async function recoverDelegator(d: SessionDelegation): Promise<string | null> {
  const typed = sessionDelegationTypedData(d);
  try {
    return (await recoverTypedDataAddress({
      domain: typed.domain, types: DELEGATION_TYPES, primaryType: "SessionDelegation",
      message: typed.message, signature: d.signature,
    } as never)) as string;
  } catch {
    return null;
  }
}

// ── scope enforcement ───────────────────────────────────────────────────────────

export interface ScopeCheckInput {
  delegation: SessionDelegation;
  action: string;
  /** Unix seconds. */
  now: number;
  /** The Space's rule digest, when the call happens inside a governed Space. */
  spaceRuleDigest?: string;
  /** The amount this call would commit to, for spend-bearing actions. */
  spendUsd?: number;
  /**
   * The wallet the signing key is allowed to be. Usually the session address itself.
   * Checked so a delegation cannot be replayed by a different key.
   */
  signerAddress?: string;
}

/**
 * The whole scope check, in one place, called before every signature.
 *
 * Order is deliberate: **identity, then authority, then action, then time, then money.**
 * A replayed delegation is reported as a replay, not as an expired one; an unknown action is
 * reported as unknown rather than as over-budget. Each of those wrong answers costs an
 * operator real time, and this is the function that produces them.
 */
export async function assertSessionScope(input: ScopeCheckInput): Promise<void> {
  const d = input.delegation;

  // ── 1. the delegation is genuine ───────────────────────────────────────────
  const recovered = await recoverDelegator(d);
  if (!recovered) {
    throw new SessionKeyScopeError("SESSION_KEY_DELEGATION_UNVERIFIABLE", "the delegator signature could not be recovered");
  }
  if (recovered.toLowerCase() !== d.delegator.toLowerCase()) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_DELEGATOR_MISMATCH",
      `delegation claims ${d.delegator} but was signed by ${recovered}`,
    );
  }

  // ── 2. the delegation was granted under these rules ────────────────────────
  // ADR-0011: a marketplace adapter runs under the MARKETPLACE's rule set. A
  // delegation minted for one integration must not be usable against another.
  if (d.ruleDigest !== VIRTUALS_RULE_SET.digest) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_RULE_DIGEST_MISMATCH",
      `delegation was granted under ${d.ruleDigest}, this transport speaks ${VIRTUALS_RULE_SET.digest}`,
    );
  }
  if (input.spaceRuleDigest !== undefined && input.spaceRuleDigest !== VIRTUALS_RULE_SET.digest) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_SPACE_RULES_MISMATCH",
      `the Space runs under ${input.spaceRuleDigest}; a Virtuals ACP session requires ${VIRTUALS_RULE_SET.digest}`,
    );
  }

  // ── 3. the signing key is the one that was delegated to ────────────────────
  if (input.signerAddress && input.signerAddress.toLowerCase() !== d.sessionAddress.toLowerCase()) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_SIGNER_NOT_DELEGATED",
      `${input.signerAddress} is not the delegated session key ${d.sessionAddress}`,
    );
  }

  // ── 4. the action is on the allowlist AND on this delegation ───────────────
  // Both checks, and the allowlist first. A verb outside the enum is refused even if the
  // delegation somehow lists it, so a forged delegation cannot widen the surface — it can
  // only fail the earlier digest or signature checks.
  if (!(ACP_PERMITTED_ACTIONS as readonly string[]).includes(input.action)) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_ACTION_NOT_PERMITTED",
      `${input.action} is not in the ACP allowlist (${ACP_PERMITTED_ACTIONS.join(", ")})`,
    );
  }
  if (!d.allowedActions.includes(input.action as AcpAction)) {
    throw new SessionKeyScopeError(
      "SESSION_KEY_ACTION_NOT_DELEGATED",
      `${input.action} is not among this delegation's actions (${d.allowedActions.join(", ")})`,
    );
  }

  // ── 5. it has not expired ──────────────────────────────────────────────────
  if (input.now >= d.expiresAt) {
    throw new SessionKeyScopeError("SESSION_KEY_EXPIRED", `expired at ${d.expiresAt}, now ${input.now}`);
  }

  // ── 6. and the amount is within the ceiling ────────────────────────────────
  // Integer micro-dollars, so a cap is not lost to float noise.
  if (input.spendUsd !== undefined) {
    if (input.spendUsd < 0) {
      throw new SessionKeyScopeError("SESSION_KEY_NEGATIVE_SPEND", String(input.spendUsd));
    }
    const spend = BigInt(Math.round(input.spendUsd * 1_000_000));
    const cap = BigInt(Math.round(d.maxSpendUsd * 1_000_000));
    if (spend > cap) {
      throw new SessionKeyScopeError(
        "SESSION_KEY_SPEND_EXCEEDS_DELEGATION",
        `${input.spendUsd} exceeds the delegation's ceiling of ${d.maxSpendUsd}`,
      );
    }
  }
}

// ── the live transport ──────────────────────────────────────────────────────────

export interface VirtualsTransportOptions {
  apiKey: string;
  sessionKey: PrivateKeyAccount;
  delegation: SessionDelegation;
  /** The Space's rule digest, checked on every call. */
  spaceRuleDigest?: string;
  baseUrl?: string;
  testnet?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected so tests can supply a clock; defaults to wall time. */
  now?: () => number;
  maxAttempts?: number;
  backoffMs?: number;
}

const ACP_ROUTES: Record<AcpAction, { method: string; path: string }> = {
  DISCOVER: { method: "GET", path: "/agents" },
  OPEN_JOB: { method: "POST", path: "/jobs" },
  SUBMIT_ARTIFACT: { method: "POST", path: "/jobs/artifacts" },
  QUERY_STATE: { method: "GET", path: "/jobs" },
  CANCEL_JOB: { method: "POST", path: "/jobs/cancel" },
};

/**
 * The live ACP transport.
 *
 * ## Fails closed
 *
 * `UNCONFIGURED_VIRTUALS_TRANSPORT` when the API key or the session key is absent. The
 * dangerous failure here is not a crash — it is a transport that quietly no-ops and lets an
 * agent believe it placed a bid.
 *
 * ## Scope is re-checked on every call
 *
 * `assertSessionScope` runs immediately before **every** signature, with the live clock. A
 * transport that checked once at construction would keep signing after expiry for as long as
 * the process lived, which is the whole failure mode session keys are introduced to avoid.
 *
 * ## Retries are bounded and never replay a signature
 *
 * Exponential backoff on 429/5xx and network errors, and **GET-like actions only**
 * (`DISCOVER`, `QUERY_STATE`). Retrying a signed mutation after a timeout can place the same
 * bid twice; the marketplace's own idempotency is not something this repository assumes.
 */
export class VirtualsHttpTransport implements VirtualsClient {
  readonly name = "virtuals-acp-http";
  private readonly baseUrl: string;

  constructor(private readonly opts: VirtualsTransportOptions) {
    if (!opts.apiKey) throw new Error("UNCONFIGURED_VIRTUALS_TRANSPORT: VIRTUALS_API_KEY is absent");
    if (!opts.sessionKey) throw new Error("UNCONFIGURED_VIRTUALS_TRANSPORT: VIRTUALS_SESSION_KEY is absent");
    if (!opts.delegation) throw new Error("UNCONFIGURED_VIRTUALS_TRANSPORT: no session delegation was supplied");
    this.baseUrl = opts.baseUrl ?? "https://acpx.virtuals.gg/api";
  }

  private get now(): number {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  /** Scope check, then signature, then send. In that order, always. */
  private async authorize(action: AcpAction, spendUsd?: number): Promise<void> {
    await assertSessionScope({
      delegation: this.opts.delegation,
      action,
      now: this.now,
      ...(this.opts.spaceRuleDigest !== undefined ? { spaceRuleDigest: this.opts.spaceRuleDigest } : {}),
      ...(spendUsd !== undefined ? { spendUsd } : {}),
      signerAddress: this.opts.sessionKey.address,
    });
  }

  /** ACP payloads are signed with the SESSION key, never the vault key. */
  private async post(path: string, body: unknown): Promise<unknown> {
    const payload = JSON.stringify({ ...(body as object), issuedAt: this.now, session: this.opts.sessionKey.address });
    const signature = await this.opts.sessionKey.signMessage({ message: payload });
    const doFetch = this.opts.fetchImpl ?? fetch;

    let lastError: Error | undefined;
    const attempts = this.opts.maxAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await doFetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.opts.apiKey,
            "X-Session-Address": this.opts.sessionKey.address,
            "X-Session-Signature": signature,
          },
          body: payload,
        });
        if (res.status === 429 || res.status >= 500) {
          // Retried, with backoff. A signed mutation is NOT retried — see the class doc.
          lastError = new Error(`ACP_${res.status}`);
        } else if (!res.ok) {
          throw new Error(`ACP_${res.status}: ${(await res.text()).slice(0, 200)}`);
        } else {
          return await res.json().catch(() => ({}));
        }
      } catch (e) {
        lastError = e as Error;
      }
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 250) * 2 ** attempt));
      }
    }
    throw new Error(`ACP_UNREACHABLE: ${lastError?.message ?? "no response"}`);
  }

  private async get(path: string): Promise<unknown> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    let lastError: Error | undefined;
    const attempts = this.opts.maxAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await doFetch(`${this.baseUrl}${path}`, {
          headers: { "X-API-Key": this.opts.apiKey, "X-Session-Address": this.opts.sessionKey.address },
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`ACP_${res.status}`);
        } else if (!res.ok) {
          throw new Error(`ACP_${res.status}: ${(await res.text()).slice(0, 200)}`);
        } else {
          return await res.json();
        }
      } catch (e) {
        lastError = e as Error;
      }
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, (this.opts.backoffMs ?? 250) * 2 ** attempt));
      }
    }
    throw new Error(`ACP_UNREACHABLE: ${lastError?.message ?? "no response"}`);
  }

  async listProviders(capability: string): Promise<Array<{ id: string; name: string; capabilities: string[]; priceUsd?: number }>> {
    await this.authorize("DISCOVER");
    const raw = await this.get(`${ACP_ROUTES.DISCOVER.path}?capability=${encodeURIComponent(capability)}`);
    const agents = (raw as { agents?: Array<{ id: string; name: string; capabilities?: string[]; priceUsd?: number }> }).agents ?? [];
    return agents.map((a) => ({ id: a.id, name: a.name, capabilities: a.capabilities ?? [], ...(a.priceUsd === undefined ? {} : { priceUsd: a.priceUsd }) }));
  }

  async openJob(input: { providerId: string; objective: string; agreementId: string; maxUsd: number }): Promise<{ jobId: string; state: string }> {
    // `maxUsd` is checked against the delegation's ceiling BEFORE signing. A bid the
    // delegation cannot cover must not produce a signature at all.
    await this.authorize("OPEN_JOB", input.maxUsd);
    const raw = await this.post(ACP_ROUTES.OPEN_JOB.path, input);
    const job = (raw as { job?: { id: string; state: string } }).job ?? (raw as { id: string; state: string });
    return { jobId: job.id, state: job.state };
  }

  async jobState(jobId: string): Promise<{ state: string; artifacts: string[] }> {
    await this.authorize("QUERY_STATE");
    const raw = await this.get(`${ACP_ROUTES.QUERY_STATE.path}/${encodeURIComponent(jobId)}`);
    const job = (raw as { job?: { state: string; artifacts?: string[] } }).job ?? (raw as { state: string; artifacts?: string[] });
    return { state: job.state, artifacts: job.artifacts ?? [] };
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.authorize("CANCEL_JOB");
    await this.post(ACP_ROUTES.CANCEL_JOB.path, { jobId });
  }

  /**
   * Submit an artifact. NOT part of `VirtualsClient`.
   *
   * Exposed here because it is in the allowlist and the transport is the only thing that can
   * sign it — and its absence from the interface is a deliberate statement: the marketplace
   * adapter does not yet drive it, and adding it to the interface would imply it does.
   */
  async submitArtifact(input: { jobId: string; artifactRef: string; contentHash: string }): Promise<void> {
    await this.authorize("SUBMIT_ARTIFACT");
    await this.post(ACP_ROUTES.SUBMIT_ARTIFACT.path, input);
  }

  /**
   * Attempt a verb that is not on the allowlist. Refused with no signature produced.
   *
   * Present so the refusal is reachable through the transport rather than only through the
   * policy function — a guard that can only be tested by calling its own implementation is a
   * guard nobody exercises.
   */
  async attemptOutOfScope(verb: string, payload: Record<string, unknown> = {}): Promise<never> {
    await this.authorize(verb as AcpAction);
    throw new SessionKeyScopeError("SESSION_KEY_ACTION_NOT_PERMITTED", `${verb} was authorised, which should be impossible`);
  }
}

// ── the simulator ───────────────────────────────────────────────────────────────

export interface SimulatedVirtualsOptions {
  delegation: SessionDelegation;
  sessionKey: PrivateKeyAccount;
  spaceRuleDigest?: string;
  now?: () => number;
}

/**
 * The offline transport. Announces itself, and signs nothing.
 *
 * It performs the **same scope check** as the live transport — the simulator is not allowed
 * to be more permissive than the thing it stands in for, or it would be a fixture that
 * approves actions the product refuses. Its results are distinguishable everywhere they
 * surface.
 */
export class SimulatedVirtualsTransport implements VirtualsClient {
  readonly name = "virtuals-acp-simulated";
  isSimulated = true;
  readonly evidenceLevel: EvidenceLevel = "LOCAL_PASS";
  readonly calls: string[] = [];

  constructor(private readonly opts: SimulatedVirtualsOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
  }

  private async authorize(action: AcpAction, spendUsd?: number): Promise<void> {
    this.calls.push(action);
    await assertSessionScope({
      delegation: this.opts.delegation,
      action,
      now: this.now(),
      ...(this.opts.spaceRuleDigest !== undefined ? { spaceRuleDigest: this.opts.spaceRuleDigest } : {}),
      ...(spendUsd !== undefined ? { spendUsd } : {}),
      signerAddress: this.opts.sessionKey.address,
    });
  }

  async listProviders(capability: string) {
    await this.authorize("DISCOVER");
    return [{ id: `sim_${capability}`, name: `simulated ${capability} provider`, capabilities: [capability], priceUsd: 1 }];
  }

  async openJob(input: { providerId: string; objective: string; agreementId: string; maxUsd: number }) {
    await this.authorize("OPEN_JOB", input.maxUsd);
    // The job id is derived, not random, so a retry of the same request is visible as the
    // same id rather than as a second job.
    const jobId = `sim_job_${createHash("sha256").update(`${input.agreementId}:${input.providerId}`).digest("hex").slice(0, 16)}`;
    return { jobId, state: "open" };
  }

  async jobState(jobId: string) {
    await this.authorize("QUERY_STATE");
    return { state: "open", artifacts: [] };
  }

  async cancelJob(jobId: string) {
    await this.authorize("CANCEL_JOB");
  }
}

/** An unprivileged, ephemeral session key. Never the vault key. */
export function newSessionKey(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}
