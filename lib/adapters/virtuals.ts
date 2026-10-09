/**
 * Virtuals marketplace adapter — "one deep marketplace adapter" (PRD Phase 5).
 *
 * ## The design constraint, which is the whole point
 *
 * This adapter operates under a Space with `rules.source = "external"`. It does
 * **not** get to decide how a Virtuals job works. Virtuals publishes its own
 * rule set; Mitra references it by digest and complies with what it publishes.
 *
 * That is the pattern ADR-0011 locked: integrate a marketplace by *referencing*
 * its rules, not by re-implementing them. An adapter that encoded Virtuals'
 * semantics inside Mitra would make Mitra the authority on Virtuals' marketplace
 * — the centralisation the whole Space redesign exists to remove.
 *
 * So this adapter does three things and refuses a fourth:
 *   - discovers providers FROM the marketplace (their rules, their list)
 *   - opens a job in the marketplace's own lifecycle
 *   - maps Mitra obligations to marketplace states
 *   - REFUSES to adjudicate. Disputes and acceptance are the marketplace's.
 *
 * ## What is not claimed
 *
 * No network transport. `discover` and `createJob` require an injected client;
 * without one they throw `UnconfiguredAdapterError` rather than returning
 * fixtures. A marketplace adapter that invents providers is worse than none,
 * because the discovery result is what a principal relies on.
 */

import type { Chain, EvidenceLevel } from "@/lib/domain/types";
import type { MarketplaceAdapter, ProviderCandidate } from "./types";
import { UnconfiguredAdapterError } from "./types";
import type { Space } from "@/lib/domain/types";
import { isExternallyGoverned } from "@/lib/kernel/space-governance";
import { resolveAsset } from "@/lib/kernel/space-assets";
import { getAddress, isAddress } from "viem";
import type { Agent, AgreementStatus, Money } from "@/lib/domain/types";
import { typedHash } from "@/lib/domain/canonical";
import { fail, pass, type Result } from "@/lib/kernel/commerce";

/** The rule set this adapter operates under. Recorded so drift is detectable. */
import { privateKeyToAccount } from "viem/accounts";
import {
  SimulatedVirtualsTransport, VirtualsHttpTransport,
  type SessionDelegation,
} from "@/lib/adapters/virtuals-transport";

export const VIRTUALS_RULE_SET = {
  ref: "virtuals:acp:v1",
  digest: "sha256:virtuals-acp-v1",
} as const;

export interface VirtualsClient {
  /**
   * Which transport this is. Added by LP-8 so a resolved client is inspectable: a caller
   * holding a `VirtualsClient` must be able to tell a live transport from the simulator
   * without reaching for a private field or a cast.
   */
  readonly name?: string;
  /** Providers, as the MARKETPLACE lists them. Not filtered by us. */
  listProviders(capability: string): Promise<Array<{ id: string; name: string; capabilities: string[]; priceUsd?: number }>>;
  openJob(input: { providerId: string; objective: string; agreementId: string; maxUsd: number }): Promise<{ jobId: string; state: string }>;
  jobState(jobId: string): Promise<{ state: string; artifacts: string[] }>;
  cancelJob(jobId: string): Promise<void>;
}

export class VirtualsMarketplaceAdapter implements MarketplaceAdapter {
  readonly name = "virtuals";

  /**
   * @param space the Space the engagement runs in. REQUIRED: without it there is
   *   no governance, no asset set and no rule digest, and a marketplace adapter
   *   without those would silently reintroduce a single operator.
   */
  constructor(
    private readonly client: VirtualsClient | undefined,
    private readonly space: Space | null,
  ) {}

  /** This adapter only operates under an external rule set it does not own. */
  private requireExternalRules(spaceId: string): Space {
    if (!this.space) {
      throw new UnconfiguredAdapterError("virtuals adapter (no Space supplied)");
    }
    if (!isExternallyGoverned(this.space)) {
      throw new Error(
        `ADAPTER_REQUIRES_EXTERNAL_RULES:${spaceId}. A marketplace adapter must run under the ` +
          `marketplace's rule set; running it under Mitra's own rules would make Mitra the ` +
          `authority on someone else's marketplace.`,
      );
    }
    return this.space;
  }

