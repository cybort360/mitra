import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";
import type { EvidenceBundle } from "@/lib/evm/evidence";

export interface ProviderCandidate {
  externalId: string;
  source: string;
  name: string;
  capabilities: string[];
  price?: Money;
  settlementNetworks: Chain[];
  paymentMethods: string[];
  reputationRefs: string[];
}

export interface MarketplaceAdapter {
  readonly name: string;
  discover(criteria: { capability: string; maxPrice?: number }): Promise<ProviderCandidate[]>;
  getAgent(externalId: string): Promise<ProviderCandidate | null>;
  createJob(input: { providerId: string; objective: string; agreementId: string }): Promise<{ externalJobId: string; state: string }>;
  getJob(externalJobId: string): Promise<{ state: string; artifactRefs: string[] }>;
  cancelJob(externalJobId: string): Promise<void>;
}

export interface PaymentAdapter {
  readonly name: string;
  createBoundedSession(input: { reservationId: string; recipient: string; ceiling: Money; expiresAt: string }): Promise<{ sessionId: string }>;
  charge(input: { sessionId: string; amount: Money; resource: string }): Promise<{ paymentRef: string; evidenceLevel: EvidenceLevel }>;
  close(sessionId: string): Promise<void>;
}

/**
 * The settlement surface.
 *
 * `getEvidence` is PRD §21.4's `getEvidence(ref)` and is the only method here
 * that lets a party OUTSIDE Mitra check a claim. Its absence was the gap
 * described in `lib/evm/evidence.ts`: every other method produces or observes a
 * local truth, and a counterparty could not verify any of it.
 *
 * The interface remains uniform across rails on purpose (§21.3): the roles
 * differ, the shape does not.
 */
export interface SettlementAdapter {
  readonly chain: Chain;
  validateTarget(input: { asset: string; recipient: string; amount: number }): Promise<void>;
  settle(input: { settlementId: string; from: string; to: string; amount: Money; commitmentHash: string }): Promise<{ txHash: string; evidenceLevel: EvidenceLevel }>;
  verify(txHash: string): Promise<{ confirmed: boolean }>;
  /** PRD §21.4. Returns a bundle a third party can re-derive, or null. */
  getEvidence(ref: { settlementId: string }): Promise<EvidenceBundle | null>;
}

export class UnconfiguredAdapterError extends Error {
  constructor(name: string){ super(`${name} is not configured. This repository does not claim a live external integration.`); }
}
