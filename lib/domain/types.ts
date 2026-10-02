export type Chain = "solana" | "base" | "tempo";
export type AssetSymbol = "USDC" | "USDT" | "SOL" | "ETH";
export type EvidenceLevel =
  | "DESIGN_ONLY"
  | "LOCAL_PASS"
  | "TESTNET_PASS"
  | "LIVE_PUBLIC_PASS"
  | "PRODUCTION_PASS"
  | "FAILED"
  | "BLOCKED";

export type AgentStatus = "DISCOVERED" | "REGISTERED" | "FUNDED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
export type MandateStatus = "DRAFT" | "ACTIVE" | "EXPIRED" | "REVOKED" | "SUSPENDED";
export type ReservationStatus = "REQUESTED" | "RESERVED" | "COMMITTED" | "RELEASED" | "EXPIRED" | "CANCELED" | "SETTLING" | "SETTLED";
export type AuthorizationDecision = "ALLOW" | "DENY" | "REVIEW";
export type AgreementStatus = "OPEN" | "FUNDED" | "EXECUTING" | "SUBMITTED" | "ACCEPTED" | "REJECTED" | "REFUNDED" | "CANCELED" | "EXPIRED";
export type ObligationStatus = "PROPOSED" | "ACCEPTED" | "ACCRUING" | "DUE" | "DISPUTED" | "DEFAULTED" | "CLEARED" | "SETTLING" | "SETTLED";
export type SagaStatus = "DECLARED" | "EXECUTING" | "RECOVERY_PENDING" | "RECOVERING" | "RECOVERED" | "CONTAINED" | "ABORTED";
export type ClearingStatus = "OPEN" | "FROZEN" | "CALCULATING" | "CHALLENGE" | "FINALIZED" | "SETTLING" | "SETTLED";
export type SettlementStatus = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "REVERSED";
export type RunStatus = "RUNNING" | "WAITING" | "RECOVERING" | "CLEARING" | "SETTLING" | "SETTLED" | "CONTAINED" | "FAILED";

export interface Money {
  asset: AssetSymbol;
  amount: number;
}

export interface ExternalIdentityRef {
  system: string;
  id: string;
  url?: string;
}

export interface Agent {
  agentId: string;
  name: string;
  owner: string;
  status: AgentStatus;
  wallets: { chain: Chain; address: string }[];
  capabilities: string[];
  marketplaceRefs: ExternalIdentityRef[];
  protocols: string[];
  activeMandates: string[];
  activeRuns: string[];
  exposure: number;
  createdAt: string;
  version: number;
}

export interface Vault {
  vaultId: string;
  name: string;
  principal: string;
  controllerRef: string;
  chain: Chain;
  asset: AssetSymbol;
  address: string;
  total: number;
  available: number;
  reserved: number;
  escrowed: number;
  encumbered: number;
  settling: number;
  frozen: number;
  activeMandates: string[];
  activeReservations: string[];
  emergencyFreeze: boolean;
  custodyMode: "CAPITAL_HOLDING" | "POLICY_CONTROLLED_EXTERNAL";
  version: number;
}

export interface Mandate {
  mandateId: string;
  name: string;
  version: number;
  principal: string;
  agentId: string;
  vaultId: string;
  asset: AssetSymbol;
  budget: number;
  maxTransaction: number;
  velocityLimit?: { amount: number; windowMinutes: number };
  allowedCounterparties: string[];
  allowedCapabilities: string[];
  prohibitedCapabilities: string[];
  approvedChains: Chain[];
  policyVersion: string;
  expiresAt: string;
  nonce: number;
  status: MandateStatus;
  confidentialPolicy: boolean;
}

