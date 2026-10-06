export type Chain = "solana" | "base" | "tempo";
/**
 * Assets Mitra can name.
 *
 * **Widened for Tempo's TIP-20 tokens.** Tempo settles in PathUSD / AlphaUSD /
 * BetaUSD / ThetaUSD / OpenUSD and has NO USDC and NO OUSD — the original enum
 * could not express a Tempo settlement at all, which is how `lib/adapters/tempo.ts`
 * ended up carrying a fabricated "USDC" mint to satisfy the type. F39 then widened
 * it to include an equally fabricated "OUSD"; see F40.
 *
 * That is the real lesson: the type was the reason the invented address existed,
 * so widening it removes the pressure that produced the invention. A type that
 * cannot express the domain invites a fake to fill the gap. The type must still be
 * checked against the chain, because a widened type can be filled with a name that
 * does not exist either — which is precisely what happened twice.
 *
 * Membership here says nothing about whether a symbol resolves on a given chain:
 * `USDC` is still legal because it is real on Base and Solana. Admissibility is
 * decided per Space from chain data (see `lib/kernel/space-assets.ts`), not by this
 * union.
 *
 * The chain-specific addresses live in the adapters and, per ADR-0011 open item
 * 2, should ultimately be per-Space configuration resolved from chain.
 */
export type AssetSymbol =
  | "USDC" | "USDT" | "SOL" | "ETH"
  // Tempo TIP-20 (verified against Moderato, chain id 42431)
  | "PathUSD" | "AlphaUSD" | "BetaUSD" | "ThetaUSD" | "OpenUSD";
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
/**
 * PRD 15.3, verbatim:
 * `DECLARED -> ARMED -> EXECUTING -> STEP_FAILURE -> COMPENSATING -> {RECOVERED, CONTAINED, ABORTED}`.
 *
 * ARMED is not decoration. PRD 15.5 requires the compensation route to be
 * committed *before* execution, and ARMED is the state in which it is committed.
 */
export type SagaStatus =
  | "DECLARED"
  | "ARMED"
  | "EXECUTING"
  | "STEP_FAILURE"
  | "COMPENSATING"
  | "RECOVERED"
  | "CONTAINED"
  | "ABORTED";
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

/** A reference to an external job or offering: either a structured ref or a namespaced URN string (F68). */
export type ExternalJobRef = ExternalIdentityRef | string;

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

/**
 * How a Space takes binding decisions.
 *
 * **The mode is not a Mitra setting.** It is what the Space's own participants
 * agreed to, recorded in the Space. `ADMIN` is a deliberate, small, fast
 * arrangement — an operator acting alone, chosen by people who could have chosen
 * quorum. `QUORUM` means no single participant can bind or freeze the others.
 *
 * Both are legitimate. What was illegitimate was shipping only one and letting a
 * single `owner` freeze a context other agents were party to — see ADR-0011.
 */
export type SpaceGovernanceMode = "ADMIN" | "QUORUM";

export interface SpaceGovernance {
  mode: SpaceGovernanceMode;
  /** Participants who may act alone. Only consulted in ADMIN mode. */
  admins: string[];
  /** Participants who may vote. In ADMIN mode this is the full membership. */
  governors: string[];
  /**
   * Distinct governors required for a binding decision.
   *
   * In ADMIN mode this is 1 (one admin suffices). In QUORUM mode it is the
   * quorum the participants agreed, and it MUST be at least 2 — a "quorum" of one
   * is an admin wearing a quorum's name, and is refused rather than honoured.
   */
  threshold: number;
}

/**
 * Where a Space's rules come from.
 *
 * Marketplaces have their own rules. Re-implementing them inside Mitra would make
 * Mitra the authority on someone else's marketplace, which is exactly the
 * centralisation this design exists to remove. So an external rule set is
 * referenced **by identity and content hash**, and Mitra does not need to
 * understand it in order to comply with it.
 *
 * That is what makes integration without absorption possible: Mitra binds itself
 * to a digest, and a marketplace changing its rules becomes *detectable* rather
 * than silently ignored.
 */
