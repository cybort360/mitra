import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/v1/agreements/route";
import { bindTestParties, prepareStore, signedTransition } from "./fixtures";
import { routeCommitment } from "@/lib/domain/canonical";
import { __setEscrowRailResolverForTests } from "@/lib/commerce/escrow-rail";
import { fakeEvmEscrowRail, asEvmRail } from "./fixtures";
import { escrowIdFor } from "@/lib/commerce/onchain-escrow";
import { onChainRefundRouteFor } from "@/lib/kernel/commerce-recovery";
import { getStore } from "@/lib/store/provider";

/** The on-chain provider. `agreement.provider` is a Mitra agent id, not an address. */
const PROVIDER_ADDRESS = "0x0000000000000000000000000000000000000001";

/**
 * A Space that can settle on `base` and has budget headroom.
 *
 * Not one of the seeds: `space_research_1` settles on solana only (so a `base` `payTo` is
 * refused with `SETTLEMENT_CHAIN_NOT_ALLOWED_IN_SPACE`) and `space_base_ops_1` settles on
 * base but is fully committed (so `SPACE_BUDGET_EXCEEDED`). Both are correct refusals, and
 * fighting them in a fixture would have hidden them.
 */
const ESCROW_SPACE_ID = "space_escrow_test";
async function ensureEscrowSpace(): Promise<void> {
  const { repo } = await getStore();
  await repo.createSpace?.({
    spaceId: ESCROW_SPACE_ID, owner: "agent_buyer_07",
    governance: { mode: "QUORUM", admins: [], governors: ["agent_buyer_07", "erc8183:provider-3", "agent_eval_02"], threshold: 2 },
    rules: { source: "external", ruleSetRef: "erc8183:job-lifecycle:v1", digest: "sha256:rules-8183-v1" },
    status: "ACTIVE",
    participants: ["agent_buyer_07", "erc8183:provider-3", "agent_eval_02"],
    // Both chains, so the escrow/payTo coherence guard is reachable rather than
    // pre-empted by SETTLEMENT_CHAIN_NOT_ALLOWED_IN_SPACE.
    allowedCapabilities: ["payment", "research"], settlementChains: ["base", "solana"],
    budget: { asset: "USDC", amount: 1000 }, committed: { asset: "USDC", amount: 0 },
    version: 1, createdAt: "2026-01-01T00:00:00Z",
  });
}

beforeEach(async () => {
  await prepareStore();
  await bindTestParties();
});

