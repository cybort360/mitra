import type {
  Agent, Agreement, Authorization, ClearingEpoch, Deliverable, EvidenceRecord, Integration,
  Mandate, Obligation, Receipt, Reservation, Run, RunEvent, Saga, Settlement, Space, Vault
} from "@/lib/domain/types";

export const vaults: Vault[] = [
  {
    vaultId: "vault_sol_primary",
    name: "Primary research treasury",
    principal: "Mitra Labs",
    controllerRef: "solana:program:mitra-vault-devnet",
    chain: "solana",
    asset: "USDC",
    address: "8J8dPqRr4Xo1g7Vf2Z3mQxN6AqB1sY7kP9LdE4Mitra",
    total: 142800,
    available: 91240,
    reserved: 18420,
    escrowed: 21540,
    encumbered: 7420,
    settling: 3180,
    frozen: 1000,
    activeMandates: ["mandate_research_v7", "mandate_data_v4"],
    activeReservations: ["res_run501", "res_run498", "res_run496"],
    emergencyFreeze: false,
    custodyMode: "CAPITAL_HOLDING",
    version: 8,
  },
  {
    vaultId: "vault_base_ops",
    name: "Base commerce treasury",
    principal: "Mitra Labs",
    controllerRef: "base:smart-account:0x9ec1",
    chain: "base",
    asset: "USDC",
    address: "0x9EC1A997fF47a49C89A8d5131E75A0E01B7C19dB",
    total: 42800,
    available: 31040,
    reserved: 4200,
    escrowed: 5560,
    encumbered: 1200,
    settling: 800,
    frozen: 0,
    activeMandates: ["mandate_yield_v2"],
    activeReservations: ["res_run492"],
    emergencyFreeze: false,
    custodyMode: "POLICY_CONTROLLED_EXTERNAL",
    version: 4,
  },
  {
    vaultId: "vault_tempo_settle",
    name: "Tempo settlement reserve",
    principal: "Mitra Labs",
    controllerRef: "tempo:reserve:demo",
    chain: "tempo",
    asset: "USDC",
    address: "tempo_reserve_demo_01",
    total: 18000,
    available: 18000,
    reserved: 0,
    escrowed: 0,
    encumbered: 0,
    settling: 0,
    frozen: 0,
    activeMandates: [],
    activeReservations: [],
    emergencyFreeze: false,
    custodyMode: "POLICY_CONTROLLED_EXTERNAL",
    version: 1,
  },
];

export const agents: Agent[] = [
  {
    agentId: "agent_buyer_07",
    name: "Buyer Agent 07",
    owner: "Mitra Labs",
    status: "ACTIVE",
    wallets: [
      { chain: "solana", address: "Byr7J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T1Buyer" },
      { chain: "base", address: "0xB070000000000000000000000000000000000007" },
    ],
    capabilities: ["market_research", "provider_discovery", "job_orchestration", "payment_execution"],
    marketplaceRefs: [{ system: "virtuals", id: "virtuals:buyer-07" }],
    protocols: ["A2A", "MCP", "x402"],
    activeMandates: ["mandate_research_v7"],
    activeRuns: ["run_501", "run_496"],
    exposure: 19.2,
    createdAt: "2026-09-26T10:00:00Z",
    version: 7,
  },
  {
    agentId: "agent_data_03",
    name: "Data Agent 03",
    owner: "Mitra Labs",
    status: "ACTIVE",
    wallets: [{ chain: "solana", address: "Data3J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T3Data" }],
    capabilities: ["structured_data", "api_procurement", "artifact_validation"],
    marketplaceRefs: [{ system: "olas", id: "olas:mech:data-03" }],
    protocols: ["A2A", "MCP", "MPP"],
    activeMandates: ["mandate_data_v4"],
    activeRuns: ["run_498"],
    exposure: 25.2,
    createdAt: "2026-09-25T09:30:00Z",
    version: 4,
  },
  {
    agentId: "agent_eval_02",
    name: "Evaluator Agent 02",
    owner: "Mitra Labs",
    status: "ACTIVE",
    wallets: [{ chain: "solana", address: "Eval2J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T2Eval" }],
    capabilities: ["deliverable_evaluation", "schema_validation", "evidence_verification"],
    marketplaceRefs: [],
    protocols: ["A2A", "MCP"],
    activeMandates: [],
    activeRuns: ["run_501"],
    exposure: 0,
    createdAt: "2026-09-24T08:00:00Z",
    version: 3,
  },
  {
    agentId: "agent_recovery_01",
    name: "Recovery Keeper 01",
    owner: "Mitra Labs",
    status: "ACTIVE",
    wallets: [{ chain: "solana", address: "Rec1J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T1Recv" }],
    capabilities: ["failure_observation", "reassignment", "refund", "containment"],
    marketplaceRefs: [],
    protocols: ["MCP"],
    activeMandates: [],
    activeRuns: ["run_501"],
    exposure: 0,
    createdAt: "2026-09-24T08:10:00Z",
    version: 2,
  },
  {
    agentId: "agent_clearing_01",
    name: "Clearing Agent 01",
    owner: "Mitra Labs",
    status: "ACTIVE",
    wallets: [{ chain: "solana", address: "Clr1J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T1Clear" }],
    capabilities: ["obligation_netting", "clearing_proposal", "result_commitment"],
    marketplaceRefs: [],
    protocols: ["MCP"],
    activeMandates: [],
    activeRuns: [],
    exposure: 0,
    createdAt: "2026-09-24T08:20:00Z",
    version: 2,
  },
];

