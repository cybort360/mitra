import type { Chain, EvidenceLevel, Money, Settlement } from "@/lib/domain/types";
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
  /**
   * PRD §21.4. A bundle a third party can re-derive, built from what the chain
   * reports NOW, never from the settlement record's own `status`.
   *
   * - `null`: nothing was observed (no tx hash, not found, not confirmed, no
   *   transport). Absence of evidence, not a verdict.
   * - throws `EVIDENCE_CONTRADICTED:<field>` when the chain shows a transaction
   *   that disagrees with the record, and `EVIDENCE_RECORD_INCONSISTENT` when the
   *   record's stored commitment does not re-derive from its own terms. A
   *   contradiction is not absence, so it is not collapsed into `null`.
   */
  getEvidence(req: EvidenceRequest): Promise<EvidenceBundle | null>;
}

export interface EvidenceRequest {
  settlement: Settlement;
  /** When the observation is made. Passed in: adapters have no clock. */
  observedAt: string;
}

/**
 * What a transport read back from the chain for one transaction — only values
 * the chain itself reported, never values copied from the request.
 *
 * Returned only for a transaction the transport would also `verify` as confirmed:
 * succeeded, called the expected contract/program, and delivered `amountAtomic` to
 * `to`. Anything less is `null`.
 */
export interface ChainObservation {
  txHash: string;
  /** EVM block number, or Solana slot. 0 when the node did not report one. */
  block: number;
  /** The 32-byte commitment the transaction carried (calldata suffix, memo, or permit action hash). */
  carriedCommitment: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  /** Token contract or mint; null for native lamports. */
  asset: string | null;
}

export class UnconfiguredAdapterError extends Error {
  constructor(name: string){ super(`${name} is not configured. This repository does not claim a live external integration.`); }
}
