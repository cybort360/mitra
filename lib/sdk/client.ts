/**
 * The Mitra developer SDK (PRD §20, PP-5): a typed client over the HTTP API.
 *
 * It removes the caller-side boilerplate F55 requires: to send a lifecycle
 * transition a client must read the agreement's current status, hash the exact
 * body it will send, sign an EIP-712 `MitraRequest` over both, and attach the
 * `auth` envelope. The client does all four. It holds the signer and nothing
 * else: no store, no Mitra key, and no verb the API does not already serve.
 *
 * What it deliberately does NOT do:
 *  - decide anything. Every refusal comes from the API and is thrown as a
 *    `MitraApiError` carrying the API's own reason code;
 *  - move value. The verbs are commercial intents (`fund`, `submitDeliverable`,
 *    `refundEscrow`); whether capital moves is the kernel's and the execution
 *    guard's decision, and an ALLOW from `requestAuthorization` is not permission;
 *  - describe a compensation. `refundEscrow` sends the agreement's `refund` op and
 *    the kernel runs the route committed at `fund` (PRD §15.5);
 *  - mutate clearing epochs. `requestClearing` is the netting preview only, the
 *    same restriction the MCP surface applies.
 *
 * Not offered, because no route serves it: `authority.getMandate`. A method that
 * always throws is worse than one that is absent.
 */

import { mitraRequestTypedData, registrationRequest, requestBodyHash, type MitraRequest } from "@/lib/identity/signed-request";
import type { NettingResult } from "@/lib/kernel/clearing";
import type { Inbox, InboxKind } from "@/lib/inbox";
import type {
  Agent, Agreement, AgreementStatus, Authorization, Chain, ClearingEpoch, Intent, Money, Saga, Space,
} from "@/lib/domain/types";

/** Anything that can sign EIP-712 typed data for one address: a viem `LocalAccount`, or a wallet adapter. */
export interface MitraSigner {
  address: `0x${string}`;
  signTypedData(typedData: ReturnType<typeof mitraRequestTypedData>): Promise<`0x${string}`>;
}

export interface MitraClientOptions {
  /** API root, e.g. `https://mitra.example`. Paths under `/api/v1` are appended. */
  baseUrl: string;
  signer: MitraSigner;
  /** The chain id the signer signs under. It must be a chain of one of the agent's registered wallets. */
  chainId: number;
  /** The agent this client acts as. */
  agentId: string;
  /** How long a signed request stays valid. Default 300 seconds. */
  requestTtlSeconds?: number;
  fetch?: typeof fetch;
}