export const mandates: Mandate[] = [
  {
    mandateId: "mandate_research_v7",
    name: "Research purchasing",
    version: 7,
    principal: "Mitra Labs",
    agentId: "agent_buyer_07",
    vaultId: "vault_sol_primary",
    asset: "USDC",
    budget: 50,
    maxTransaction: 15,
    velocityLimit: { amount: 50, windowMinutes: 60 },
    allowedCounterparties: ["virtuals:*", "olas:*", "x402:approved:*"],
    allowedCapabilities: ["market_research", "structured_data", "api_access"],
    prohibitedCapabilities: ["unsecured_credit", "arbitrary_transfer"],
    approvedChains: ["solana"],
    policyVersion: "policy-v3.4",
    expiresAt: "2026-10-02T23:59:59Z",
    nonce: 19,
    status: "ACTIVE",
    confidentialPolicy: true,
  },
  {
    mandateId: "mandate_data_v4",
    name: "Market data access",
    version: 4,
    principal: "Mitra Labs",
    agentId: "agent_data_03",
    vaultId: "vault_sol_primary",
    asset: "USDC",
    budget: 250,
    maxTransaction: 25,
    velocityLimit: { amount: 100, windowMinutes: 15 },
    allowedCounterparties: ["x402:approved:*", "mpp:approved:*"],
    allowedCapabilities: ["structured_data", "api_access"],
    prohibitedCapabilities: ["arbitrary_transfer"],
    approvedChains: ["solana", "base"],
    policyVersion: "policy-v2.9",
    expiresAt: "2026-10-08T23:59:59Z",
    nonce: 8,
    status: "ACTIVE",
    confidentialPolicy: false,
  },
  {
    mandateId: "mandate_yield_v2",
    name: "Yield route evaluation",
    version: 2,
    principal: "Mitra Labs",
    agentId: "agent_buyer_07",
    vaultId: "vault_base_ops",
    asset: "USDC",
    budget: 500,
    maxTransaction: 100,
    allowedCounterparties: ["erc8183:provider:*"],
    allowedCapabilities: ["yield_route_evaluation"],
    prohibitedCapabilities: ["bridge_unbounded"],
    approvedChains: ["base"],
    policyVersion: "policy-v1.6",
    expiresAt: "2026-10-10T23:59:59Z",
    nonce: 3,
    status: "ACTIVE",
    confidentialPolicy: false,
  },
];

export const runs: Run[] = [
  {
    runId: "run_501", title: "Research 100 crypto projects", objective: "Research 100 crypto projects and return a structured diligence report.",
    principal: "Mitra Labs", agentId: "agent_buyer_07", vaultId: "vault_sol_primary", mandateId: "mandate_research_v7", intentId: "intent_501",
    agreementId: "agreement_77", sagaId: "saga_501", status: "SETTLED", budget: { asset: "USDC", amount: 50 }, reserved: 12, spent: 7.2,
    createdAt: "2026-09-30T09:01:00Z", updatedAt: "2026-09-30T09:21:00Z", provider: "mech-research-backup-04", network: "solana", currentStage: "Settlement confirmed",
    eventIds: ["evt_501_01","evt_501_02","evt_501_03","evt_501_04","evt_501_05","evt_501_06","evt_501_07","evt_501_08","evt_501_09","evt_501_10","evt_501_11","evt_501_12","evt_501_13","evt_501_14"]
  },
  {
    runId: "run_498", title: "Acquire normalized market dataset", objective: "Purchase and normalize token liquidity data from an approved machine service.",
    principal: "Mitra Labs", agentId: "agent_data_03", vaultId: "vault_sol_primary", mandateId: "mandate_data_v4", intentId: "intent_498",
    agreementId: "agreement_75", status: "RUNNING", budget: { asset: "USDC", amount: 40 }, reserved: 25.2, spent: 9.6,
    createdAt: "2026-09-30T12:08:00Z", updatedAt: "2026-09-30T16:44:00Z", provider: "x402-data-provider-8", network: "solana", currentStage: "Metered execution",
    eventIds: ["evt_498_01","evt_498_02","evt_498_03","evt_498_04"]
  },
  {
    runId: "run_496", title: "Competitor coverage check", objective: "Identify current market competitors and produce a structured coverage matrix.",
    principal: "Mitra Labs", agentId: "agent_buyer_07", vaultId: "vault_sol_primary", mandateId: "mandate_research_v7", intentId: "intent_496",
    sagaId: "saga_496", status: "RECOVERING", budget: { asset: "USDC", amount: 20 }, reserved: 8.4, spent: 0.8,
    createdAt: "2026-09-30T15:04:00Z", updatedAt: "2026-09-30T16:50:00Z", provider: "virtuals:research-provider-11", network: "solana", currentStage: "Provider reassignment",
    eventIds: ["evt_496_01","evt_496_02","evt_496_03"]
  },
  {
    runId: "run_492", title: "Evaluate Base yield route", objective: "Evaluate a bounded yield route through an ERC-8183-compatible provider.",
    principal: "Mitra Labs", agentId: "agent_buyer_07", vaultId: "vault_base_ops", mandateId: "mandate_yield_v2", intentId: "intent_492",
    agreementId: "agreement_72", status: "WAITING", budget: { asset: "USDC", amount: 100 }, reserved: 100, spent: 0,
    createdAt: "2026-09-30T13:22:00Z", updatedAt: "2026-09-30T16:21:00Z", provider: "erc8183:provider-3", network: "base", currentStage: "Awaiting deliverable",
    eventIds: ["evt_492_01","evt_492_02","evt_492_03"]
  },
];

