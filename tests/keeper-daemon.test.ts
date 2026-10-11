/**
 * The keeper's tests.
 *
 * The daemon is the one process in the system whose normal action is **moving capital**, so
 * its tests are about refusal far more than about success. The properties pinned here:
 *
 *  1. It does nothing before the deadline. A keeper that refunds a live job destroys work in
 *     progress, and nothing else in the system would notice.
 *  2. It needs no authority — the refund is permissionless after the deadline — so the only
 *     call it ever makes is the one that returns capital.
 *  3. A refund it cannot verify is a refusal, not a success.
 */
import { describe, expect, it } from "vitest";
import { runKeeperPass, selectDueTargets } from "@/scripts/keeper-daemon";
import { reconcileAgreementEscrow } from "@/lib/commerce/escrow-reconcile";
import type { EscrowRail } from "@/lib/commerce/onchain-escrow";
import type { Agreement } from "@/lib/domain/types";

const NOW = 1_800_000_000n;
const JOB = `0x${"ab".repeat(32)}`;
const ADDR = "0x0000000000000000000000000000000000000001";

function agreement(over: Partial<Agreement> = {}): Agreement {
  return {
    agreementId: "agr_keeper", spaceIds: ["spc_1"], runId: "run_1", intentId: "int_1",
    client: "0xclient", provider: "provider", price: 100, deadline: "2099-01-01T00:00:00.000Z",
    escrowRef: JOB, escrowChain: "evm", escrowTimeout: Number(NOW), status: "EXECUTING",
    version: 1, ...over,
  } as Agreement;
}

/** Terms the keeper compares the on-chain job against. */
const intended = { amount: 100_000_000n, provider: "provider", client: "0xclient", timeout: NOW };

interface RailOpts {
  onRefund?: () => void | Promise<void>;
  /** Make the job unreadable, as an unreachable RPC would. */
  unreadable?: boolean;
  /** Extra methods, so a test can assert they are never called. */
  extra?: Record<string, unknown>;
}

function makeRail(opts: RailOpts = {}): { rail: EscrowRail; calls: string[] } {
  const calls: string[] = [];
  const evm = {
    address: ADDR,
    getJob: async () => {
      if (opts.unreadable) throw new Error("RPC unreachable");
      return { jobId: JOB, provider: "provider", client: "0xclient", amount: 100_000_000n, timeout: NOW, status: 1 };
    },
    refundJob: async () => {
      calls.push("refundJob");
      await opts.onRefund?.();
      return "0xdead";
    },
    ...opts.extra,
  };
  const rail = { chain: "evm", network: "local", evm } as unknown as EscrowRail;
  return { rail, calls };
}

/** A rail whose refund actually lands, so the post-probe sees SETTLED. */
function settlingRail() {
  let settled = false;
  const { rail, calls } = makeRail({
    onRefund: () => { settled = true; },
  });
  const inner = rail.evm!.getJob;
  rail.evm!.getJob = async (jobId: `0x${string}`) => {
    if (settled) return { jobId: JOB, provider: "provider", client: "0xclient", amount: 100_000_000n, timeout: NOW, status: 3 } as any;
    return inner(jobId);
  };
  return { rail, calls };
}

describe("keeper: the deadline is the authority", () => {
  it("does NOT refund before the deadline, and says why", async () => {
    const { rail, calls } = makeRail();
    // One second before the deadline.
    const outcome = await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) - 1 });

    expect(calls).toEqual([]);
    expect(outcome.action).toBe("observed");
    expect((outcome as { reason: string }).reason).toContain("not yet due");
  });

  it("refunds once the deadline has passed, and re-probes to confirm", async () => {
    const { rail, calls } = settlingRail();
    const outcome = await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) });

    expect(calls).toEqual(["refundJob"]);
    expect(outcome.action).toBe("refunded");
    // The healed agreement must not still claim capital is escrowed.
    expect((outcome as { agreement: Agreement }).agreement.status).toBe("REFUNDED");
    expect((outcome as { agreement: Agreement }).agreement.escrowReleased).toBe(true);
  });

  it("refuses when the chain does not show the refund, rather than claiming success", async () => {
    // A rail that broadcasts successfully but keeps reporting the job as funded — the exact
    // shape of the F86 class of bug. A confirmed transaction is not a claim about the money.
    const { rail } = makeRail();
    const outcome = await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) });

    expect(outcome.action).toBe("refused");
    expect((outcome as { reason: string }).reason).toBe("REFUND_NOT_OBSERVED");
  });

  it("refuses on a broadcast failure and never claims a refund", async () => {
    const { rail } = makeRail({ onRefund: () => { throw new Error("insufficient gas for refund"); } });
    const outcome = await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) });

    expect(outcome.action).toBe("refused");
    expect((outcome as { reason: string }).reason).toBe("BROADCAST_FAILED");
  });

  it("refuses when the chain cannot be read at all, and never claims a refund", async () => {
    const { rail } = makeRail({ unreadable: true });
    const outcome = await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) });

    expect(outcome.action).not.toBe("refunded");
  });
});

describe("keeper: it needs no authority, so it must never escalate", () => {
  it("only ever calls refundJob — never a completion or a dispute", async () => {
    const { rail, calls } = makeRail({
      extra: {
        completeJob: async () => { calls.push("completeJob"); return "0xbad"; },
        disputeJob: async () => { calls.push("disputeJob"); return "0xbad"; },
      },
    });

    await reconcileAgreementEscrow({ agreement: agreement(), rail, intended, now: Number(NOW) });
    // A keeper that could complete a job could TAKE capital. The whole design rests on it
    // having no such call available, so this asserts the absence of the others.
    expect(calls).toEqual(["refundJob"]);
  });
});

describe("keeper: the due-set", () => {
  it("only considers agreements that are live, located an escrow, and recorded a deadline", () => {
    const targets = selectDueTargets(
      [
        agreement({ agreementId: "a_ok", status: "EXECUTING", escrowRef: JOB, escrowTimeout: 1 }),
        // Not live — nothing left to return.
        agreement({ agreementId: "b_done", status: "ACCEPTED", escrowRef: JOB, escrowTimeout: 1 }),
        // No escrowRef: F97 — the agreement cannot locate its own escrow.
        agreement({ agreementId: "c_lost", status: "EXECUTING", escrowRef: undefined, escrowTimeout: 1 }),
        // No recorded deadline: cannot be judged overdue without guessing one.
        agreement({ agreementId: "d_unknown", status: "EXECUTING", escrowRef: JOB, escrowTimeout: undefined }),
      ],
      () => intended,
    );
    expect(targets.map(t => t.agreement.agreementId)).toEqual(["a_ok"]);
  });

  it("counts a refused target as a failure, so the process exit code is meaningful", async () => {
    const { rail } = makeRail({ onRefund: () => { throw new Error("reverted: nothing to refund"); } });
    const result = await runKeeperPass([{ agreement: agreement(), intended }], rail, Number(NOW));

    expect(result.refunded).toBe(0);
    expect(result.refused).toBe(1);
  });

  it("scans nothing and claims no refund when the chain is unreachable", async () => {
    const { rail } = makeRail({ unreadable: true });
    const result = await runKeeperPass([{ agreement: agreement(), intended }], rail, Number(NOW));

    expect(result.refunded).toBe(0);
  });
});