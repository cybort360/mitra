import { beforeEach, describe, expect, it } from "vitest";
import { getStore, __resetStoreForTests } from "@/lib/store/provider";
import { commitAgreementOp, AgreementStoreIncomplete } from "@/lib/commerce/commit-op";
import { openAgreement } from "@/lib/kernel/commerce";
import { __resetLedgerForTests } from "@/lib/store/ledger";
import type { Money, Space } from "@/lib/domain/types";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });

const space = (): Space => ({
  spaceId: "space_1", owner: "buyer_1",
  governance: { mode: "QUORUM" as const, admins: [], governors: ["buyer_1"], threshold: 1 },
  rules: { source: "mitra" as const, digest: "d" },
  status: "ACTIVE", participants: ["buyer_1"],
  allowedCapabilities: ["research"], settlementChains: ["solana"],
  budget: USDC(100), committed: USDC(0), version: 1, createdAt: "2026-01-01T00:00:00Z",
});

const escrow = {
  chain: "baseSepolia",
  contractAddress: "0x6a731a654423d64afb9839742c3e48c6c54eea9c",
  jobId: `0x${"9a".repeat(32)}`,
};

/**
 * F77 — the fund path's two writes are no longer separable.
 *
 * Before: `applyAgreementOpWithSaga` saved the ARMED saga and RETURNED, then the route
 * wrote the agreement in a second transaction. Losing the second left a persisted
 * ARMED saga no agreement named — and since every op finds its saga through
 * `agreement.sagaIds`, nothing could ever advance it. A committed §15.5 route with no
 * execution behind it, invisible to any health check.
 *
 * The fix returns `sagasToPersist` from a store-free kernel, and persists the agreement
 * before the saga. That direction strands an agreement naming a missing saga — which
 * the kernel already treats as a broken link, not an error — instead of a commitment
 * nobody can run.
 *
 * This was an `it.fails` canary. It is now a plain `it`: the invariant holds.
 */
describe("F77 — an ARMED saga is never persisted without its agreement", () => {
  // Unique ids per test. `__resetStoreForTests` resets the IN-MEMORY store; against
  // Postgres the rows persist, and `mitra.agreements` has a PRIMARY KEY. This file hit
  // that immediately, which is the same in-memory/Postgres divergence F78 describes.
  // The NONCE matters as much as the counter: `seq` restarts at 1 every time this file
  // is run, and against Postgres the rows from the previous run are still there. A
  // counter alone produced a failure that looked exactly like "the fix does not work".
  const NONCE = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const ids = () => ({
    agreementId: `ag_f77_${NONCE}_${++seq}`,
    runId: `run_f77_${NONCE}_${seq}`,
    intentId: `intent_f77_${NONCE}_${seq}`,
  });

  beforeEach(() => { __resetLedgerForTests(); __resetStoreForTests(); });

  /** A repository whose `updateAgreement` fails, standing in for a lost write. */
  const repoWithBrokenAgreementWrite = async () => {
    const { repo } = await getStore();
    // A proxy, not a spread: the repository's methods live on its prototype.
    return new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "updateAgreement") return async () => { throw new Error("CONNECTION_LOST_MID_WRITE"); };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };

  it("leaves NO saga behind when the agreement write fails", async () => {
    const torn = await repoWithBrokenAgreementWrite();
    const { repo } = await getStore();

    const id = ids();
    await repo.createSpace!(space());
    const opened = openAgreement(space(), {
      ...id,
      client: "buyer_1", provider: "provider_1",
      externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
    } as never, { capability: "research", amount: USDC(10) });
    if (!opened.ok) throw new Error(opened.reason);
    await repo.saveAgreement!(opened.value.agreement);

    await expect(
      commitAgreementOp(torn, space(), opened.value.agreement, "fund", {
        capability: "research", amount: USDC(10), onChainEscrow: escrow,
      }),
    ).rejects.toThrow("CONNECTION_LOST_MID_WRITE");

    // The saga write is AFTER the agreement write, so it never ran.
    expect(await repo.listSagas(id.runId), "no stranded ARMED saga").toEqual([]);

    // And the agreement still names no saga, so the two agree.
    const stored = await repo.getAgreement!(id.agreementId);
    expect(stored?.sagaIds ?? []).toEqual([]);
    expect(stored?.status).toBe("OPEN");
  });

  it("persists both, agreement first, when the writes succeed", async () => {
    const { repo } = await getStore();
    const id = ids();
    await repo.createSpace!(space());
    const opened = openAgreement(space(), {
      ...id,
      client: "buyer_1", provider: "provider_1",
      externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
    } as never, { capability: "research", amount: USDC(10) });
    if (!opened.ok) throw new Error(opened.reason);
    await repo.saveAgreement!(opened.value.agreement);

    const r = await commitAgreementOp(repo, space(), opened.value.agreement, "fund", {
      capability: "research", amount: USDC(10), onChainEscrow: escrow,
    });
    if (!r.ok) throw new Error(r.reason);

    const stored = await repo.getAgreement!(id.agreementId);
    expect(stored?.sagaIds).toEqual([r.value.saga!.sagaId]);
    expect((await repo.getSaga(r.value.saga!.sagaId))?.status).toBe("ARMED");
    // F76's commitment is attached and, because the link is intact, verifiable.
    expect(stored?.refundRouteHash).toBe(r.value.saga!.routeCommitments![`route_refund_${escrow.jobId.slice(0, 10)}`]);
  });

  it("a store missing the optional write methods refuses BEFORE writing anything", async () => {
    const { repo } = await getStore();
    const crippled = new Proxy(repo, {
      get(target, prop, receiver) {
        // `updateSpace` is genuinely optional on `EconomicRepository`, so this is a
        // reachable state — unlike `saveSaga`, which a guard for it could never see.
        if (prop === "updateSpace") return undefined;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const opened = openAgreement(space(), {
      ...ids(),
      client: "buyer_1", provider: "provider_1",
      externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
    } as never, { capability: "research", amount: USDC(10) });
    if (!opened.ok) throw new Error(opened.reason);

    await expect(
      commitAgreementOp(crippled, space(), opened.value.agreement, "fund", {
        capability: "research", amount: USDC(10),
      }),
      // Asserting the CLASS, not the message: with the guard removed this still
      // rejects, but with a raw `TypeError: repo.updateSpace is not a function`,
      // and a `/updateSpace/` regex matches that too — so the mutation survived a
      // message-based assertion. The point of the guard is the clear, deliberate
      // refusal, so that is what has to be checked.
    ).rejects.toThrow(AgreementStoreIncomplete);
  });
});