  /**
   * Discovers providers, as the MARKETPLACE lists them.
   *
   * No local filtering, no local ranking, no "approved" shortlist. A principal
   * choosing a provider is choosing from the marketplace's market, and Mitra
   * substituting its own judgement for that is how a "deep adapter" becomes a
   * closed marketplace.
   */
  async discover(criteria: { capability: string; maxPrice?: number }): Promise<ProviderCandidate[]> {
    const space = this.requireExternalRules(this.space!.spaceId);
    if (!this.client) throw new UnconfiguredAdapterError("virtuals discovery");
    const raw = await this.client.listProviders(criteria.capability);

    return raw.map((p) => ({
      externalId: `virtuals:${p.id}`,
      source: "virtuals",
      name: p.name,
      capabilities: p.capabilities,
      ...(p.priceUsd === undefined ? {} : { price: { asset: "USDC", amount: p.priceUsd } }),
      // The Space says which rails it settles on; the marketplace has no say.
      settlementNetworks: space.settlementChains as Chain[],
      paymentMethods: ["x402", "erc8183"],
      reputationRefs: [],
    }));
  }

  async getAgent(externalId: string): Promise<ProviderCandidate | null> {
    const capability = "research";
    const all = await this.discover({ capability });
    return all.find((p) => p.externalId === externalId) ?? null;
  }

  /**
   * Opens a job in the MARKETPLACE's lifecycle.
   *
   * The price is resolved through `resolveAsset`, so a job can only be opened in
   * an asset the Space actually admitted. It refuses rather than defaulting to a
   * hardcoded token.
   */
  async createJob(input: {
    providerId: string;
    objective: string;
    agreementId: string;
    maxUsd: number;
  }): Promise<{ externalJobId: string; state: string }> {
    const space = this.requireExternalRules(this.space!.spaceId);
    const asset = resolveAsset(space, "USDC");
    if (!asset.ok) {
      throw new Error(
        `MARKETPLACE_JOB_ASSET_NOT_ADMITTED:${asset.reason}. The marketplace is not permitted to ` +
          `price this engagement in an asset the Space has not recorded.`,
      );
    }
    if (!this.client) throw new UnconfiguredAdapterError("virtuals createJob");
    const job = await this.client.openJob({
      providerId: input.providerId,
      objective: input.objective,
      agreementId: input.agreementId,
      maxUsd: input.maxUsd,
    });
    // Renamed to the Mitra-side name. The marketplace's field is ITS vocabulary;
    // passing it through unlabelled would make the two indistinguishable in a
    // disagreement about which id a job has.
    return { externalJobId: job.jobId, state: job.state };
  }

  async getJob(externalJobId: string): Promise<{ state: string; artifactRefs: string[] }> {
    this.requireExternalRules(this.space!.spaceId);
    if (!this.client) throw new UnconfiguredAdapterError("virtuals getJob");
    const j = await this.client.jobState(externalJobId);
    return { state: j.state, artifactRefs: j.artifacts };
  }

  async cancelJob(externalJobId: string): Promise<void> {
    this.requireExternalRules(this.space!.spaceId);
    if (!this.client) throw new UnconfiguredAdapterError("virtuals cancelJob");
    await this.client.cancelJob(externalJobId);
  }

  /**
   * Maps a MARKETPLACE job state onto a Mitra agreement status.
   *
   * Returns null for states with no honest equivalent. The marketplace owns its
   * lifecycle; guessing would put Mitra's vocabulary over someone else's process,
   * and an unrecognised state must never be coerced into "REJECTED" — that is a
   * decision Mitra is not entitled to make.
   */
  static toAgreementStatus(marketState: string): string | null {
    switch (marketState) {
      case "open": return "OPEN";
      case "funded": return "FUNDED";
      case "running": return "EXECUTING";
      case "submitted": return "SUBMITTED";
      case "completed": return "ACCEPTED";
      case "failed": return "REJECTED";
      case "canceled": return "CANCELED";
      default: return null;
    }
  }