describe("Commercial Agreements API (Prometheus Vertical Agency Surface)", () => {
  it("GET /api/v1/agreements returns seeded agreements with availableOps", async () => {
    const res = await GET(new Request("http://localhost/api/v1/agreements"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty("availableOps");
    expect(body.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("GET /api/v1/agreements?spaceId= filters agreements by space", async () => {
    const res = await GET(new Request("http://localhost/api/v1/agreements?spaceId=space_research_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaceId).toBe("space_research_1");
    for (const a of body.data) {
      expect(a.spaceIds).toContain("space_research_1");
    }
  });

  it("POST /api/v1/agreements opens a new agreement, funds it, and drives recovery on rejection", async () => {
    // 1. OPEN agreement in space_research_1
    const openReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        op: "open",
        spaceId: "space_research_1",
        draft: {
          agreementId: "ag_prometheus_1",
          runId: "run_p1",
          intentId: "intent_p1",
          client: "agent_buyer_07",
          // F55: a party must be a registered agent to instruct a transition.
          provider: "agent_data_03",
          evaluator: "agent_eval_02",
          price: { asset: "USDC", amount: 15 },
          deadline: "2027-01-01T00:00:00Z",
          acceptanceCriteria: ["market research report verified"],
          failurePolicy: "refund on expiry",
        },
        proposal: {
          capability: "research",
          amount: { asset: "USDC", amount: 15 },
        },
      }),
    });

    const openRes = await POST(openReq);
    expect(openRes.status).toBe(201);
    const openBody = await openRes.json();
    expect(openBody.data.agreement.status).toBe("OPEN");
    expect(openBody.data.agreement.agreementId).toBe("ag_prometheus_1");
    expect(openBody.data.agreement.availableOps).toContain("fund");

    // 2. FUND agreement -> arms TALOS recovery saga
    const fundReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", {
        op: "fund",
        agreementId: "ag_prometheus_1",
      })),
    });

    const fundRes = await POST(fundReq);
    expect(fundRes.status).toBe(200);
    const fundBody = await fundRes.json();
    expect(fundBody.data.agreement.status).toBe("FUNDED");
    expect(fundBody.data.saga).toBeTruthy();
    expect(fundBody.data.saga.status).toBe("ARMED");
    expect(fundBody.data.space.committed.amount).toBeGreaterThanOrEqual(15);

    // 3. START EXECUTION -> saga advances to EXECUTING
    const execReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_data_03", "FUNDED", {
        op: "startExecution",
        agreementId: "ag_prometheus_1",
      })),
    });

    const execRes = await POST(execReq);
    expect(execRes.status).toBe(200);
    const execBody = await execRes.json();
    expect(execBody.data.agreement.status).toBe("EXECUTING");
    expect(execBody.data.saga.status).toBe("EXECUTING");

    // 4. SUBMIT DELIVERABLE
    const submitReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_data_03", "EXECUTING", {
        op: "submitDeliverable",
        agreementId: "ag_prometheus_1",
        artifactRefs: ["ipfs://bad-inference-model"],
        contentHash: "sha256:0123456789abcdef",
      })),
    });

    const submitRes = await POST(submitReq);
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(submitBody.data.agreement.status).toBe("SUBMITTED");

    // 5. REJECT DELIVERABLE -> triggers TALOS compensation & refunds locked escrow
    const committedBefore = submitBody.data.space.committed.amount;
    const rejectReq = new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_eval_02", "SUBMITTED", {
        op: "rejectDeliverable",
        agreementId: "ag_prometheus_1",
        failureReason: "POISONED_OUTPUT",
      })),
    });

    const rejectRes = await POST(rejectReq);
    expect(rejectRes.status).toBe(200);
    const rejectBody = await rejectRes.json();

    // Verify Invariant §4.5: Failure is a state transition, not an exception
    expect(rejectBody.data.agreement.status).toBe("REJECTED");
    expect(rejectBody.data.agreement.escrowReleased).toBe(true);
    expect(rejectBody.data.saga.status).toBe("RECOVERED");
    expect(rejectBody.data.saga.recoveredValue).toBe(15);
    // Headroom restored: committed drops by the agreement price
    expect(rejectBody.data.space.committed.amount).toBe(committedBefore - 15);
  });

  it("POST /api/v1/agreements rejects invalid requests with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/agreements", {
        method: "POST",
        body: JSON.stringify({ op: "invalid_op" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("POST /api/v1/agreements returns 404 for unknown agreement", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/agreements", {
        method: "POST",
        body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "non_existent_ag" })),
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("AGREEMENT_NOT_FOUND");
  });
});

/**
 * PRD §15.5 through the HTTP surface.
 *
 * The commitment is derived in the kernel, so this checks the thing a caller
 * actually depends on: that `fund` with an `onChainEscrow` hands back a non-zero
 * 32-byte commitment, and that it is the value over the refund route actually
 * committed. A `200` with `escrowRef` set and no commitment would mean the escrow
 * could be opened with a zero hash and refused on chain — a funded-looking
 * agreement whose capital is not actually escrowed.
 */
