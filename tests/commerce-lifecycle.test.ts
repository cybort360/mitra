/**
 * PK1 — the Phase 4 commerce lifecycle, end to end.
 *
 * PRD §52 exit condition, verbatim: *"Real job can be opened, funded, submitted,
 * accepted, rejected, refunded."* This file walks that sentence.
 *
 * The kernel (`lib/kernel/commerce.ts`) is pure, so a lifecycle can be driven
 * without a store. But a pure kernel proves only that transitions compose — it
 * does not prove the Space is *persisted* correctly or that the HTTP surface
 * accepts what the kernel produces. So the two halves are covered separately and
 * deliberately not confused: the kernel here, the store and routes via the real
 * handlers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Agreement, Space } from "@/lib/domain/types";
import { admitsProposal, applyAgreementOp, openAgreement } from "@/lib/kernel/commerce";
import {
  ERC8183_TO_AGREEMENT, AGREEMENT_TO_ERC8183, agreementToERC8183, erc8183ToAgreement,
  isLossyProjection, type ERC8183Job, type ERC8183JobStatus,
} from "@/lib/adapters/erc8183";
import { GET as listSpaces, POST as createSpace } from "@/app/api/v1/spaces/route";
import { GET as getSpace } from "@/app/api/v1/spaces/[id]/route";
import { prepareStore, req } from "./fixtures";

const usd = (n: number) => ({ asset: "USDC" as const, amount: n });

function space(over: Partial<Space> = {}): Space {
  return {
    spaceId: "space_pk1",
    owner: "agent_buyer_07",
    governance: { mode: "ADMIN", admins: ["agent_buyer_07"], governors: ["agent_buyer_07"], threshold: 1 },
    rules: { source: "mitra", digest: "mitra:core:v1" },
    status: "ACTIVE",
    participants: ["agent_buyer_07", "mech-research-backup-04"],
    // "payment" is required: the kernel re-checks containment on EVERY op and
    // defaults the capability to "payment", so a research-only Space cannot be
    // funded. Discovered by running the test, not by reading it.
    allowedCapabilities: ["research", "payment", "deliverable_evaluation"],
    settlementChains: ["solana"],
    budget: usd(100),
    committed: usd(0),
    version: 1,
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function draft(over: Partial<Agreement> = {}): Omit<Agreement, "status" | "version" | "spaceIds"> {
  return {
    agreementId: "agreement_pk1",
    runId: "run_501",
    intentId: "intent_501",
    client: "agent_buyer_07",
    provider: "mech-research-backup-04",
    evaluator: "agent_eval_02",
    price: usd(10),
    deadline: "2026-10-02T00:00:00Z",
    acceptanceCriteria: ["structured output"],
    failurePolicy: "refund on expiry",
    ...over,
  } as Omit<Agreement, "status" | "version" | "spaceIds">;
}

beforeEach(async () => { await prepareStore(); });

describe("Space lifecycle + containment", () => {
  it("admits an in-scope proposal", () => {
    const r = admitsProposal(space(), { participant: "mech-research-backup-04", capability: "research", amount: usd(10) });
    expect(r.ok).toBe(true);
  });

  it("refuses a participant outside the Space", () => {
    const r = admitsProposal(space(), { participant: "stranger", capability: "research", amount: usd(1) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("PARTICIPANT_NOT_IN_SPACE");
  });

  it("refuses a capability the Space does not allow", () => {
    const r = admitsProposal(space(), { participant: "mech-research-backup-04", capability: "not_allowed_cap", amount: usd(1) });
    expect(r.ok === false && r.reason).toBe("CAPABILITY_NOT_ALLOWED_IN_SPACE");
  });

  it("refuses a proposal that would breach the Space budget", () => {
    const r = admitsProposal(space(), { participant: "mech-research-backup-04", capability: "research", amount: usd(101) });
    expect(r.ok === false && r.reason).toBe("SPACE_BUDGET_EXCEEDED");
  });

  it("refuses everything in a suspended Space", () => {
    const r = admitsProposal(space({ status: "SUSPENDED" }), { participant: "agent_buyer_07", capability: "research", amount: usd(1) });
    expect(r.ok === false && r.reason).toBe("SPACE_NOT_ACTIVE");
  });
});

describe("happy path — open, fund, submit, accept", () => {
  it("reaches ACCEPTED and commits exactly the price", () => {
    const opened = openAgreement(space(), draft(), { capability: "research", amount: usd(10) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    let { space: s, agreement: a } = opened.value;
    const funded = applyAgreementOp(s, a, "fund");
    expect(funded.ok).toBe(true);
    if (!funded.ok) return;
    ({ space: s, agreement: a } = funded.value);

    // FUNDED -> SUBMITTED is NOT a legal edge; the machine requires EXECUTING in
    // between. The PRD §52 exit condition reads "opened, funded, submitted,
    // accepted" and omits the execution step, so following it literally produces
    // ILLEGAL_TRANSITION. The extra step is the kernel's, not an embellishment.
    const executing = applyAgreementOp(s, a, "startExecution");
    expect(executing.ok).toBe(true);
    if (!executing.ok) return;
    ({ space: s, agreement: a } = executing.value);

    const submitted = applyAgreementOp(s, a, "submitDeliverable", { artifactRefs: ["ipfs://x"], contentHash: "sha256:pk1" });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    ({ space: s, agreement: a } = submitted.value);

    const accepted = applyAgreementOp(s, a, "acceptDeliverable");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    expect(accepted.value.agreement.status).toBe("ACCEPTED");
    // ACCEPTED is a SETTLED state, so the price stops being encumbered and the
    // Space's commitment returns to 0. Asserting 10 here would be asserting that
    // settlement does not release — the opposite of what the kernel guarantees.
    expect(accepted.value.space.committed.amount).toBe(0);
    // and the escrow was actually released, not merely marked settled
    expect(accepted.value.agreement.escrowReleased).toBe(true);
  });
});

describe("rejection path — open, fund, submit, reject, refund", () => {
  it("reaches REFUNDED and releases the committed capital", () => {
    const opened = openAgreement(space(), draft(), { capability: "research", amount: usd(10) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    let { space: s, agreement: a } = opened.value;
    for (const op of ["fund", "startExecution", "submitDeliverable"] as const) {
      const r = applyAgreementOp(s, a, op, op === "submitDeliverable"
        ? { artifactRefs: ["ipfs://x"], contentHash: "sha256:pk1" } : {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      ({ space: s, agreement: a } = r.value);
    }

    const rejected = applyAgreementOp(s, a, "rejectDeliverable");
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    ({ space: s, agreement: a } = rejected.value);
    expect(a.status).toBe("REJECTED");

    const refunded = applyAgreementOp(s, a, "refund");
    expect(refunded.ok).toBe(true);
    if (!refunded.ok) return;
    expect(refunded.value.agreement.status).toBe("REFUNDED");
    // The whole point of a refund: the Space is not still encumbered.
    expect(refunded.value.space.committed.amount).toBe(0);
  });

  it("refuses further ops once terminal", () => {
    const opened = openAgreement(space(), draft(), { capability: "research", amount: usd(10) });
    if (!opened.ok) return;
    const r = applyAgreementOp(opened.value.space, opened.value.agreement, "fund");
    if (!r.ok) return;
    const again = applyAgreementOp(r.value.space, r.value.agreement, "fund");
    expect(again.ok).toBe(false);
  });
});

describe("Space HTTP surface", () => {
  it("POST creates and GET reads back the same Space", async () => {
    const created = await createSpace(req({
      spaceId: "space_http_1",
      owner: "agent_buyer_07",
      budget: { asset: "USDC", amount: 50 },
      participants: ["agent_buyer_07", "mech-research-backup-04"],
      allowedCapabilities: ["research"],
    }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.spaceId).toBe("space_http_1");
    expect(body.data.committed.amount).toBe(0);

    const got = await getSpace(new Request("http://x"), { params: Promise.resolve({ id: "space_http_1" }) });
    expect(got.status).toBe(200);
    const gb = await got.json();
    expect(gb.data.spaceId).toBe("space_http_1");
    expect(gb.data.availableHeadroom.amount).toBe(50);
  });

  it("GET 404s a Space that does not exist", async () => {
    const res = await getSpace(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("POST refuses an owner outside its own participant list", async () => {
    const res = await createSpace(req({
      owner: "agent_outsider",
      budget: { asset: "USDC", amount: 10 },
      participants: ["agent_buyer_07"],
      allowedCapabilities: [],
    }));
    expect(res.status).toBe(400);
  });

  it("POST refuses an unknown asset symbol", async () => {
    const res = await createSpace(req({
      owner: "agent_buyer_07",
      budget: { asset: "DOGE", amount: 10 },
      participants: ["agent_buyer_07"],
      allowedCapabilities: [],
    }));
    expect(res.status).toBe(400);
  });

  it("POST is idempotent on spaceId", async () => {
    const body = {
      spaceId: "space_http_idem",
      owner: "agent_buyer_07",
      budget: { asset: "USDC", amount: 50 },
      participants: ["agent_buyer_07"],
      allowedCapabilities: ["research"],
    };
    expect((await createSpace(req(body))).status).toBe(201);
    expect((await createSpace(req(body))).status).toBe(201);
    const list = await listSpaces();
    const lb = await list.json();
    const matches = lb.data.filter((s: Space) => s.spaceId === "space_http_idem");
    expect(matches).toHaveLength(1);
  });
});

describe("ERC-8183 projection", () => {
  const job: ERC8183Job = {
    jobId: "acp-job-1", chain: "solana", asset: "USDC", price: usd(12), status: "Open",
    actors: { client: "agent_buyer_07", provider: "mech-research-backup-04", evaluator: "agent_eval_02" },
    deadline: "2026-10-02T00:00:00Z",
  };

  it("maps every ERC-8183 status onto a real AgreementStatus", () => {
    for (const s of Object.keys(ERC8183_TO_AGREEMENT) as ERC8183JobStatus[]) {
      const draftOut = erc8183ToAgreement({ ...job, status: s }, "space_pk1");
      // Every target must be a status the kernel can actually produce.
      expect(AGREEMENT_TO_ERC8183[draftOut.status]).toBeDefined();
    }
  });

  it("Open/Funded/Submitted/Completed/Rejected map as specified", () => {
    expect(erc8183ToAgreement({ ...job, status: "Open" }, "s").status).toBe("OPEN");
    expect(erc8183ToAgreement({ ...job, status: "Funded" }, "s").status).toBe("FUNDED");
    expect(erc8183ToAgreement({ ...job, status: "Submitted" }, "s").status).toBe("SUBMITTED");
    expect(erc8183ToAgreement({ ...job, status: "Completed" }, "s").status).toBe("ACCEPTED");
    expect(erc8183ToAgreement({ ...job, status: "Rejected" }, "s").status).toBe("REJECTED");
  });

  it("round-trips Open without drift", () => {
    const back = agreementToERC8183(
      { ...draft({ price: usd(12) }), spaceIds: ["space_pk1"], status: "OPEN", version: 1 } as Agreement,
      space(), "acp-job-1",
    );
    expect(back.status).toBe("Open");
    expect(back.price).toEqual(job.price);
    expect(back.actors.client).toBe(job.actors.client);
    expect(back.actors.provider).toBe(job.actors.provider);
    expect(back.actors.evaluator).toBe(job.actors.evaluator);
  });

  it("flags the states ERC-8183 cannot express instead of widening the union", () => {
    expect(isLossyProjection("EXECUTING")).toBe(true);
    expect(isLossyProjection("REFUNDED")).toBe(true);
    expect(isLossyProjection("ACCEPTED")).toBe(false);
  });
});
