import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";

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

export interface SettlementAdapter {
  readonly chain: Chain;
  validateTarget(input: { asset: string; recipient: string; amount: number }): Promise<void>;
  settle(input: { settlementId: string; from: string; to: string; amount: Money; commitmentHash: string }): Promise<{ txHash: string; evidenceLevel: EvidenceLevel }>;
  verify(txHash: string): Promise<{ confirmed: boolean }>;
}

export class UnconfiguredAdapterError extends Error {
  constructor(name: string){ super(`${name} is not configured. This repository does not claim a live external integration.`); }
}