export const reservations: Reservation[] = [
  {
    reservationId: "res_run501", runId: "run_501", vaultId: "vault_sol_primary", intentId: "intent_501", agreementId: "agreement_77", mandateId: "mandate_research_v7", mandateVersion: 7,
    asset: "USDC", amount: 12, chain: "solana", actionDigest: "sha256:5ed17960f7c901501a0a5c1ff4d0f84fa9f4c312fe7a2d7e2e3be830501be501", expiresAt: "2026-09-30T10:30:00Z", nonce: 90, status: "SETTLED", version: 3,
  },
  {
    reservationId: "res_run498", runId: "run_498", vaultId: "vault_sol_primary", intentId: "intent_498", agreementId: "agreement_75", mandateId: "mandate_data_v4", mandateVersion: 4,
    asset: "USDC", amount: 25.2, chain: "solana", actionDigest: "sha256:3a93a7464fbc8e498000dc70498d973134f19ea90d498", expiresAt: "2026-09-30T18:30:00Z", nonce: 91, status: "COMMITTED", version: 2,
  },
  {
    reservationId: "res_run496", runId: "run_496", vaultId: "vault_sol_primary", intentId: "intent_496", mandateId: "mandate_research_v7", mandateVersion: 7,
    asset: "USDC", amount: 8.4, chain: "solana", actionDigest: "sha256:44960a9c33f0c834874a61fc496", expiresAt: "2026-09-30T18:00:00Z", nonce: 92, status: "RESERVED", version: 1,
  },
  {
    reservationId: "res_run492", runId: "run_492", vaultId: "vault_base_ops", intentId: "intent_492", agreementId: "agreement_72", mandateId: "mandate_yield_v2", mandateVersion: 2,
    asset: "USDC", amount: 100, chain: "base", actionDigest: "sha256:fb5b3ccb3199856ec492", expiresAt: "2026-10-01T00:00:00Z", nonce: 12, status: "COMMITTED", version: 1,
  },
];

export const authorizations: Authorization[] = [
  {
    authorizationId: "auth_501", runId: "run_501", intentId: "intent_501", mandateId: "mandate_research_v7", mandateVersion: 7, vaultId: "vault_sol_primary", decision: "ALLOW",
    actionDigest: reservations[0].actionDigest, asset: "USDC", amountCeiling: 12, recipientConstraint: "virtuals:research-provider-*", chain: "solana", expiresAt: "2026-09-30T10:30:00Z", nonce: 201,
    reasonCodes: ["CAPABILITY_ALLOWED","COUNTERPARTY_ALLOWED","BUDGET_AVAILABLE","CHAIN_ALLOWED"], enclaveAttestationRef: "arcium:attestation:demo-501", reservationRef: "res_run501", signer: "policy-engine:devnet", version: 2,
  },
  {
    authorizationId: "auth_498", runId: "run_498", intentId: "intent_498", mandateId: "mandate_data_v4", mandateVersion: 4, vaultId: "vault_sol_primary", decision: "ALLOW",
    actionDigest: reservations[1].actionDigest, asset: "USDC", amountCeiling: 25.2, recipientConstraint: "x402-data-provider-8", chain: "solana", expiresAt: "2026-09-30T18:30:00Z", nonce: 202,
    reasonCodes: ["CAPABILITY_ALLOWED","COUNTERPARTY_ALLOWED","VELOCITY_WITHIN_LIMIT"], reservationRef: "res_run498", signer: "policy-engine:devnet", version: 1,
  },
];

/**
 * Bounded commercial contexts (PRD §13.1).
 *
 * Seeded to match the three reference agreements' `spaceId` values, so the
 * containment link resolves rather than pointing at a Space that does not exist.
 * A fixture whose foreign keys dangle is worse than no fixture: it makes the
 * containment check untestable while appearing wired.
 */