export interface SpaceRules {
  source: "mitra" | "external";
  /** For `external`: the marketplace's rule set identity, e.g. "virtuals:acp:v1". */
  ruleSetRef?: string;
  /**
   * Content hash of the rule set in force. Recorded so a later change is visible.
   * An external rule set whose digest differs from the recorded one is a CHANGE,
   * and must be surfaced rather than silently applied.
   */
  digest: string;
}

export interface Space {
  spaceId: string;
  /**
   * Nominally owning agent. **NOT an authority.**
   *
   * Retained because a Space usually has an initiator, but binding decisions run
   * through `governance`, and `owner` cannot suspend, amend or close anything by
   * itself. A single field that *looks* like an authority is how the previous
   * design failed review.
   */
  owner: string;
  /** Who may bind the Space, and by what threshold. See ADR-0011. */
  governance: SpaceGovernance;
  /** Where this Space's rules come from. See `SpaceRules`. */
  rules: SpaceRules;
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
  /**
   * Assets this Space admits, resolved per engagement.
   *
   * **These were module constants in each adapter** — `BASE_ASSETS`,
   * `SOLANA_ASSETS`, `TEMPO_TOKENS` — which meant one deployer decided which
   * assets and which mint addresses are real. That is a custodian deciding what
   * capital is admissible, and it contradicts the whole premise.
   *
   * Moving the registry into the Space makes it participant configuration:
   * resolvable on chain, changeable by the Space's own governance, and absent
   * where a marketplace's rules govern instead.
   */
  assets?: Record<string, { address: string; decimals: number }>;

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
  /** The clearing residual this reservation pays, `<epochId>#<index>` (Phase 7). Bound into the digest. */
  residualRef?: string;
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
   * The Spaces this agreement participates in.
   *
   * **An ARRAY, and it may be EMPTY.** Both properties are load-bearing, and both
   * came from ADR-0011's open items:
   *
   * Empty means the agreement is NOT inside a Mitra tenancy. That is the
   * interoperability requirement (§3.3: Mitra "works with external agent
   * economies rather than requiring agents to migrate"), and it was impossible
   * while `spaceId` was required and backed by a `NOT NULL` foreign key.
   *
   * More than one means a multi-party engagement spans contexts — a client, a
   * provider and an evaluator each in their own Space. Forcing that into one
   * Space made every such arrangement single-owner, which is the centralisation
   * ADR-0011 removes.
   *
   * `applyAgreementOp` still takes a Space as an argument; storing the ids makes a
   * WRONG Space detectable (the ids disagree) rather than a mistake to remember.
   */
  spaceIds: string[];
  runId: string;
  intentId: string;
  client: string;
  provider: string;
  evaluator?: string;
  externalJobRefs: ExternalJobRef[];
  price: Money;
  deadline: string;
  acceptanceCriteria: string[];
  escrowRef?: string;
  /**
   * PRD §15.5's commitment for this agreement's on-chain escrow: `keccak256` of the
   * refund route string, set once at `fund` and never changed.
   *
   * This is the SAME value the escrow account carries in `refundRouteHash` — the EVM
   * `MitraJobEscrow.sol` `Job` and the Solana `JobEscrow` PDA both store it and both
   * revert `NoCommitment` if it is zero. Keeping one value in two places is the
   * point: the kernel refuses to run a route that does not hash to this, and the
   * contract refuses an escrow that has no commitment to check. Neither check is
   * useful if the two hold different numbers.
   *
   * Derived by the kernel from the refund route it builds, never supplied by the
   * caller. A caller-supplied hash would let the commitment describe a route other
   * than the one that actually gets compensated — the commitment would be real, and
   * about nothing.
   */
  refundRouteHash?: string;
  failurePolicy: string;
  status: AgreementStatus;
  /**
   * Whether this agreement's price has already been returned to the Space's
   * available budget.
   *
   * Present because it is the only thing that makes PRD §13.4's "Funds must not be
   * double-released" representable. Inferring it from `status` alone is not enough:
   * the machine permits `ACCEPTED -> REFUNDED`, so a settled agreement has two
   * distinct terminal-looking states and "is this still encumbered?" has no single
   * answer without a flag. Set once, never unset, and asserted by
   * `tests/commerce-escrow.test.ts`.
   *
   * Added with F42, which found that `space.committed` was incremented on `fund`
   * and never decremented — so a Space could spend its budget exactly once over.
   */
  escrowReleased?: boolean;
  /**
   * The settlement that discharged this agreement, once one has occurred.
   *
   * Separate from `escrowReleased` because the two happen at different moments:
   * escrow is released on ACCEPTANCE (F42), while settlement is the act of paying
   * and can happen later, exactly once. Collapsing them means either an accepted
   * agreement can never be settled, or it can be settled repeatedly — the first
   * version of `assertSettlementBinding` had exactly that bug, and the test caught
   * it rather than the reasoning.
   */
  settledRef?: string;
  /**
   * Where the provider is paid, recorded as a TERM of the agreement.
   *
   * Without it the payee would have to come from the settlement request, so
   * whoever called settle would choose where the money went — the same
   * caller-chosen-payee defect F51 found on chain (`spend_authorized` let the
   * caller name the recipient). Fixed at open and changed only by amendment,
   * like the provider itself (see `assertSettlementBinding`).
   *
   * Optional because an agreement may be opened before the rail is known; such an
   * agreement can be accepted but not settled (`PAYOUT_ADDRESS_MISSING`).
   */
  payTo?: { chain: Chain; address: string };
  /**
   * The saga that governs this agreement's failure path (F49 Step 2).
   *
   * Optional because not every agreement needs recovery machinery, and because an
   * multi-step engagement may have several. When present it is the ONLY thing that
   * may advance the agreement's recovery — the agreement state and the saga state are
   * kept in step by `applyAgreementOpWithSaga`, never by two independent callers.
   */
  sagaIds?: string[];
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
  /**
   * How many times each compensation route has actually been executed.
   *
   * **F47.** `CompensationRoute.maxAttempts` existed and `compensate()` checked it,
   * but the count came from `input.availableRoutes` — an array the CALLER supplies on
   * every invocation. The kernel never decremented anything, so the limit was enforced
   * only as far as the caller chose to enforce it. Passing the original routes again
   * gave unlimited compensation.
   *
   * Tracking it here makes the limit a property of the saga rather than of the
   * caller's diligence, which is the only place it can actually be relied upon.
   */
  routeAttempts?: Record<string, number>;
  /**
   * The PRD §15.5 commitment for each route, keyed by `routeId`, recorded when the
   * saga was DECLARED — i.e. before any step ran.
   *
   * This exists because `compensate()` receives route **bodies** from a
   * caller-supplied array while the saga itself persisted only route **ids**. An
   * id commits to nothing: the same id could arrive carrying different calldata and
   * the engine would run it, which is §15.5's forbidden post-failure calldata by
   * another name. Hashing the route at declaration binds the two, so the check at
   * compensation time is "is this the route I committed to" rather than "did the
   * caller use the right id".
   *
   * Set by `declareSaga` for every route, so it cannot be omitted by accident. A
   * saga persisted before this field existed has none, and `compensate` refuses
   * those rather than waving them through — an unverifiable commitment is not a
   * commitment.
   */
  routeCommitments?: Record<string, string>;
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
  /** The agreement this settlement discharges, when it pays one (sprint item 1). */
  agreementId?: string;
  /** The reservation whose nonce this settlement consumed. */
  reservationId?: string;
  /** The rail-specific commitment the transfer carries on chain. */
  commitment?: string;
  /** Why the settlement stopped, when it did. Machine-readable. */
  failureReason?: string;
  obligationIds: string[];
  chain: Chain;
  asset: AssetSymbol;
  amount: number;
  from: string;
  to: string;
  txHash?: string;
  /**
   * The receipt for this settlement, once one exists. Optional because receipts
   * have no store yet: a settlement executed by `lib/settlement/settle-agreement.ts`
   * has no receipt to point at, and an invented id would be the F24 pattern
   * (a reference to a record that does not exist).
   */
  receiptId?: string;
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
  /**
   * EIP-191 signature over `receiptHash(receipt)` by the address in `signer`
   * (`"eip191:<address>"`), when the receipt is signed (backlog #4). Not part of the
   * hashed body: it attests to the hash, and the chain is the same with or without it.
   */
  signature?: string;
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
