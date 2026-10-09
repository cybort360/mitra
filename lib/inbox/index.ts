/**
 * The agent inbox (PP-6): what an agent can act on now, addressed to its id.
 *
 * Derived on every read from the agreements and settlements in the store; it
 * keeps no state of its own, so it cannot drift from them. An item's `actions`
 * come from the kernel's own rules, the state machine's next ops filtered by
 * `mayInstruct`, so the inbox never offers an op the API would refuse on role.
 *
 * Kinds:
 *  - WORK_REQUIRED: the agent is the provider and the next op is its own:
 *    `startExecution` from FUNDED, `submitDeliverable` from EXECUTING.
 *  - EVALUATION_REQUIRED: a deliverable is SUBMITTED and the agent may accept or
 *    reject it. The client may as well as the evaluator (AGREEMENT_OP_ROLES), so
 *    both see it.
 *  - INBOUND_PROPOSAL: the agent is the provider of an OPEN agreement. For
 *    information: only the client can move it (`fund`), so it carries no action.
 *  - SETTLEMENT_RECEIPT: a CONFIRMED settlement paying the agent, either for an
 *    agreement it provided or to one of its registered wallets (a clearing
 *    residual has no agreement).
 *
 * `refund` is never an inbox action. It is open to the client or evaluator from
 * most non-terminal states, so listing it would put every funded agreement in
 * their inbox; it is a recovery decision, not a pending piece of work.
 *
 * Order: actionable items first, soonest deadline first; then proposals by
 * deadline; then receipts, newest first. Ties break on id, so the order is stable.
 */

import { availableAgreementOps, mayInstruct, type AgreementOp } from "@/lib/kernel/commerce";
import type { Agent, Agreement, AgreementStatus, AssetSymbol, Chain, Money, Settlement } from "@/lib/domain/types";

export const INBOX_KINDS = ["WORK_REQUIRED", "EVALUATION_REQUIRED", "INBOUND_PROPOSAL", "SETTLEMENT_RECEIPT"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const isInboxKind = (k: string): k is InboxKind => (INBOX_KINDS as readonly string[]).includes(k);

export type InboxRole = "client" | "provider" | "evaluator";

export interface InboxAgreementItem {
  kind: Exclude<InboxKind, "SETTLEMENT_RECEIPT">;
  /** 0 = the agent can act now; 1 = for information. */
  priority: 0 | 1;
  agreementId: string;
  runId: string;
  spaceIds: string[];
  status: AgreementStatus;
  role: InboxRole;
  /** The ops this agent may instruct from here. Empty for a proposal. */
  actions: AgreementOp[];
  client: string;
  price: Money;
  deadline: string;
  /** The deadline has passed. Late work fails the agreement's terms; the API does not yet refuse it (F94). */
  overdue: boolean;
  acceptanceCriteria: string[];
}

export interface InboxReceiptItem {
  kind: "SETTLEMENT_RECEIPT";
  priority: 2;
  settlementId: string;
  agreementId?: string;
  epochId?: string;
  amount: number;
  asset: AssetSymbol;
  chain: Chain;
  to: string;
  txHash?: string;
  receiptId?: string;
  at: string;
}

export type InboxItem = InboxAgreementItem | InboxReceiptItem;

export interface Inbox {
  agentId: string;
  items: InboxItem[];
  counts: Record<InboxKind, number>;
}

/** How many receipts an inbox carries, newest first. */
export const RECEIPT_LIMIT = 20;

export function buildInbox(input: {
  agent: Pick<Agent, "agentId" | "wallets">;
  agreements: Agreement[];
  settlements: Settlement[];
  now: Date;
  kinds?: readonly InboxKind[];
}): Inbox {
  const { agent, now } = input;
  const id = agent.agentId;
  const want = new Set<InboxKind>(input.kinds?.length ? input.kinds : INBOX_KINDS);

  const work: InboxAgreementItem[] = [];
  for (const a of input.agreements) {
    const item = agreementItem(a, id, now);
    if (item && want.has(item.kind)) work.push(item);
  }
  work.sort((x, y) => x.priority - y.priority || x.deadline.localeCompare(y.deadline) || x.agreementId.localeCompare(y.agreementId));

  const receipts: InboxReceiptItem[] = [];
  if (want.has("SETTLEMENT_RECEIPT")) {
    const provided = new Set(input.agreements.filter((a) => a.provider === id).map((a) => a.agreementId));
    const wallets = new Set(agent.wallets.map((w) => w.address.toLowerCase()));
    for (const s of input.settlements) {
      if (s.status !== "CONFIRMED") continue;
      const paysAgent = (s.agreementId !== undefined && provided.has(s.agreementId)) || wallets.has(s.to.toLowerCase());
      if (paysAgent) receipts.push(receiptItem(s));
    }
    receipts.sort((x, y) => y.at.localeCompare(x.at) || x.settlementId.localeCompare(y.settlementId));
    receipts.splice(RECEIPT_LIMIT);
  }

  const items: InboxItem[] = [...work, ...receipts];
  const counts = Object.fromEntries(INBOX_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<InboxKind, number>;
  return { agentId: id, items, counts };
}

function agreementItem(a: Agreement, agentId: string, now: Date): InboxAgreementItem | null {
  const role = roleOf(a, agentId);
  if (!role) return null;
  const actions = availableAgreementOps(a.status).filter((op) => op !== "refund" && mayInstruct(a, op, agentId));

  let kind: InboxAgreementItem["kind"] | null = null;
  if (a.status === "OPEN" && a.provider === agentId) kind = "INBOUND_PROPOSAL";
  else if ((a.status === "FUNDED" || a.status === "EXECUTING") && actions.length) kind = "WORK_REQUIRED";
  else if (a.status === "SUBMITTED" && actions.length) kind = "EVALUATION_REQUIRED";
  if (!kind) return null;

  return {
    kind, priority: kind === "INBOUND_PROPOSAL" ? 1 : 0,
    agreementId: a.agreementId, runId: a.runId, spaceIds: a.spaceIds, status: a.status,
    role: kind === "INBOUND_PROPOSAL" ? "provider" : role,
    actions: kind === "INBOUND_PROPOSAL" ? [] : actions,
    client: a.client, price: a.price, deadline: a.deadline,
    overdue: now > new Date(a.deadline),
    acceptanceCriteria: a.acceptanceCriteria,
  };
}

/** The role that governs this agent's next move. An agent can hold two; the acting one wins. */
function roleOf(a: Agreement, agentId: string): InboxRole | null {
  if (a.status === "SUBMITTED" && a.evaluator === agentId) return "evaluator";
  if (a.provider === agentId) return "provider";
  if (a.client === agentId) return "client";
  if (a.evaluator === agentId) return "evaluator";
  return null;
}

function receiptItem(s: Settlement): InboxReceiptItem {
  return {
    kind: "SETTLEMENT_RECEIPT", priority: 2, settlementId: s.settlementId,
    agreementId: s.agreementId, epochId: s.epochId, amount: s.amount, asset: s.asset, chain: s.chain, to: s.to,
    txHash: s.txHash, receiptId: s.receiptId, at: s.confirmedAt ?? s.submittedAt,
  };
}
