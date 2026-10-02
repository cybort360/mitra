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

/** The rule set this adapter operates under. Recorded so drift is detectable. */
export const VIRTUALS_RULE_SET = {
  ref: "virtuals:acp:v1",
  digest: "sha256:virtuals-acp-v1",
} as const;

export interface VirtualsClient {
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