/** A refusal or failure answered by the API. `code` is the API's `error` field, verbatim. */
export class MitraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} → ${status} ${code}`);
    this.name = "MitraApiError";
  }
}

export type AgreementOp = "fund" | "startExecution" | "submitDeliverable" | "acceptDeliverable" | "rejectDeliverable" | "refund";
export type AgreementView = Agreement & { availableOps: AgreementOp[] };
export interface TransitionResult { agreement: AgreementView; space: Space; saga?: Saga }

export interface AgreementDraft {
  agreementId: string;
  runId: string;
  intentId: string;
  client: string;
  provider: string;
  evaluator: string;
  price: Money;
  deadline: string;
  acceptanceCriteria?: string[];
  externalJobRefs?: Array<string | { system: string; id: string; url?: string }>;
  failurePolicy?: string;
  payTo?: { chain: Chain; address: string };
}

/** The on-chain escrow a `fund` binds; the kernel derives and commits the refund route from it. */
export interface OnChainEscrow { chain: string; contractAddress: string; jobId: string; timeout?: number }

export interface AuthorizationProposal {
  mandateId: string;
  vaultId: string;
  amount: number;
  asset: string;
  chain: string;
  counterparty: string;
  capability: string;
  intentId?: string;
  runId?: string;
  now?: string;
}

export interface IntentDraft {
  intentId?: string;
  runId: string;
  principal: string;
  initiatingAgentId: string;
  mandateId: string;
  objective: string;
  budget: Money;
  constraints: string[];
  expiresAt: string;
}

export type SagaView = Saga & { isRecovered: boolean; isTerminal: boolean };

export class MitraClient {
  readonly commerce;
  readonly authority;
  readonly agents;
  readonly clearing;
  readonly recovery;
  readonly inbox;

  readonly #opts: MitraClientOptions;
  readonly #root: string;
  readonly #fetch: typeof fetch;

  constructor(opts: MitraClientOptions) {
    this.#opts = opts;
    this.#root = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;

    this.commerce = {
      /** Opens an agreement. Unsigned, as the API requires: an OPEN agreement commits no value. */
      createAgreement: (input: { spaceId: string; draft: AgreementDraft; proposal: { capability: string; amount: Money } }) =>
        this.#call<{ agreement: AgreementView; space: Space }>("POST", "/agreements", { op: "open", ...input }),
      getAgreement: (agreementId: string) =>
        this.#call<AgreementView>("GET", `/agreements?agreementId=${encodeURIComponent(agreementId)}`),
      listAgreements: (filter: { spaceId?: string } = {}) =>
        this.#call<AgreementView[]>("GET", `/agreements${query(filter)}`),
      fund: (agreementId: string, opts: { onChainEscrow?: OnChainEscrow } = {}) =>
        this.#transition("fund", agreementId, opts),
      startExecution: (agreementId: string) => this.#transition("startExecution", agreementId),
      submitDeliverable: (agreementId: string, deliverable: { artifactRefs: string[]; contentHash: string }) =>
        this.#transition("submitDeliverable", agreementId, deliverable),
      /** With `onChainEscrow`, the API also releases the escrow to the provider on chain. */
      acceptDeliverable: (agreementId: string, opts: { onChainEscrow?: OnChainEscrow } = {}) =>
        this.#transition("acceptDeliverable", agreementId, opts),
      /** With `onChainEscrow`, the API also refunds the escrow on chain, by the route committed at funding. */
      rejectDeliverable: (agreementId: string, opts: { failureReason?: string; onChainEscrow?: OnChainEscrow } = {}) =>
        this.#transition("rejectDeliverable", agreementId, opts),
      createIntent: (draft: IntentDraft) => this.#call<Intent>("POST", "/intents", draft),
      getIntent: (intentId: string) => this.#call<Intent>("GET", `/intents/${encodeURIComponent(intentId)}`),
    };

    this.authority = {
      /**
       * The policy engine's decision on a proposed action. A DENY is returned, not
       * thrown: it is the answer. An ALLOW is not permission to move value.
       */
      requestAuthorization: (proposal: AuthorizationProposal) =>
        this.#call<Authorization>("POST", "/authorizations", proposal, { decisionOn403: true }),
      /** What the Space can still commit: its budget less what funded agreements hold. */
      getHeadroom: async (spaceId: string): Promise<Money> =>
        (await this.#call<{ availableHeadroom: Money }>("GET", `/spaces/${encodeURIComponent(spaceId)}`)).availableHeadroom,
    };

    this.agents = {
      /** Registers this client's agent with the signer's wallet, proven by its signature. */
      register: async (profile: { name: string; owner: string; capabilities?: string[]; protocols?: string[]; chain?: "base" | "tempo" }) => {
        const agent = {
          agentId: opts.agentId, name: profile.name, owner: profile.owner,
          wallets: [{ chain: profile.chain ?? walletChainOf(opts.chainId), address: opts.signer.address }],
          capabilities: profile.capabilities ?? [], protocols: profile.protocols ?? [],
        };
        const expiresAt = this.#expiresAt();
        const signature = await opts.signer.signTypedData(mitraRequestTypedData(registrationRequest(agent, expiresAt), opts.chainId));
        return this.#call<Agent>("POST", "/agents", {
          agent, expiresAt, proofs: [{ signer: opts.signer.address, chainId: opts.chainId, signature }],
        });
      },
      getAgent: (agentId: string) => this.#call<Agent>("GET", `/agents?agentId=${encodeURIComponent(agentId)}`),
      findAgents: (filter: { capability?: string; chain?: Chain } = {}) => this.#call<Agent[]>("GET", `/agents${query(filter)}`),
    };

    this.clearing = {
      getEpoch: (epochId: string) => this.#call<ClearingEpoch>("GET", `/clearing?epochId=${encodeURIComponent(epochId)}`),
      listEpochs: () => this.#call<ClearingEpoch[]>("GET", "/clearing?view=epochs"),
      /** Nets the stored obligations and returns the result. A preview: nothing is opened, stored or settled. */
      requestClearing: () =>
        this.#call<NettingResult & { compressionRatio: number; conservationVerified: boolean }>("POST", "/clearing", { action: "net" }),
      /** The residual transfers netting the stored obligations would leave. */
      listResiduals: async () => (await this.#call<NettingResult>("GET", "/clearing")).residualTransfers,
    };

    this.recovery = {
      getSaga: (sagaId: string) => this.#call<SagaView>("GET", `/sagas?sagaId=${encodeURIComponent(sagaId)}`),
      listSagas: (filter: { runId?: string } = {}) => this.#call<SagaView[]>("GET", `/sagas${query(filter)}`),
      /**
       * Asks for the agreement's escrow back. The signed `refund` op: the caller
       * names the agreement and a reason, never a route, payee or amount.
       */
      refundEscrow: (agreementId: string, opts: { failureReason?: string } = {}) =>
        this.#transition("refund", agreementId, opts),
    };

    this.inbox = {
      /** What this agent (or `agentId`) can act on now, most urgent first. Each item names the ops it may sign. */
      list: (filter: { kinds?: InboxKind[]; agentId?: string } = {}) =>
        this.#call<Inbox & { generatedAt: string }>(
          "GET",
          `/inbox/${encodeURIComponent(filter.agentId ?? opts.agentId)}${query({ kind: filter.kinds?.join(",") })}`,
        ),
    };
  }

  #expiresAt(): number {
    return Math.floor(Date.now() / 1000) + (this.#opts.requestTtlSeconds ?? 300);
  }

  /**
   * Reads the agreement's status, signs the exact body, sends it. If the
   * agreement moves between the read and the send, the signature is stale and
   * the API refuses it; the client does not retry on the caller's behalf.
   */
  async #transition(op: AgreementOp, agreementId: string, fields: Record<string, unknown> = {}): Promise<TransitionResult> {
    const current = await this.commerce.getAgreement(agreementId);
    // The canonical hash ignores undefined keys, as JSON.stringify drops them, so
    // the hash signed here is the hash the server computes over its parsed body.
    const body = { op, agreementId, ...fields };
    const expiresAt = this.#expiresAt();
    const request: MitraRequest = {
      op, agreementId, fromStatus: current.status satisfies AgreementStatus, actor: this.#opts.agentId,
      bodyHash: requestBodyHash(body), expiresAt,
    };
    const signature = await this.#opts.signer.signTypedData(mitraRequestTypedData(request, this.#opts.chainId));
    return this.#call<TransitionResult>("POST", "/agreements", {
      ...body,
      auth: { actor: this.#opts.agentId, signer: this.#opts.signer.address, chainId: this.#opts.chainId, signature, expiresAt },
    });
  }

  async #call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { decisionOn403?: boolean } = {}): Promise<T> {
    const url = `${this.#root}/api/v1${path}`;
    const res = await this.#fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (res.ok) return parsed?.data as T;
    if (opts.decisionOn403 && res.status === 403 && parsed?.data?.decision === "DENY") return parsed.data as T;
    const code = typeof parsed?.error === "string" ? parsed.error : `HTTP_${res.status}`;
    throw new MitraApiError(res.status, code, parsed, method, path);
  }
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
}

/** The Mitra chain a signing chain id belongs to, for a registration that does not name one. */
function walletChainOf(chainId: number): "base" | "tempo" {
  if (chainId === 8453 || chainId === 84532) return "base";
  if (chainId === 4217 || chainId === 42431) return "tempo";
  throw new Error(`MitraClient: chain id ${chainId} is not a Base or Tempo chain; pass profile.chain explicitly`);
}
