/**
 * ERC-8183 — agentic commerce jobs (PRD Phase 4 "Integrate ERC-8183
 * compatibility on Base", and Phase 8 "ERC-8183-compatible commerce").
 *
 * The standard defines Client / Provider / Evaluator / Escrow with a lifecycle.
 * The temptation is to model it as a second commerce system beside Mitra's
 * `Agreement`. That would mean two lifecycles that disagree, and every
 * cross-standard question ("what is our ERC-8183 state?") would need a mapping.
 *
 * **Instead this is a projection.** `toErc8183Job` derives the standard's view
 * from Mitra's own Agreement/Deliverable, and `fromErc8183Job` is the only
 * inbound edge. One lifecycle, two vocabularies — which is what "compatible"
 * should mean, and what the marketplace-interoperable positioning (§3.3) requires.
 *
 * The escrow mapping is the load-bearing part. ERC-8183 escrow is a *held
 * balance*; Mitra's is a `Reservation` against a vault position. They are not
 * the same object, and the projection records the Mitra reservation that backs a
 * given escrow so the linkage is auditable rather than assumed.
 */

import type { Agreement, Deliverable, Reservation } from "@/lib/domain/types";

export type Erc8183JobState =
  | "Open"
  | "Funded"
  | "InProgress"
  | "Submitted"
  | "Accepted"
  | "Rejected"
  | "Refunded"
  | "Canceled"
  | "Expired";

/** The mapping, in one place, so it can be tested as data. */
export const AGREEMENT_TO_JOB_STATE: Record<Agreement["status"], Erc8183JobState> = {
  OPEN: "Open",
  FUNDED: "Funded",
  EXECUTING: "InProgress",
  SUBMITTED: "Submitted",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  REFUNDED: "Refunded",
  CANCELED: "Canceled",
  EXPIRED: "Expired",
};

export const JOB_STATE_TO_AGREEMENT: Record<Erc8183JobState, Agreement["status"]> = {
  Open: "OPEN",
  Funded: "FUNDED",
  InProgress: "EXECUTING",
  Submitted: "SUBMITTED",
  Accepted: "ACCEPTED",
  Rejected: "REJECTED",
  Refunded: "REFUNDED",
  Canceled: "CANCELED",
  Expired: "EXPIRED",
};

export interface Erc8183Job {
  jobId: string;
  client: string;
  provider: string;
  evaluator?: string;
  /** The Mitra reservation backing this job's escrow. Not optional by accident. */
  escrowReservationId: string;
  escrowAmount: number;
  asset: string;
  state: Erc8183JobState;
  criteria: string[];
  deadline: string;
  /** Version of the projection, so a consumer can detect Mitra-side changes. */
  projectionVersion: 1;
}

export type ProjectionResult =
  | { ok: true; job: Erc8183Job }
  | { ok: false; reason: string };

/**
 * Projects a Mitra agreement into an ERC-8183 job.
 *
 * Refuses rather than emitting a partial job when the escrow linkage is absent.
 * An ERC-8183 consumer treats escrow as held funds; a job with no reservation
 * behind it would present an unfunded commitment as funded, which is the exact
 * confusion the projection exists to prevent.
 */
export function toErc8183Job(
  agreement: Agreement,
  escrow: Reservation | null,
): ProjectionResult {
  if (!escrow) return { ok: false, reason: "ERC8183_ESCROW_UNBACKED" };
  if (escrow.agreementId !== agreement.agreementId) {
    return { ok: false, reason: "ERC8183_ESCROW_AGREEMENT_MISMATCH" };
  }
  if (escrow.amount < agreement.price.amount) {
    return { ok: false, reason: "ERC8183_ESCROW_UNDERFUNDED" };
  }
  if (!agreement.evaluator) return { ok: false, reason: "ERC8183_EVALUATOR_REQUIRED" };
  return {
    ok: true,
    job: {
      jobId: agreement.agreementId,
      client: agreement.client,
      provider: agreement.provider,
      evaluator: agreement.evaluator,
      escrowReservationId: escrow.reservationId,
      escrowAmount: escrow.amount,
      asset: agreement.price.asset,
      state: AGREEMENT_TO_JOB_STATE[agreement.status],
      criteria: agreement.acceptanceCriteria,
      deadline: agreement.deadline,
      projectionVersion: 1,
    },
  };
}

/** The single inbound edge. An unknown job state is refused, never guessed. */
export function fromErc8183State(state: Erc8183JobState): Agreement["status"] | null {
  return JOB_STATE_TO_AGREEMENT[state] ?? null;
}

/**
 * Whether a deliverable satisfies the job's criteria.
 *
 * ERC-8183 separates submission from acceptance via the evaluator. This keeps the
 * same split: `submitted` is not `accepted`, and the acceptance decision stays
 * with the evaluator rather than with whoever submits.
 */
export function evaluateJobSubmission(
  job: Erc8183Job,
  deliverable: Deliverable,
  accepted: boolean,
): { ok: boolean; reason?: string } {
  if (job.state !== "Submitted") return { ok: false, reason: "JOB_NOT_SUBMITTED" };
  if (deliverable.agreementId !== job.jobId) return { ok: false, reason: "WRONG_AGREEMENT" };
  if (accepted && !deliverable.artifactRefs.length) return { ok: false, reason: "ACCEPTED_WITHOUT_ARTIFACT" };
  if (deliverable.contentHash === "") return { ok: false, reason: "DELIVERABLE_EMPTY" };
  return { ok: true };
}