  /** Evidence level for a marketplace-observed job. Never higher than observed. */
  evidenceFor(observed: boolean): EvidenceLevel {
    return observed ? "TESTNET_PASS" : "DESIGN_ONLY";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACP translation (PP-2): Virtuals Agent Commerce Protocol ⇄ Mitra
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything below is a pure translation of the marketplace's own data. The
// shapes are ACP's, not invented: they follow @virtuals-protocol/acp-node
// 0.3.0-beta.40 (`AcpAgent`, `AcpJobOffering`, `AcpJob`, `AcpJobPhases`, and the
// `_hydrateAgent` / `_hydrateJob` readers of the acpx API), and are pinned by
// responses recorded from https://acpx.virtuals.gg in
// tests/fixtures-data/virtuals-acp-agents.json (decision ctx_aaff541a2a361c1b).
//
// The functions refuse rather than guess. A quote Mitra cannot bound with a
// mandate, a token it cannot name, or a wallet it cannot tie to a registered
// agent never becomes an Intent or an AgreementDraft.

/**
 * The ACP deployments, per the SDK's `baseSepoliaAcpConfig[V2]` / `baseAcpConfig[V2]`.
 *
 * `mitraChain` is the Mitra rail the job's price settles on. Mainnet ACP is
 * recognised so its listings can be identified, but it is not settleable: Mitra's
 * `base` chain is Base Sepolia (lib/evm/evidence.ts), and paying a mainnet
 * provider on a testnet rail would be a payment to nobody.
 */
export const ACP_NETWORKS = {
  84532: {
    name: "base-sepolia",
    api: "https://acpx.virtuals.gg",
    contracts: ["0x8Db6B1c839Fc8f6bd35777E194677B67b4D51928", "0xdf54E6Ed6cD1d0632d973ADECf96597b7e87893c"],
    fare: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, asset: "USDC" },
    mitraChain: "base",
  },
  8453: {
    name: "base",
    api: "https://acpx.virtuals.io",
    contracts: ["0x6a1FE26D54ab0d3E1e3168f2e0c0cDa5cC0A0A4A", "0xa6C9BA866992cfD7fd6460ba912bfa405adA9df0"],
    fare: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, asset: "USDC" },
    mitraChain: null,
  },
} as const satisfies Record<number, {
  name: string; api: string; contracts: readonly string[];
  fare: { address: string; decimals: number; asset: "USDC" }; mitraChain: Chain | null;
}>;
export type AcpChainId = keyof typeof ACP_NETWORKS;

/** `AcpJobPhases`, as the contract and the API number them. */
export const AcpJobPhase = {
  REQUEST: 0, NEGOTIATION: 1, TRANSACTION: 2, EVALUATION: 3, COMPLETED: 4, REJECTED: 5, EXPIRED: 6,
} as const;

/** An offering as the acpx API returns it (`agent.jobs[]`). */
export interface AcpApiOffering {
  name: string;
  description?: string;
  price?: number;
  priceV2?: { type: string; value: number };
  requiredFunds?: boolean;
  slaMinutes?: number;
  requirement?: Record<string, unknown> | string;
  deliverable?: Record<string, unknown> | string;
  hide?: boolean;
  isPrivate?: boolean;
}

/** An agent as the acpx API returns it. */
export interface AcpApiAgent {
  id: number | string;
  name: string;
  walletAddress: string;
  contractAddress: string;
  jobs: AcpApiOffering[];
}

/** A job as the acpx API returns it (the fields `_hydrateJob` reads). */
export interface AcpApiJob {
  id: number;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  price: number;
  priceTokenAddress: string;
  phase: number;
  contractAddress: string;
  memos?: Array<{ nextPhase?: number }>;
}

/** A verified, priced, single offering of one ACP provider. */
export interface VirtualsQuote {
  chainId: AcpChainId;
  acpContract: `0x${string}`;
  providerAcpId: string;
  providerWallet: `0x${string}`;
  offeringName: string;
  price: Money;
  /** The price in the fare token's base units, as a decimal string. */
  priceBaseUnits: string;
  fareToken: `0x${string}`;
  slaMinutes: number;
  requirementSchema?: Record<string, unknown>;
  deliverableSpec?: string;
  /** Binds every term above, so a draft that drifts from its quote is detectable. */
  quoteDigest: string;
}

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const network = (chainId: number) => (ACP_NETWORKS as Record<number, (typeof ACP_NETWORKS)[AcpChainId]>)[chainId];