describe("§15.5 — funding an on-chain escrow commits its refund route", () => {
  beforeEach(async () => { await bindTestParties(); await ensureEscrowSpace(); });

  // DERIVED, not chosen: LP-6 refuses a caller-supplied jobId that is not the one this
  // agreement's §15.5 commitment covers, so the test must use the same narrowing.
  const jobId = escrowIdFor("ag_escrow_1");

  it("returns the commitment the escrow account must be opened with", async () => {
    const open = await POST(new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        op: "open",
        spaceId: ESCROW_SPACE_ID,
        draft: {
          agreementId: "ag_escrow_1", runId: "run_p1", intentId: "intent_1",
          client: "agent_buyer_07", provider: "agent_data_03", evaluator: "agent_eval_02",
          price: { asset: "USDC", amount: 15 },
          deadline: "2027-01-01T00:00:00Z",
          acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
          externalJobRefs: [],
          // The on-chain provider. `agreement.provider` is a Mitra agent id, not an
          // address, so an escrow has no party to name without this.
          payTo: { chain: "base", address: PROVIDER_ADDRESS },
        },
        proposal: { capability: "research", amount: { asset: "USDC", amount: 15 } },
      }),
    }));
    expect(open.status).toBe(201);

    const contractAddress = "0x6a731a654423d64afb9839742c3e48c6c54eea9c";
    // A rail, because LP-6 makes a requested escrow WITHOUT one a refusal rather than a
    // silent skip. The fake returns a real-shaped transaction hash; nothing in the bridge
    // invents one.
    __setEscrowRailResolverForTests(() => asEvmRail(fakeEvmEscrowRail()));
    const fund = await POST(new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", {
        op: "fund",
        agreementId: "ag_escrow_1",
        onChainEscrow: { chain: "baseSepolia", contractAddress, jobId, timeout: 1893456000 },
      })),
    }));
    __setEscrowRailResolverForTests(null);

    expect(fund.status, JSON.stringify(await fund.clone().json())).toBe(200);
    const body = await fund.json();
    expect(body.data.agreement.status).toBe("FUNDED");
    expect(body.data.agreement.escrowRef).toBe(jobId);
    expect(body.data.agreement.refundRouteHash).toBe(
      routeCommitment(`evm:refundEscrow:baseSepolia:${contractAddress}:${jobId}`),
    );
    expect(body.data.agreement.refundRouteHash).not.toBe(`0x${"0".repeat(64)}`);
  });
});

/**
 * LP-6 through the HTTP surface.
 *
 * The hermetic unit suite proves the bridge's rules; these prove the ROUTE obeys them,
 * which is a different claim. The route decides the ordering (chain before database), and
 * an ordering bug is invisible to a test that only exercises the bridge.
 */