export const spaces: Space[] = [
  {
    spaceId: "space_research_1",
    owner: "agent_buyer_07",
    // ADMIN mode: two participants, either may bind alone. Chosen BY the
    // participants - ADR-0011 records that neither mode is the default.
    governance: { mode: "ADMIN", admins: ["agent_buyer_07", "mech-research-backup-04"],
      governors: ["agent_buyer_07", "mech-research-backup-04", "agent_eval_02"], threshold: 1 },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE",
    participants: ["agent_buyer_07", "mech-research-backup-04", "agent_eval_02"],
    allowedCapabilities: ["research", "deliverable_evaluation", "payment"],
    settlementChains: ["solana"],
    budget: { asset: "USDC", amount: 50 },
    committed: { asset: "USDC", amount: 12 },
    version: 2,
    createdAt: "2026-09-28T08:00:00Z",
  },
  {
    spaceId: "space_data_1",
    owner: "agent_data_03",
    // QUORUM mode: two of three must agree. Neither party can freeze the other.
    governance: { mode: "QUORUM", admins: [],
      governors: ["agent_data_03", "x402-data-provider-8", "agent_observer_3"], threshold: 2 },
    rules: { source: "mitra", digest: "mitra-rules-v1" },
    status: "ACTIVE",
    participants: ["agent_data_03", "x402-data-provider-8"],
    allowedCapabilities: ["market_data", "payment"],
    settlementChains: ["solana", "base"],
    budget: { asset: "USDC", amount: 40 },
    committed: { asset: "USDC", amount: 25.2 },
    version: 1,
    createdAt: "2026-09-29T10:00:00Z",
  },
  {
    spaceId: "space_base_ops_1",
    owner: "agent_buyer_07",
    // EXTERNAL rules: this Space operates under a marketplace rule set it does
    // not own. Referenced by digest, so a change there becomes detectable rather
    // than silently applied.
    governance: { mode: "QUORUM", admins: [],
      governors: ["agent_buyer_07", "erc8183:provider-3", "agent_eval_02"], threshold: 2 },
    rules: { source: "external", ruleSetRef: "erc8183:job-lifecycle:v1", digest: "sha256:rules-8183-v1" },
    status: "ACTIVE",
    participants: ["agent_buyer_07", "erc8183:provider-3", "agent_eval_02"],
    allowedCapabilities: ["erc8183_job", "deliverable_evaluation", "payment"],
    settlementChains: ["base"],
    budget: { asset: "USDC", amount: 100 },
    committed: { asset: "USDC", amount: 100 },
    version: 1,
    createdAt: "2026-09-30T12:00:00Z",
  },
];

export const agreements: Agreement[] = [
  {
    agreementId: "agreement_77", spaceIds: ["space_research_1"], runId: "run_501", intentId: "intent_501", client: "agent_buyer_07", provider: "mech-research-backup-04", evaluator: "agent_eval_02",
    externalJobRefs: [{ system: "virtuals", id: "acp-job-123456" }, { system: "a2a", id: "task-501" }], price: { asset: "USDC", amount: 12 }, deadline: "2026-09-30T09:30:00Z",
    acceptanceCriteria: ["100 unique projects", "structured JSON output", "source URL for each project", "no duplicate project IDs"], escrowRef: "escrow_55", failurePolicy: "retry once; then reassign to approved backup; refund unused reservation", status: "ACCEPTED", version: 3,
  },
  {
    agreementId: "agreement_75", spaceIds: ["space_data_1"], runId: "run_498", intentId: "intent_498", client: "agent_data_03", provider: "x402-data-provider-8",
    externalJobRefs: [{ system: "x402", id: "session-market-data-498" }], price: { asset: "USDC", amount: 25.2 }, deadline: "2026-09-30T18:00:00Z",
    acceptanceCriteria: ["schema v2", "freshness under 90 seconds", "complete token universe"], escrowRef: "session_ceiling_498", failurePolicy: "terminate metered session and release unused reservation", status: "EXECUTING", version: 1,
  },
  {
    agreementId: "agreement_72", spaceIds: ["space_base_ops_1"], runId: "run_492", intentId: "intent_492", client: "agent_buyer_07", provider: "erc8183:provider-3", evaluator: "agent_eval_02",
    externalJobRefs: [{ system: "erc8183", id: "base-sepolia-job-72" }], price: { asset: "USDC", amount: 100 }, deadline: "2026-10-01T00:00:00Z",
    acceptanceCriteria: ["bounded route only", "no bridge", "max 2 hops", "evidence of quote freshness"], escrowRef: "erc8183:escrow-72", failurePolicy: "refund on expiry/rejection", status: "FUNDED", version: 1,
  },
];

export const deliverables: Deliverable[] = [
  {
    deliverableId: "deliverable_501", agreementId: "agreement_77", provider: "mech-research-backup-04",
    artifactRefs: ["ipfs://bafybeig-research-501/report.json", "s3://mitra-evidence/run-501/report.json"], contentHash: "sha256:1f3e6102f180cd5b1e8d8f501", evidenceRefs: ["evidence_eval_501"], submittedAt: "2026-09-30T09:16:00Z", accepted: true, version: 1,
  },
];

export const sagas: Saga[] = [
  {
    sagaId: "saga_501", runId: "run_501", intentId: "intent_501", status: "RECOVERED", recoveredValue: 11.6, containedValue: 0,
    steps: [
      { stepId: "s1", name: "Primary provider execution", state: "FAILED", attempts: 1, failureReason: "PROVIDER_TIMEOUT" },
      { stepId: "s2", name: "Release primary session", state: "COMPENSATED", attempts: 1 },
      { stepId: "s3", name: "Select approved backup", state: "SUCCEEDED", attempts: 1 },
      { stepId: "s4", name: "Backup provider execution", state: "SUCCEEDED", attempts: 1 },
    ],
    compensationRoutes: ["RETRY_SAME_PROVIDER", "REASSIGN_APPROVED_PROVIDER", "REFUND_UNUSED", "CONTAIN"], timeoutPolicy: "provider heartbeat 120s; hard timeout 300s", version: 2,
  },
  {
    sagaId: "saga_496", runId: "run_496", intentId: "intent_496", status: "COMPENSATING", recoveredValue: 0, containedValue: 0,
    steps: [
      { stepId: "s1", name: "Primary provider execution", state: "FAILED", attempts: 1, failureReason: "UPSTREAM_RATE_LIMIT" },
      { stepId: "s2", name: "Select approved backup", state: "RUNNING", attempts: 1 },
      { stepId: "s3", name: "Backup execution", state: "PENDING", attempts: 0 },
    ],
    compensationRoutes: ["REASSIGN_APPROVED_PROVIDER", "REFUND_UNUSED", "CONTAIN"], timeoutPolicy: "hard timeout 180s", version: 1,
  },
];