/**
 * Verifies one offering into a quote Mitra can bound.
 *
 * Refused, each with its own reason:
 * - an unknown ACP network, or an agent served by a contract that is not ACP's;
 * - a missing agent id, or a wallet that is not an address;
 * - a price that is not `fixed`: a percentage or subscription price has no amount
 *   a mandate can bound before the job runs;
 * - a price that is not positive, or finer than the fare token can express;
 * - `requiredFunds`: the provider also takes client capital beyond the price,
 *   which would move value outside the agreement that prices it;
 * - a non-positive or fractional SLA.
 */
export function verifyQuote(chainId: number, agent: AcpApiAgent, offeringName: string): Result<VirtualsQuote> {
  const net = network(chainId);
  if (!net) return fail("ACP_NETWORK_UNKNOWN");
  if (agent.id === undefined || agent.id === null || String(agent.id) === "") return fail("MISSING_AGENT_IDENTIFIER");
  if (!agent.walletAddress) return fail("MISSING_AGENT_IDENTIFIER");
  if (!isAddress(agent.walletAddress, { strict: false })) return fail("AGENT_WALLET_INVALID");
  if (!agent.contractAddress || !net.contracts.some((c) => eqAddr(c, agent.contractAddress))) {
    return fail("ACP_CONTRACT_NOT_RECOGNIZED");
  }
  const offering = agent.jobs?.find((j) => j.name === offeringName);
  if (!offering) return fail("OFFERING_NOT_FOUND");

  // The SDK's own reading: priceV2 when present, else the legacy fixed price.
  const priceType = offering.priceV2?.type ?? "fixed";
  const value = offering.priceV2?.value ?? offering.price;
  if (priceType !== "fixed") return fail("PRICE_TYPE_UNSUPPORTED");
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fail("PRICE_INVALID");
  const scaled = value * 10 ** net.fare.decimals;
  const baseUnits = Math.round(scaled);
  if (Math.abs(scaled - baseUnits) > 1e-6 || baseUnits <= 0 || !Number.isSafeInteger(baseUnits)) {
    return fail("PRICE_PRECISION_EXCEEDS_TOKEN");
  }
  if (offering.requiredFunds) return fail("REQUIRES_FUNDS_TRANSFER");
  const sla = offering.slaMinutes;
  if (typeof sla !== "number" || !Number.isInteger(sla) || sla <= 0) return fail("SLA_INVALID");

  const requirementSchema = typeof offering.requirement === "object" && offering.requirement !== null ? offering.requirement : undefined;
  const deliverableSpec = typeof offering.deliverable === "string"
    ? (offering.deliverable || undefined)
    : offering.deliverable ? JSON.stringify(offering.deliverable) : undefined;

  const terms = {
    chainId: Number(chainId) as AcpChainId,
    acpContract: getAddress(agent.contractAddress),
    providerAcpId: String(agent.id),
    providerWallet: getAddress(agent.walletAddress),
    offeringName,
    price: { asset: net.fare.asset, amount: baseUnits / 10 ** net.fare.decimals } as Money,
    priceBaseUnits: String(baseUnits),
    fareToken: getAddress(net.fare.address),
    slaMinutes: sla,
    ...(requirementSchema ? { requirementSchema } : {}),
    ...(deliverableSpec ? { deliverableSpec } : {}),
  };
  return pass({ ...terms, quoteDigest: typedHash("mitra.virtuals.quote", terms) });
}

/**
 * A pre-flight check of a service requirement against the offering's schema:
 * required keys present, and each declared primitive type matched. It is not a
 * full JSON Schema validator; ACP's own SDK validates fully when the job is
 * initiated. Its job is to refuse an obviously malformed gig before Mitra records
 * an intent for it.
 */
export function checkRequirement(quote: VirtualsQuote, requirement: unknown): Result<true> {
  const schema = quote.requirementSchema;
  if (!schema) return pass(true);
  if (typeof requirement !== "object" || requirement === null || Array.isArray(requirement)) return fail("REQUIREMENT_NOT_AN_OBJECT");
  const req = requirement as Record<string, unknown>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in req)) return fail(`REQUIREMENT_MISSING_FIELD:${key}`);
  }
  const props = (schema.properties as Record<string, { type?: string }> | undefined) ?? {};
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in req) || !spec?.type) continue;
    const v = req[key];
    const ok = spec.type === "array" ? Array.isArray(v)
      : spec.type === "object" ? typeof v === "object" && v !== null && !Array.isArray(v)
      : spec.type === "integer" ? Number.isInteger(v)
      : typeof v === spec.type;
    if (!ok) return fail(`REQUIREMENT_TYPE_MISMATCH:${key}`);
  }
  return pass(true);
}

