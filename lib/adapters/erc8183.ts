/**
 * ERC-8183 projection (PRD §13.2, PK1).
 *
 * Maps an ERC-8183 job onto Mitra's commercial model. This is a PROJECTION, not
 * a re-implementation: ERC-8183 stays the external marketplace's vocabulary, and
 * Mitra never becomes the authority on someone else's protocol (see `SpaceRules`).
 *
 * ## A correction to the original mapping table
 *
 * The task brief specified:
 *     Open -> PROPOSED, Submitted -> DELIVERED, Rejected -> TERMINAL_REJECTED
 *
 * **None of `PROPOSED`, `DELIVERED` or `TERMINAL_REJECTED` exist in Mitra.**
 * `AgreementStatus` is a closed union:
 *     OPEN | FUNDED | EXECUTING | SUBMITTED | ACCEPTED | REJECTED | REFUNDED
 *     | CANCELED | EXPIRED
 * (Those three names are ObligationStatus values — PROPOSED and DISPUTED are;
 * TERMINAL_REJECTED is not even that.)
 *
 * Transcribing the table literally would have compiled only if AgreementStatus
 * were widened to admit states no transition can ever produce, which would make
 * the projection lossy in a way no type error would catch. The table below maps
 * onto the statuses the kernel can actually reach, and the test suite pins every
 * row so a future widening has to be deliberate.
 */
import type { Agreement, AgreementStatus, Money, Space } from "@/lib/domain/types";

export type ERC8183JobStatus = "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";

/** ERC-8183 actors. Kept distinct: conflating provider and evaluator is how a
 *  job ends up self-evaluated by the party being paid. */
export interface ERC8183Actors {
  client: string;
  provider: string;
  evaluator?: string;
  escrow?: string;
}

export interface ERC8183Job {
  jobId: string;
  chain: string;
  asset: Money["asset"];
  price: Money;
  status: ERC8183JobStatus;
  actors: ERC8183Actors;
  /** ISO-8601, matching `Agreement.deadline`. ERC-8183 on-chain deadlines are
   *  unix seconds, but the conversion belongs at the transport boundary, not
   *  here — silently mixing the two is how a deadline ends up in 1970. */
  deadline: string;
  /** Opaque marketplace payload; Mitra does not interpret it. */
  metadataRef?: string;
}

/** The forward direction is total; the inverse is partial, and that is honest. */
export const ERC8183_TO_AGREEMENT: Record<ERC8183JobStatus, AgreementStatus> = {
  Open: "OPEN",
  Funded: "FUNDED",
  Submitted: "SUBMITTED",
  Completed: "ACCEPTED",
  Rejected: "REJECTED",
  Expired: "EXPIRED",
};

export const AGREEMENT_TO_ERC8183: Record<AgreementStatus, ERC8183JobStatus> = {
  OPEN: "Open",
  FUNDED: "Funded",
  SUBMITTED: "Submitted",
  ACCEPTED: "Completed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  // No ERC-8183 state is equivalent. These are Mitra-side terminal states that
  // an external marketplace has no vocabulary for, so they are projected to
  // `Rejected` and flagged by `isLossyProjection` rather than silently widened.
  EXECUTING: "Open",
  REFUNDED: "Rejected",
  CANCELED: "Rejected",
};

export interface AgreementDraft {
  agreementId: string;
  spaceId: string;
  client: string;
  provider: string;
  price: Money;
  payTo?: { chain: string; account: string };
  status: AgreementStatus;
}

/** True when the agreement carries state ERC-8183 cannot express. */
export function isLossyProjection(status: AgreementStatus): boolean {
  return ["EXECUTING", "REFUNDED", "CANCELED"].includes(status);
}

export function erc8183ToAgreement(job: ERC8183Job, spaceId: string): AgreementDraft {
  return {
    agreementId: `erc8183:${job.jobId}`,
    spaceId,
    client: job.actors.client,
    provider: job.actors.provider,
    price: job.price,
    // A job that settles on a chain is a term like any other: the Space's
    // settlementChains list must admit it, or containment is decorative.
    payTo: { chain: job.chain, account: job.actors.provider },
    status: ERC8183_TO_AGREEMENT[job.status],
  };
}

export function agreementToERC8183(agreement: Agreement, space: Space, jobId: string): ERC8183Job {
  const status = AGREEMENT_TO_ERC8183[agreement.status];
  return {
    jobId,
    chain: agreement.payTo?.chain ?? space.settlementChains[0] ?? "solana",
    asset: agreement.price.asset,
    price: agreement.price,
    status,
    actors: {
      client: agreement.client,
      provider: agreement.provider,
      ...(agreement.evaluator ? { evaluator: agreement.evaluator } : {}),
      ...(agreement.escrowRef ? { escrow: agreement.escrowRef } : {}),
    },
    deadline: agreement.deadline,
  };
}