/**
 * A **bounded commercial context** (PRD §13.1).
 *
 * The PRD defines the Space as the container a job lives inside — treasury,
 * participants, rules, work orders. Mitra had no equivalent type at all: the
 * word appears 35 times in Microcosm's source and 0 times here, while PRD §50
 * explicitly asks for the "Space concept" to be reused.
 *
 * Its absence was not cosmetic. Without a container there is no scoped
 * authority — a mandate, a rule and an evaluator are all global, so an agent
 * admitted to one engagement is implicitly admitted to every one. That is the
 * opposite of §13.1's "bounded", and it is the containment property the whole
 * policy-enclave idea rests on.
 *
 * Deliberately a *value* type with an `id`, not a class: the kernel stays pure
 * and the boundary is enforced by callers comparing `spaceId`, which keeps the
 * guarantee testable rather than hidden in inheritance.
 */
export type SpaceStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";

export interface Space {
  spaceId: string;
  /** Owning agent or organisation. The only party that may amend the rules. */
  owner: string;
  status: SpaceStatus;
  /** Agents permitted inside this context. Membership is the containment check. */
  participants: string[];
  /** Capability allow-list scoped to this Space. */
  allowedCapabilities: string[];
  /** Chains this Space may settle on. */
  settlementChains: string[];
  /**
   * ~~Agreements opened inside this Space.~~ REMOVED.
   *
   * This field duplicated `Agreement.spaceId` in the opposite direction, and only
   * ONE of the two was enforced: the database has a real foreign key from
   * `agreements.space_id` to `spaces.space_id`, so an agreement must name a Space
   * that exists — but nothing ever checked this list. It could name an agreement
   * that does not exist, one belonging to a *different* Space, or a stale entry
   * after a move, and no test, query or constraint would notice.
   *
   * The reverse question is answered by query, not by a second copy:
   * `SELECT * FROM mitra.agreements WHERE space_id = $1`. Removing the list takes
   * the drift risk to zero rather than trading it for a consistency check nobody
   * would remember to write.
   */
  /** Maximum capital this Space may encumber in total — a treasury ceiling. */
  budget: Money;
  /** Encumbered so far against live agreements. */
  committed: Money;
  version: number;
  createdAt: string;
}

export interface Intent {
  intentId: string;
  runId: string;
  principal: string;
  initiatingAgentId: string;
  mandateId: string;
  objective: string;
  budget: Money;
  constraints: string[];
  createdAt: string;
  expiresAt: string;
  version: number;
}

export interface Reservation {
  reservationId: string;
  runId: string;
  vaultId: string;
  intentId: string;
  agreementId?: string;
  mandateId: string;
  mandateVersion: number;
  asset: AssetSymbol;
  amount: number;
  chain: Chain;
  actionDigest: string;
  expiresAt: string;
  nonce: number;
  status: ReservationStatus;
  version: number;
}

export interface Authorization {
  authorizationId: string;
  runId: string;
  intentId: string;
  mandateId: string;
  mandateVersion: number;
  vaultId: string;
  decision: AuthorizationDecision;
  actionDigest: string;
  asset: AssetSymbol;
  amountCeiling: number;
  recipientConstraint?: string;
  chain: Chain;
  expiresAt: string;
  nonce: number;
  reasonCodes: string[];
  enclaveAttestationRef?: string;
  reservationRef?: string;
  signer: string;
  version: number;
}

export interface Agreement {
  agreementId: string;
  /**
   * The Space this agreement belongs to.
   *
   * Added because without it containment is advisory: `applyAgreementOp(space,
   * agreement, ...)` takes the Space as an argument, so a caller is free to hand
   * in the wrong one and every rule check silently validates against a Space the
   * agreement was never in. Storing the link means a wrong Space is detectable
   * (the two ids disagree) rather than merely a mistake someone must remember to
   * avoid — which is the difference between a check and a convention.
   */
  spaceId: string;
  runId: string;
  intentId: string;
  client: string;
  provider: string;
  evaluator?: string;
  externalJobRefs: ExternalIdentityRef[];
  price: Money;
  deadline: string;
  acceptanceCriteria: string[];
  escrowRef?: string;
  failurePolicy: string;
  status: AgreementStatus;
  version: number;
}