/** What a Mitra client proposes to buy from an ACP provider. */
export interface VirtualsGig {
  quote: VirtualsQuote;
  /** The ACP `serviceRequirement`: what the job asks for. */
  requirement: Record<string, unknown> | string;
  /** ACP evaluator wallet; omitted means ACP's default (the client evaluates). */
  evaluatorAddress?: `0x${string}`;
  /** ACP `expiredAt`, ISO-8601. Also the agreement's deadline. */
  expiredAt: string;
}

const requirementHash = (r: VirtualsGig["requirement"]) => typedHash("mitra.virtuals.requirement", r);

/** The `externalJobRefs` a Virtuals-sourced agreement carries (PRD §8.4). */
export function acpRefs(gig: Pick<VirtualsGig, "quote" | "requirement">): string[] {
  const q = gig.quote;
  return [
    `virtuals-acp:${q.chainId}:${q.acpContract}:offering:${q.providerWallet}:${encodeURIComponent(q.offeringName)}`,
    `virtuals-acp:quote:${q.quoteDigest}`,
    `virtuals-acp:requirement:${requirementHash(gig.requirement)}`,
  ];
}

/** Checks a gig before anything is recorded for it. */
function checkGig(gig: VirtualsGig, now: number): Result<true> {
  const req = checkRequirement(gig.quote, gig.requirement);
  if (!req.ok) return req;
  const expires = Date.parse(gig.expiredAt);
  if (!Number.isFinite(expires)) return fail("EXPIRY_INVALID");
  if (expires <= now) return fail("EXPIRY_IN_PAST");
  if (gig.evaluatorAddress !== undefined && !isAddress(gig.evaluatorAddress, { strict: false })) return fail("EVALUATOR_WALLET_INVALID");
  return pass(true);
}

/** The body for `mitra_create_intent` / `POST /api/v1/intents` (no intentId: Mitra assigns it). */
export function gigToIntent(
  gig: VirtualsGig,
  ctx: { runId: string; principal: string; initiatingAgentId: string; mandateId: string },
  now: number = Date.now(),
): Result<{ runId: string; principal: string; initiatingAgentId: string; mandateId: string; objective: string;
  budget: Money; constraints: string[]; expiresAt: string }> {
  const ok = checkGig(gig, now);
  if (!ok.ok) return ok;
  const q = gig.quote;
  return pass({
    ...ctx,
    objective: `Virtuals ACP offering "${q.offeringName}" from provider ${q.providerWallet} (ACP agent ${q.providerAcpId})`,
    budget: { ...q.price },
    constraints: [...acpRefs(gig), `virtuals-acp:sla_minutes:${q.slaMinutes}`],
    expiresAt: new Date(Date.parse(gig.expiredAt)).toISOString(),
  });
}

/** The arguments for `mitra_create_agreement`, minus `spaceId`. */
export interface VirtualsAgreementArgs {
  draft: {
    agreementId: string; runId: string; intentId: string; client: string; provider: string; evaluator: string;
    price: Money; deadline: string; acceptanceCriteria: string[];
    payTo: { chain: Chain; address: string }; externalJobRefs: string[];
  };
  proposal: { capability: string; amount: Money };
}

/**
 * A gig as a Mitra agreement draft.
 *
 * The provider is paid at the ACP wallet the marketplace listed, on the rail the
 * ACP network settles to, and the agreement keeps the offering, quote and
 * requirement as external refs. `capability` is the Space's word for the work,
 * passed in rather than derived from the offering name: which capabilities a
 * Space admits is the Space's decision, not the adapter's.
 */
export function gigToAgreementDraft(
  gig: VirtualsGig,
  ctx: { agreementId: string; runId: string; intentId: string; client: string; provider: string; evaluator: string; capability: string },
  now: number = Date.now(),
): Result<VirtualsAgreementArgs> {
  const ok = checkGig(gig, now);
  if (!ok.ok) return ok;
  const q = gig.quote;
  const chain = network(q.chainId)?.mitraChain;
  if (!chain) return fail("ACP_NETWORK_NOT_SETTLEABLE");
  const { capability, ...ids } = ctx;
  return pass({
    draft: {
      ...ids,
      price: { ...q.price },
      deadline: new Date(Date.parse(gig.expiredAt)).toISOString(),
      acceptanceCriteria: q.deliverableSpec ? [q.deliverableSpec] : [],
      payTo: { chain, address: q.providerWallet },
      externalJobRefs: acpRefs(gig),
    },
    proposal: { capability, amount: { ...q.price } },
  });
}