export const obligations: Obligation[] = [
  { obligationId: "obl_1842", runId: "run_501", debtor: "vault_sol_primary", creditor: "mech-research-backup-04", amount: { asset: "USDC", amount: 11.6 }, agreementRef: "agreement_77", sourceEvent: "evt_501_12", dueAt: "2026-09-30T09:30:00Z", priority: 1, status: "SETTLED", nonce: 1842, version: 2 },
  { obligationId: "obl_1839", runId: "run_498", debtor: "vault_sol_primary", creditor: "x402-data-provider-8", amount: { asset: "USDC", amount: 25.2 }, agreementRef: "agreement_75", sourceEvent: "evt_498_04", dueAt: "2026-09-30T18:00:00Z", priority: 1, status: "ACCRUING", nonce: 1839, version: 1 },
  { obligationId: "obl_1831", runId: "run_501", debtor: "provider-network-A", creditor: "vault_sol_primary", amount: { asset: "USDC", amount: 4.4 }, agreementRef: "agreement_77", sourceEvent: "recovery-credit", dueAt: "2026-09-30T09:30:00Z", priority: 1, status: "SETTLED", nonce: 1831, version: 1 },
  { obligationId: "obl_1824", runId: "run_492", debtor: "vault_base_ops", creditor: "erc8183:provider-3", amount: { asset: "USDC", amount: 100 }, agreementRef: "agreement_72", sourceEvent: "agreement-funded", dueAt: "2026-10-01T00:00:00Z", priority: 2, status: "DUE", nonce: 1824, version: 1 },
  { obligationId: "obl_1817", runId: "run_501", debtor: "provider-network-B", creditor: "vault_sol_primary", amount: { asset: "USDC", amount: 3.2 }, agreementRef: "agreement_77", sourceEvent: "reciprocal-service", dueAt: "2026-09-30T09:30:00Z", priority: 2, status: "SETTLED", nonce: 1817, version: 1 },
  { obligationId: "obl_1809", runId: "run_501", debtor: "vault_sol_primary", creditor: "provider-network-C", amount: { asset: "USDC", amount: 3.2 }, agreementRef: "agreement_77", sourceEvent: "evaluation-fee", dueAt: "2026-09-30T09:30:00Z", priority: 2, status: "SETTLED", nonce: 1809, version: 1 },
];

export const clearingEpochs: ClearingEpoch[] = [
  {
    epochId: "epoch_043", status: "OPEN", asset: "USDC", settlementDomain: "solana", obligationIds: ["obl_1839"], excludedObligations: [], grossVolume: 4912.6, netResidual: 1588.1,
    netPositions: [{ party: "vault_sol_primary", amount: -1210.3 }, { party: "provider-network-A", amount: 422.2 }, { party: "provider-network-B", amount: 788.1 }],
    residualTransfers: [], computationVersion: "net-v0.1.3", openedAt: "2026-09-30T16:30:00Z",
  },
  {
    epochId: "epoch_042", status: "SETTLED", asset: "USDC", settlementDomain: "solana", obligationIds: ["obl_1842","obl_1831","obl_1817","obl_1809"],
    excludedObligations: [{ obligationId: "obl_1798", reason: "DISPUTED" }], grossVolume: 22.4, netResidual: 7.2,
    netPositions: [{ party: "vault_sol_primary", amount: -7.2 }, { party: "mech-research-backup-04", amount: 7.2 }], residualTransfers: [{ from: "vault_sol_primary", to: "mech-research-backup-04", amount: 7.2 }],
    inputsRoot: "sha256:0bd6d48b0d6e42", resultHash: "sha256:a5cd22c53a14c381", computationVersion: "net-v0.1.3", openedAt: "2026-09-30T09:18:00Z", finalizedAt: "2026-09-30T09:20:00Z",
  },
];

