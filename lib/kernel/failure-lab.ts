export type FailureScenario = "OVERSPEND" | "UNAUTHORIZED_PROVIDER" | "EXPIRED_MANDATE" | "PROVIDER_TIMEOUT" | "BAD_DELIVERABLE" | "DUPLICATE_SETTLEMENT" | "ACTION_TAMPER" | "WRONG_CHAIN";

export const failureScenarios: Record<FailureScenario, { title: string; expected: string; reasonCode: string }> = {
  OVERSPEND: { title: "Overspend", expected: "Denied before reservation", reasonCode: "INSUFFICIENT_AVAILABLE_CAPITAL" },
  UNAUTHORIZED_PROVIDER: { title: "Unauthorized provider", expected: "Policy DENY", reasonCode: "COUNTERPARTY_NOT_ALLOWED" },
  EXPIRED_MANDATE: { title: "Expired mandate", expected: "Policy DENY", reasonCode: "MANDATE_EXPIRED" },
  PROVIDER_TIMEOUT: { title: "Provider timeout", expected: "Saga enters RECOVERY_PENDING", reasonCode: "PROVIDER_TIMEOUT" },
  BAD_DELIVERABLE: { title: "Bad deliverable", expected: "Reject; funds remain protected", reasonCode: "ACCEPTANCE_FAILED" },
  DUPLICATE_SETTLEMENT: { title: "Duplicate settlement", expected: "Rejected by idempotency boundary", reasonCode: "ALREADY_SETTLED" },
  ACTION_TAMPER: { title: "Action tamper", expected: "Execution guard rejects digest mismatch", reasonCode: "ACTION_DIGEST_MISMATCH" },
  WRONG_CHAIN: { title: "Wrong-chain settlement", expected: "Settlement adapter rejects", reasonCode: "CHAIN_MISMATCH" },
};