/** What ACP's `initiateJob` needs, recovered from a Mitra agreement. */
export interface AcpJobRequest {
  chainId: AcpChainId;
  acpContract: `0x${string}`;
  providerAddress: `0x${string}`;
  offeringName: string;
  requirement: VirtualsGig["requirement"];
  evaluatorAddress?: `0x${string}`;
  expiredAt: string;
  fare: { token: `0x${string}`; amountBaseUnits: string };
}

/**
 * The reverse direction: a Mitra agreement back into the ACP job it stands for.
 *
 * The agreement is checked against the quote, not trusted: its price, payee,
 * offering ref, quote digest and requirement hash must all match. An agreement
 * that was amended away from its quote would otherwise open an ACP job on terms
 * nobody quoted.
 */
export function agreementToAcpJob(
  draft: Pick<VirtualsAgreementArgs["draft"], "price" | "payTo" | "deadline" | "externalJobRefs">,
  gig: Pick<VirtualsGig, "quote" | "requirement" | "evaluatorAddress">,
): Result<AcpJobRequest> {
  const q = gig.quote;
  const expected = acpRefs(gig);
  for (const ref of expected) if (!draft.externalJobRefs.includes(ref)) return fail("AGREEMENT_DIVERGES_FROM_QUOTE:REF");
  if (draft.price.asset !== q.price.asset || draft.price.amount !== q.price.amount) return fail("AGREEMENT_DIVERGES_FROM_QUOTE:PRICE");
  if (draft.payTo.chain !== network(q.chainId)?.mitraChain || !eqAddr(draft.payTo.address, q.providerWallet)) {
    return fail("AGREEMENT_DIVERGES_FROM_QUOTE:PAYEE");
  }
  return pass({
    chainId: q.chainId,
    acpContract: q.acpContract,
    providerAddress: q.providerWallet,
    offeringName: q.offeringName,
    requirement: gig.requirement,
    ...(gig.evaluatorAddress ? { evaluatorAddress: getAddress(gig.evaluatorAddress) } : {}),
    expiredAt: draft.deadline,
    fare: { token: q.fareToken, amountBaseUnits: q.priceBaseUnits },
  });
}

/**
 * Counterparty attestation: the ACP provider IS the Mitra agent.
 *
 * The listing's wallet must be one the agent registered on the rail the job
 * settles to. Registration proved control of that wallet with an EIP-712
 * signature (F55), so this binds the marketplace identity to the Mitra identity
 * cryptographically. A name match, or the agent's own claim, would not.
 */
export function attestCounterparty(quote: VirtualsQuote, agent: Pick<Agent, "agentId" | "status" | "wallets">): Result<true> {
  const chain = network(quote.chainId)?.mitraChain;
  if (!chain) return fail("ACP_NETWORK_NOT_SETTLEABLE");
  if (agent.status === "SUSPENDED" || agent.status === "REVOKED") return fail("COUNTERPARTY_INACTIVE");
  const bound = agent.wallets.some((w) => w.chain === chain && eqAddr(w.address, quote.providerWallet));
  return bound ? pass(true) : fail("COUNTERPARTY_NOT_ATTESTED");
}

/**
 * Checks an ACP job observed on the marketplace against the quote it was opened
 * from: same contract, same provider, same price, in the fare token. A job priced
 * in any other token is refused rather than converted: Mitra will not name an
 * asset the network's fare does not.
 */
export function verifyAcpJob(job: AcpApiJob, quote: VirtualsQuote): Result<true> {
  if (!eqAddr(job.contractAddress, quote.acpContract)) return fail("ACP_CONTRACT_MISMATCH");
  if (!eqAddr(job.providerAddress, quote.providerWallet)) return fail("PROVIDER_MISMATCH");
  if (!eqAddr(job.priceTokenAddress, quote.fareToken)) return fail("UNMAPPED_TOKEN");
  if (job.price !== quote.price.amount) return fail("PRICE_MISMATCH");
  return pass(true);
}