export const settlements: Settlement[] = [
  { settlementId: "set_913", runId: "run_501", epochId: "epoch_042", obligationIds: ["obl_1842","obl_1831","obl_1817","obl_1809"], chain: "solana", asset: "USDC", amount: 7.2, from: "vault_sol_primary", to: "mech-research-backup-04", txHash: "4nW2Msx5a7cR8P3LkP", receiptId: "receipt_set_913", status: "CONFIRMED", submittedAt: "2026-09-30T09:20:30Z", confirmedAt: "2026-09-30T09:21:00Z", evidenceLevel: "LOCAL_PASS" },
  { settlementId: "set_912", epochId: "epoch_041", obligationIds: ["obl_demo_prev"], chain: "solana", asset: "USDC", amount: 191.6, from: "vault_sol_primary", to: "provider-network-B", txHash: "7Qy1aaCCbP9L0ab", receiptId: "receipt_set_912", status: "CONFIRMED", submittedAt: "2026-09-30T08:45:00Z", confirmedAt: "2026-09-30T08:45:25Z", evidenceLevel: "LOCAL_PASS" },
  { settlementId: "set_909", epochId: "epoch_041", obligationIds: ["obl_demo_base"], chain: "base", asset: "USDC", amount: 38.4, from: "vault_base_ops", to: "erc8183:provider-2", txHash: "0x41e56a0c7b", receiptId: "receipt_set_909", status: "CONFIRMED", submittedAt: "2026-09-29T18:00:00Z", confirmedAt: "2026-09-29T18:00:12Z", evidenceLevel: "DESIGN_ONLY" },
];

export const receipts: Receipt[] = [
  { receiptId: "receipt_auth_501", runId: "run_501", receiptType: "AUTHORIZATION", eventType: "AUTHORIZATION_ALLOWED", subject: "auth_501", result: "SUCCESS", reasonCodes: ["CAPABILITY_ALLOWED","BUDGET_AVAILABLE"], payloadHash: "sha256:9c4c501", signer: "policy-engine:devnet", createdAt: "2026-09-30T09:04:00Z", chainEvidence: [], version: 1 },
  { receiptId: "receipt_recovery_501", runId: "run_501", receiptType: "RECOVERY", eventType: "SAGA_RECOVERED", subject: "saga_501", result: "SUCCESS", reasonCodes: ["PROVIDER_TIMEOUT","BACKUP_PROVIDER_SUCCEEDED"], payloadHash: "sha256:8fa501", previousReceiptHash: "sha256:9c4c501", signer: "recovery-keeper:01", createdAt: "2026-09-30T09:16:00Z", chainEvidence: [], version: 1 },
  { receiptId: "receipt_clear_042", runId: "run_501", receiptType: "CLEARING", eventType: "CLEARING_FINALIZED", subject: "epoch_042", result: "SUCCESS", reasonCodes: ["DETERMINISTIC_NETTING"], payloadHash: "sha256:a5cd22c53a14c381", previousReceiptHash: "sha256:8fa501", signer: "clearing-agent:01", createdAt: "2026-09-30T09:20:00Z", chainEvidence: [], version: 1 },
  { receiptId: "receipt_set_913", runId: "run_501", receiptType: "SETTLEMENT", eventType: "SETTLEMENT_CONFIRMED", subject: "set_913", result: "SUCCESS", reasonCodes: ["RESIDUAL_TRANSFER_CONFIRMED"], payloadHash: "sha256:set913", previousReceiptHash: "sha256:a5cd22c53a14c381", signer: "settlement-adapter:solana", createdAt: "2026-09-30T09:21:00Z", chainEvidence: ["solana:tx:4nW2Msx5a7cR8P3LkP"], version: 1 },
];