describe("LP-6 — the agreement route drives real escrow, chain before database", () => {
  const contractAddress = "0x6a731a654423d64afb9839742c3e48c6c54eea9c";
  const NONCE = Math.random().toString(36).slice(2, 8);

  beforeEach(async () => { __setEscrowRailResolverForTests(null); await ensureEscrowSpace(); });

  const openAgreementVia = async (agreementId: string, payToChain: "base" | "solana" = "base") => {
    const res = await POST(new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        op: "open",
        spaceId: ESCROW_SPACE_ID,
        draft: {
          // A unique runId per agreement: `listEvents` filters by runId, so a shared
          // one would make the event assertions match another test's event.
          agreementId, runId: `run_lp6_${agreementId}`, intentId: "intent_1",
          client: "agent_buyer_07", provider: "erc8183:provider-3", evaluator: "agent_eval_02",
          price: { asset: "USDC", amount: 15 },
          deadline: "2027-01-01T00:00:00Z",
          acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
          externalJobRefs: [],
          // Required for an on-chain escrow: there is no party to name without it.
          payTo: { chain: payToChain, address: PROVIDER_ADDRESS },
        },
        proposal: { capability: "payment", amount: { asset: "USDC", amount: 15 } },
      }),
    }));
    const openBody = await res.clone().json();
    expect(res.status, JSON.stringify(openBody)).toBe(201);
  };

  // The signature is awaited by the CALLER (`signedTransition` signs asynchronously), which
  // is why this is `async` and why each use says `await fundWith(...)`.
  const fundWith = async (agreementId: string, jobId: string) =>
    POST(new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify(await signedTransition("agent_buyer_07", "OPEN", {
        op: "fund",
        agreementId,
        onChainEscrow: { chain: "baseSepolia", contractAddress, jobId, timeout: 1893456000 },
      })),
    }));

  it("REFUSES a requested escrow when no rail is configured", async () => {
    // The defect LP-6 removes: a 200 with `escrowRef` recorded and nothing escrowed, so
    // the agreement looks funded and the §15.5 commitment points at an account that does
    // not exist. Absence of a rail has to be an error, not a skip.
    const id = `ag_norail_${NONCE}`;
    await openAgreementVia(id);
    const res = await fundWith(id, escrowIdFor(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ESCROW_RAIL_NOT_CONFIGURED");
  });

  it("leaves the agreement OPEN when the escrow is refused", async () => {
    // A refusal must not half-apply. If the database advanced while the chain did not, the
    // next retry's probe would find no escrow and fund a second one.
    const id = `ag_refused_${NONCE}`;
    await openAgreementVia(id);
    await fundWith(id, escrowIdFor(id));
    const listed = await GET(new Request("http://localhost/api/v1/agreements"));
    const found = (await listed.json()).data.find((a: { agreementId: string }) => a.agreementId === id);
    expect(found.status, "a refused fund must not move the agreement to FUNDED").toBe("OPEN");
  });

  it("REFUSES a caller-chosen jobId that is not this agreement's escrow identity", async () => {
    const id = `ag_wrongid_${NONCE}`;
    await openAgreementVia(id);
    __setEscrowRailResolverForTests(() => asEvmRail(fakeEvmEscrowRail()));
    const res = await fundWith(id, `0x${"9a".repeat(32)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ESCROW_JOB_ID_MISMATCH");
  });

  it("REFUSES an escrow whose chain disagrees with the agreement's payTo chain", async () => {
    // A `payTo` recorded for Solana cannot receive a Base Sepolia payout: the address is a
    // base58 pubkey where the contract wants 20 bytes. Without this the escrow funds and
    // the payout can never land, which is worse than refusing.
    const id = `ag_mismatch_${NONCE}`;
    await openAgreementVia(id, "solana");
    __setEscrowRailResolverForTests(() => asEvmRail(fakeEvmEscrowRail()));
    const res = await fundWith(id, escrowIdFor(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ESCROW_CHAIN_DISAGREES_WITH_PAYTO");
  });

  it("REFUSES an escrow when the agreement has no on-chain provider at all", async () => {
    const id = `ag_nopayto_${NONCE}`;
    const res = await POST(new Request("http://localhost/api/v1/agreements", {
      method: "POST",
      body: JSON.stringify({
        op: "open", spaceId: ESCROW_SPACE_ID,
        draft: {
          agreementId: id, runId: `run_lp6_${id}`, intentId: "intent_1",
          client: "agent_buyer_07", provider: "erc8183:provider-3", evaluator: "agent_eval_02",
          price: { asset: "USDC", amount: 15 }, deadline: "2027-01-01T00:00:00Z",
          acceptanceCriteria: ["d"], failurePolicy: "refund on expiry", externalJobRefs: [],
          // No payTo: `agreement.provider` is a Mitra agent id, not an address.
        },
        proposal: { capability: "payment", amount: { asset: "USDC", amount: 15 } },
      }),
    }));
    expect(res.status).toBe(201);
    __setEscrowRailResolverForTests(() => asEvmRail(fakeEvmEscrowRail()));
    const fund = await fundWith(id, escrowIdFor(id));
    expect(fund.status).toBe(409);
    expect((await fund.json()).error).toBe("ESCROW_PROVIDER_ADDRESS_MISSING");
  });

  it("probes before broadcasting and funds once", async () => {
    const id = `ag_lock_${NONCE}`;
    const rail = fakeEvmEscrowRail();
    __setEscrowRailResolverForTests(() => asEvmRail(rail));
    await openAgreementVia(id);

    const res = await fundWith(id, escrowIdFor(id));
    expect(res.status).toBe(200);
    expect(rail.calls.indexOf("getJob"), "the probe has to come first").toBeLessThan(rail.calls.indexOf("depositToEscrow"));
    expect(rail.count("depositToEscrow")).toBe(1);
  });

  it("heals the database on a retry instead of funding a second escrow", async () => {
    // The dual-write case, end to end. The first attempt broadcast and then lost its
    // database write, so the agreement is still OPEN while the escrow exists on chain.
    // The retry must detect that and heal — one broadcast across two attempts.
    const id = `ag_crash_${NONCE}`;
    await openAgreementVia(id);
    const jobId = escrowIdFor(id);

    // Attempt 1: the chain succeeds; the database write is lost because the request dies
    // before `commitAgreementOp` — modelled by having the rail broadcast and the caller
    // never observing the response.
    const rail = fakeEvmEscrowRail({
      job: {
        jobId: jobId as `0x${string}`, clientVault: contractAddress as `0x${string}`,
        provider: PROVIDER_ADDRESS as `0x${string}`,
        evaluator: "0x0000000000000000000000000000000000000002" as `0x${string}`,
        token: "0x0000000000000000000000000000000000000003" as `0x${string}`,
        amount: 15_000_000n, timeout: 1_893_456_000n, status: 1,
        refundRouteHash: routeCommitment(onChainRefundRouteFor({ chain: "baseSepolia", contractAddress, jobId })) as `0x${string}`,
      },
    });
    __setEscrowRailResolverForTests(() => asEvmRail(rail));

    const res = await fundWith(id, jobId);
    expect(res.status).toBe(200);
    // The chain already held a funded escrow, so this attempt did NOT broadcast.
    expect(rail.count("depositToEscrow"), "a replay must heal, not fund again").toBe(0);

    const body = await res.json();
    expect(body.data.agreement.status).toBe("FUNDED");
    // The commitment the chain held is the one the agreement records — one value, two layers.
    expect(body.data.agreement.refundRouteHash).toBe(
      routeCommitment(onChainRefundRouteFor({ chain: "baseSepolia", contractAddress, jobId })),
    );
  });

  it("REFUSES when the chain holds a different §15.5 commitment", async () => {
    const id = `ag_badroute_${NONCE}`;
    await openAgreementVia(id);
    const jobId = escrowIdFor(id);
    const rail = fakeEvmEscrowRail({
      job: {
        jobId: jobId as `0x${string}`, clientVault: contractAddress as `0x${string}`,
        provider: PROVIDER_ADDRESS as `0x${string}`,
        evaluator: "0x0000000000000000000000000000000000000002" as `0x${string}`,
        token: "0x0000000000000000000000000000000000000003" as `0x${string}`,
        amount: 15_000_000n, timeout: 1_893_456_000n, status: 1,
        refundRouteHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      },
    });
    __setEscrowRailResolverForTests(() => asEvmRail(rail));
    const res = await fundWith(id, jobId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ESCROW_REFUND_ROUTE_MISMATCH");
  });

  it("records a real transaction hash on the event when it broadcast", async () => {
    const id = `ag_hash_${NONCE}`;
    const rail = fakeEvmEscrowRail({ txPrefix: "7f".repeat(32) });
    __setEscrowRailResolverForTests(() => asEvmRail(rail));
    await openAgreementVia(id);
    await fundWith(id, escrowIdFor(id));
    // The hash is only meaningful if it reached the durable record; a fake placeholder in a
    // log is worse than no log.
    const events = await getStore();
    const logged = (await events.repo.listEvents?.(`run_lp6_${id}`)) ?? [];
    const escrowed = logged.find((e: { metadata?: Record<string, unknown> }) => e.metadata?.escrowTxHash);
    expect(escrowed?.metadata?.escrowTxHash).toBe(`0x${"7f".repeat(32)}`);
    expect(escrowed?.metadata?.escrowSkipped).toBe(false);
  });

  it("omits the transaction hash entirely when it skipped", async () => {
    const id = `ag_nohash_${NONCE}`;
    await openAgreementVia(id);
    const jobId = escrowIdFor(id);
    const rail = fakeEvmEscrowRail({
      job: {
        jobId: jobId as `0x${string}`, clientVault: contractAddress as `0x${string}`,
        provider: PROVIDER_ADDRESS as `0x${string}`,
        evaluator: "0x0000000000000000000000000000000000000002" as `0x${string}`,
        token: "0x0000000000000000000000000000000000000003" as `0x${string}`,
        amount: 15_000_000n, timeout: 1_893_456_000n, status: 1,
        refundRouteHash: routeCommitment(onChainRefundRouteFor({ chain: "baseSepolia", contractAddress, jobId })) as `0x${string}`,
      },
    });
    __setEscrowRailResolverForTests(() => asEvmRail(rail));
    await fundWith(id, jobId);

    const { repo } = await getStore();
    const logged = (await repo.listEvents?.(`run_lp6_${id}`)) ?? [];
    const escrowed = logged.find((e: { metadata?: Record<string, unknown> }) => e.metadata?.escrowAction);
    expect(escrowed?.metadata?.escrowSkipped).toBe(true);
    expect(escrowed?.metadata, "no placeholder hash on a skipped run").not.toHaveProperty("escrowTxHash");
  });
});