/**
 * An ACP job phase as a Mitra agreement status.
 *
 * ACP has no separate "funded, not started" state: the client pays into escrow on
 * entering TRANSACTION and the provider works in it, so TRANSACTION is EXECUTING.
 * ACP's REJECTED covers both a provider declining a request and an evaluator
 * rejecting a deliverable; Mitra's REJECTED means only the second, so a job
 * rejected before EVALUATION is CANCELED. An unknown phase is null, never a guess.
 */
export function acpPhaseToAgreementStatus(phase: number, opts: { reachedEvaluation: boolean }): AgreementStatus | null {
  switch (phase) {
    case AcpJobPhase.REQUEST:
    case AcpJobPhase.NEGOTIATION: return "OPEN";
    case AcpJobPhase.TRANSACTION: return "EXECUTING";
    case AcpJobPhase.EVALUATION: return "SUBMITTED";
    case AcpJobPhase.COMPLETED: return "ACCEPTED";
    case AcpJobPhase.REJECTED: return opts.reachedEvaluation ? "REJECTED" : "CANCELED";
    case AcpJobPhase.EXPIRED: return "EXPIRED";
    default: return null;
  }
}

/** Whether a job's memo history shows it reached EVALUATION (for the REJECTED split). */
export function reachedEvaluation(job: Pick<AcpApiJob, "phase" | "memos">): boolean {
  return job.phase === AcpJobPhase.EVALUATION || job.phase === AcpJobPhase.COMPLETED
    || (job.memos ?? []).some((m) => m.nextPhase === AcpJobPhase.EVALUATION || m.nextPhase === AcpJobPhase.COMPLETED);
}

/**
 * Default ACP client resolution (LP-8).
 *
 * ## Why this returns `undefined` rather than always returning something
 *
 * A session key is only usable under a **delegation**, and a delegation is signed by the
 * agent's own wallet. So there is no configuration in which this can produce a working
 * client without one — and a function that returned a "best effort" client anyway would
 * reintroduce exactly the defect `UnconfiguredAdapterError` was written for: a 2xx that
 * looks like a marketplace call and performed none.
 *
 * So the resolution has three outcomes and no fourth:
 *
 * - API key **and** session key **and** a delegation → the live HTTP transport.
 * - A delegation and session key but no API key → the **simulator**, which announces
 *   `isSimulated: true` / `LOCAL_PASS` and performs the identical scope check.
 * - No delegation, or no session key → `undefined`, so the adapter raises
 *   `UnconfiguredAdapterError`.
 *
 * ## The space's rule digest is threaded through, not re-derived
 *
 * ADR-0011 says this adapter runs under the *marketplace's* rule set. The delegation
 * commits to that digest, and the Space's digest is checked against it on every call — so a
 * Virtuals ACP session inside a Mitra-ruled Space is refused rather than quietly accepted.
 * Passing the Space's digest in, rather than reading a global, keeps the check on the value
 * that actually governs this agreement.
 */
export function virtualsClientFromEnv(input: {
  delegation: SessionDelegation;
  /** Hex private key for the SESSION key. Never the vault key. */
  sessionKeyHex?: string;
  /** The Space's rule digest, when the call runs inside a governed Space. */
  spaceRuleDigest?: string;
  testnet?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
}, env: Record<string, string | undefined> = process.env): VirtualsClient | undefined {
  const { delegation, sessionKeyHex, spaceRuleDigest } = input;
  if (!delegation || !sessionKeyHex) return undefined;

  const sessionKey = (() => {
    try {
      return privateKeyToAccount((sessionKeyHex.startsWith("0x") ? sessionKeyHex : `0x${sessionKeyHex}`) as `0x${string}`);
    } catch {
      return null;
    }
  })();
  if (!sessionKey) return undefined;

  const shared = { delegation, sessionKey, ...(spaceRuleDigest !== undefined ? { spaceRuleDigest } : {}), ...(input.now ? { now: input.now } : {}) };

  const apiKey = env.VIRTUALS_API_KEY;
  if (apiKey) {
    return new VirtualsHttpTransport({
      ...shared,
      apiKey,
      testnet: input.testnet ?? true,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  }
  return new SimulatedVirtualsTransport(shared);
}