export const runEvents: RunEvent[] = [
  { eventId: "evt_501_01", runId: "run_501", at: "2026-09-30T09:01:00Z", kind: "AUTHORITY", title: "Mandate V7 activated", description: "Bounded research mandate loaded for Buyer Agent 07.", status: "SUCCESS", objectRef: "mandate_research_v7", metadata: { budget: 50, maxTransaction: 15, policyVersion: "policy-v3.4" } },
  { eventId: "evt_501_02", runId: "run_501", at: "2026-09-30T09:02:00Z", kind: "SYSTEM", title: "Intent created", description: "Research objective normalized into Mitra intent intent_501.", status: "INFO", objectRef: "intent_501", metadata: { budget: 50, asset: "USDC" } },
  { eventId: "evt_501_03", runId: "run_501", at: "2026-09-30T09:03:00Z", kind: "DISCOVERY", title: "Provider discovered via Virtuals", description: "Provider passed capability, price, chain, and counterparty normalization.", status: "SUCCESS", objectRef: "virtuals:provider:research-09", metadata: { marketplace: "Virtuals", quote: 12 } },
  { eventId: "evt_501_04", runId: "run_501", at: "2026-09-30T09:04:00Z", kind: "VAULT", title: "$12.00 reservation created", description: "Vault capital moved from available to reserved before economic commitment.", status: "SUCCESS", objectRef: "res_run501", metadata: { amount: 12, availableAfter: 91228 } },
  { eventId: "evt_501_05", runId: "run_501", at: "2026-09-30T09:04:15Z", kind: "AUTHORITY", title: "Policy evaluation: ALLOW", description: "Authorization is bound to mandate V7, vault, recipient, amount ceiling, nonce, expiry, and exact action digest.", status: "SUCCESS", receiptId: "receipt_auth_501", objectRef: "auth_501", metadata: { decision: "ALLOW", mandateVersion: 7, nonce: 201 } },
  { eventId: "evt_501_06", runId: "run_501", at: "2026-09-30T09:05:00Z", kind: "COMMERCE", title: "Agreement funded", description: "Commercial agreement entered funded state; reservation committed to execution path.", status: "SUCCESS", objectRef: "agreement_77", metadata: { escrow: "escrow_55", provider: "virtuals:research-provider-09" } },
  { eventId: "evt_501_07", runId: "run_501", at: "2026-09-30T09:06:00Z", kind: "COMMERCE", title: "A2A task started", description: "External task mapped to Mitra intent and agreement without losing marketplace identity.", status: "INFO", objectRef: "a2a:task-501", metadata: { state: "working" } },
  { eventId: "evt_501_08", runId: "run_501", at: "2026-09-30T09:08:00Z", kind: "PAYMENT", title: "x402 service paid $0.40", description: "Paid-resource request consumed the active bounded payment session.", status: "SUCCESS", objectRef: "x402:payment-501-1", metadata: { amount: 0.4, asset: "USDC" } },
  { eventId: "evt_501_09", runId: "run_501", at: "2026-09-30T09:10:00Z", kind: "RECOVERY", title: "Provider timeout detected", description: "Primary provider missed the committed heartbeat and entered failure state.", status: "FAILURE", objectRef: "saga_501:s1", metadata: { reason: "PROVIDER_TIMEOUT", elapsedSeconds: 300 } },
  { eventId: "evt_501_10", runId: "run_501", at: "2026-09-30T09:10:05Z", kind: "RECOVERY", title: "TALOS recovery activated", description: "Committed recovery policy selected reassignment and preserved the existing capital boundary.", status: "WARNING", objectRef: "saga_501", metadata: { route: "REASSIGN_APPROVED_PROVIDER" } },
  { eventId: "evt_501_11", runId: "run_501", at: "2026-09-30T09:11:00Z", kind: "DISCOVERY", title: "Backup provider selected", description: "Approved backup provider matched the same capability and mandate constraints.", status: "SUCCESS", objectRef: "mech-research-backup-04", metadata: { source: "Olas", reassignment: true } },
  { eventId: "evt_501_12", runId: "run_501", at: "2026-09-30T09:16:00Z", kind: "COMMERCE", title: "Deliverable accepted", description: "Evaluator validated structured output and evidence; commercial acceptance finalized.", status: "SUCCESS", receiptId: "receipt_recovery_501", objectRef: "deliverable_501", metadata: { accepted: true, artifacts: 2 } },
  { eventId: "evt_501_13", runId: "run_501", at: "2026-09-30T09:20:00Z", kind: "CLEARING", title: "Clearing epoch 042 finalized", description: "Reciprocal obligations were netted; only the residual settlement vector remains.", status: "SUCCESS", receiptId: "receipt_clear_042", objectRef: "epoch_042", metadata: { gross: 22.4, residual: 7.2, reductionPct: 67.9 } },
  { eventId: "evt_501_14", runId: "run_501", at: "2026-09-30T09:21:00Z", kind: "SETTLEMENT", title: "USDC settlement confirmed", description: "Residual transfer confirmed and bound to epoch 042 and the exact cleared obligation set.", status: "SUCCESS", receiptId: "receipt_set_913", objectRef: "set_913", metadata: { amount: 7.2, chain: "solana", evidenceLevel: "LOCAL_PASS" } },

  { eventId: "evt_498_01", runId: "run_498", at: "2026-09-30T12:08:00Z", kind: "SYSTEM", title: "Intent created", description: "Market data acquisition intent created.", status: "INFO", objectRef: "intent_498", metadata: { budget: 40 } },
  { eventId: "evt_498_02", runId: "run_498", at: "2026-09-30T12:09:00Z", kind: "VAULT", title: "$25.20 session ceiling reserved", description: "Metered service bounded by explicit reservation.", status: "SUCCESS", objectRef: "res_run498", metadata: { amount: 25.2 } },
  { eventId: "evt_498_03", runId: "run_498", at: "2026-09-30T12:09:10Z", kind: "AUTHORITY", title: "Policy evaluation: ALLOW", description: "Counterparty and velocity rules passed.", status: "SUCCESS", objectRef: "auth_498", metadata: { decision: "ALLOW" } },
  { eventId: "evt_498_04", runId: "run_498", at: "2026-09-30T16:44:00Z", kind: "PAYMENT", title: "Metered session active", description: "9.60 USDC consumed from a 25.20 USDC ceiling.", status: "INFO", objectRef: "agreement_75", metadata: { consumed: 9.6, ceiling: 25.2 } },

  { eventId: "evt_496_01", runId: "run_496", at: "2026-09-30T15:04:00Z", kind: "SYSTEM", title: "Intent created", description: "Competitor coverage run created.", status: "INFO", objectRef: "intent_496", metadata: { budget: 20 } },
  { eventId: "evt_496_02", runId: "run_496", at: "2026-09-30T16:48:00Z", kind: "RECOVERY", title: "Provider rate limited", description: "Upstream rate limit exceeded provider SLA.", status: "FAILURE", objectRef: "saga_496:s1", metadata: { reason: "UPSTREAM_RATE_LIMIT" } },
  { eventId: "evt_496_03", runId: "run_496", at: "2026-09-30T16:50:00Z", kind: "RECOVERY", title: "Reassignment in progress", description: "Recovery keeper is selecting an approved backup provider.", status: "WARNING", objectRef: "saga_496:s2", metadata: { route: "REASSIGN_APPROVED_PROVIDER" } },

  { eventId: "evt_492_01", runId: "run_492", at: "2026-09-30T13:22:00Z", kind: "SYSTEM", title: "Intent created", description: "Bounded Base yield evaluation requested.", status: "INFO", objectRef: "intent_492", metadata: { budget: 100 } },
  { eventId: "evt_492_02", runId: "run_492", at: "2026-09-30T13:23:00Z", kind: "VAULT", title: "$100.00 reserved", description: "Base smart-account vault reserved capital.", status: "SUCCESS", objectRef: "res_run492", metadata: { amount: 100 } },
  { eventId: "evt_492_03", runId: "run_492", at: "2026-09-30T13:24:00Z", kind: "COMMERCE", title: "ERC-8183-compatible job funded", description: "Job awaiting provider deliverable.", status: "INFO", objectRef: "agreement_72", metadata: { state: "FUNDED" } },
];