export interface Deliverable {
  deliverableId: string;
  agreementId: string;
  provider: string;
  artifactRefs: string[];
  contentHash: string;
  evidenceRefs: string[];
  submittedAt: string;
  accepted: boolean;
  version: number;
}

export interface Obligation {
  obligationId: string;
  runId: string;
  debtor: string;
  creditor: string;
  amount: Money;
  agreementRef?: string;
  sourceEvent: string;
  dueAt: string;
  priority: number;
  collateralRef?: string;
  status: ObligationStatus;
  nonce: number;
  version: number;
}

export interface SagaStep {
  stepId: string;
  name: string;
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "COMPENSATED" | "SKIPPED";
  attempts: number;
  failureReason?: string;
}

export interface Saga {
  sagaId: string;
  runId: string;
  intentId: string;
  steps: SagaStep[];
  compensationRoutes: string[];
  timeoutPolicy: string;
  status: SagaStatus;
  recoveredValue: number;
  containedValue: number;
  version: number;
}

export interface ClearingEpoch {
  epochId: string;
  status: ClearingStatus;
  asset: AssetSymbol;
  settlementDomain: Chain;
  obligationIds: string[];
  excludedObligations: { obligationId: string; reason: string }[];
  grossVolume: number;
  netResidual: number;
  netPositions: { party: string; amount: number }[];
  residualTransfers: { from: string; to: string; amount: number }[];
  inputsRoot?: string;
  resultHash?: string;
  computationVersion: string;
  openedAt: string;
  finalizedAt?: string;
}

export interface Settlement {
  settlementId: string;
  runId?: string;
  epochId?: string;
  obligationIds: string[];
  chain: Chain;
  asset: AssetSymbol;
  amount: number;
  from: string;
  to: string;
  txHash?: string;
  receiptId: string;
  status: SettlementStatus;
  submittedAt: string;
  confirmedAt?: string;
  evidenceLevel: EvidenceLevel;
}

export interface Receipt {
  receiptId: string;
  runId?: string;
  receiptType: string;
  eventType: string;
  subject: string;
  result: "SUCCESS" | "FAILURE" | "PENDING";
  reasonCodes: string[];
  payloadHash: string;
  previousReceiptHash?: string;
  signer: string;
  createdAt: string;
  chainEvidence: string[];
  version: number;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  at: string;
  kind: "AUTHORITY" | "VAULT" | "DISCOVERY" | "COMMERCE" | "PAYMENT" | "RECOVERY" | "OBLIGATION" | "CLEARING" | "SETTLEMENT" | "SYSTEM";
  title: string;
  description: string;
  status: "INFO" | "SUCCESS" | "WARNING" | "FAILURE";
  receiptId?: string;
  objectRef?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface Run {
  runId: string;
  title: string;
  objective: string;
  principal: string;
  agentId: string;
  vaultId: string;
  mandateId: string;
  intentId: string;
  agreementId?: string;
  sagaId?: string;
  status: RunStatus;
  budget: Money;
  reserved: number;
  spent: number;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  network: Chain;
  currentStage: string;
  eventIds: string[];
}

export interface Integration {
  integrationId: string;
  name: string;
  category: "CHAIN" | "MARKETPLACE" | "PROTOCOL" | "PAYMENT" | "PRIVACY";
  version: string;
  network: string;
  evidenceLevel: EvidenceLevel;
  status: "HEALTHY" | "DEGRADED" | "BLOCKED" | "NOT_CONFIGURED";
  description: string;
  lastCheckedAt: string;
  knownLimitation?: string;
  testCommand?: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  integration: string;
  level: EvidenceLevel;
  network: string;
  commit: string;
  testCommand: string;
  transactionHash?: string;
  vaultAddress?: string;
  reservationId?: string;
  authorizationId?: string;
  knownLimitation?: string;
  recordedAt: string;
}