export const integrations: Integration[] = [
  { integrationId: "int_solana", name: "Solana", category: "CHAIN", version: "adapter-v0.1", network: "devnet", evidenceLevel: "LOCAL_PASS", status: "HEALTHY", description: "Primary vault, settlement and receipt-anchor target.", lastCheckedAt: "2026-09-30T16:58:00Z", knownLimitation: "This repository does not contain deployed program IDs or signer credentials.", testCommand: "npm test -- solana" },
  { integrationId: "int_base", name: "Base", category: "CHAIN", version: "adapter-v0.1", network: "sepolia", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "ERC-8004 identity, ERC-8183 commerce and EVM settlement adapter boundary.", lastCheckedAt: "2026-09-30T16:58:00Z", knownLimitation: "No live smart account or testnet transaction is bundled." },
  { integrationId: "int_tempo", name: "Tempo", category: "CHAIN", version: "adapter-v0.1", network: "testnet", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "Payment-specialized settlement adapter boundary.", lastCheckedAt: "2026-09-30T16:58:00Z", knownLimitation: "Settlement adapter is interface-only in this build." },
  { integrationId: "int_virtuals", name: "Virtuals", category: "MARKETPLACE", version: "adapter-v0.1", network: "external", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "Provider discovery, offering normalization, job mapping and external identity preservation.", lastCheckedAt: "2026-09-30T16:58:00Z", knownLimitation: "Seeded provider data is representative, not a live marketplace call." },
  { integrationId: "int_a2a", name: "A2A", category: "PROTOCOL", version: "adapter-v0.1", network: "http", evidenceLevel: "LOCAL_PASS", status: "HEALTHY", description: "Task and artifact lifecycle mapping into the Mitra economic state graph.", lastCheckedAt: "2026-09-30T16:58:00Z", testCommand: "npm test -- adapters" },
  { integrationId: "int_mcp", name: "MCP", category: "PROTOCOL", version: "server-v0.1", network: "local", evidenceLevel: "LOCAL_PASS", status: "HEALTHY", description: "Agent-facing control surface with authority-bound mutation model.", lastCheckedAt: "2026-09-30T16:58:00Z", testCommand: "npm test -- adapters" },
  { integrationId: "int_x402", name: "x402", category: "PAYMENT", version: "adapter-v0.1", network: "http", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "Paid-resource adapter constrained by reservation or session ceiling.", lastCheckedAt: "2026-09-30T16:58:00Z", knownLimitation: "No facilitator or payment signer credentials are configured." },
  { integrationId: "int_mpp", name: "MPP", category: "PAYMENT", version: "adapter-v0.1", network: "http", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "One-time and metered machine payment adapter boundary.", lastCheckedAt: "2026-09-30T16:58:00Z" },
  { integrationId: "int_arcium", name: "Arcium", category: "PRIVACY", version: "policy-v0.1", network: "solana", evidenceLevel: "DESIGN_ONLY", status: "NOT_CONFIGURED", description: "Optional confidential policy evaluation; never the sole source of fund movement authority.", lastCheckedAt: "2026-09-30T16:58:00Z" },
];

export const evidence: EvidenceRecord[] = [
  { evidenceId: "ev_core_001", integration: "Core economic lifecycle", level: "LOCAL_PASS", network: "local", commit: "WORKTREE", testCommand: "npm test", knownLimitation: "Local deterministic kernel only; not audited production custody.", recordedAt: "2026-09-30T17:00:00Z" },
  { evidenceId: "ev_solana_001", integration: "Solana vault adapter", level: "DESIGN_ONLY", network: "devnet", commit: "WORKTREE", testCommand: "npm test -- solana", vaultAddress: "8J8dPqRr4Xo1g7Vf2Z3mQxN6AqB1sY7kP9LdE4Mitra", knownLimitation: "Address is representative; no deployed program is claimed.", recordedAt: "2026-09-30T17:00:00Z" },
  { evidenceId: "ev_clear_042", integration: "Clearing engine", level: "LOCAL_PASS", network: "local", commit: "WORKTREE", testCommand: "npm test -- clearing", reservationId: "res_run501", authorizationId: "auth_501", knownLimitation: "Centralized deterministic calculator; not decentralized clearing.", recordedAt: "2026-09-30T17:00:00Z" },
  { evidenceId: "ev_base_001", integration: "Base adapter", level: "DESIGN_ONLY", network: "sepolia", commit: "WORKTREE", testCommand: "npm test -- adapters", knownLimitation: "No live ERC-8183 or settlement transaction included.", recordedAt: "2026-09-30T17:00:00Z" },
];
