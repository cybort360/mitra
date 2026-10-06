import { beforeEach, describe, expect, it } from "vitest";
import { getStore, __resetStoreForTests } from "@/lib/store/provider";
import { applyAgreementOpWithSaga } from "@/lib/kernel/commerce-recovery";
import { openAgreement } from "@/lib/kernel/commerce";
import { __resetLedgerForTests } from "@/lib/store/ledger";
import type { Money } from "@/lib/domain/types";
const USDC = (amount: number): Money => ({ asset: "USDC", amount });

const space = () => ({
  spaceId: "space_1", owner: "buyer_1",
  governance: { mode: "QUORUM" as const, admins: [], governors: ["buyer_1"], threshold: 1 },
  rules: { source: "mitra" as const, digest: "d" },
  status: "ACTIVE" as const, participants: ["buyer_1"],
  allowedCapabilities: ["research"], settlementChains: ["solana" as const],
  budget: USDC(100), committed: USDC(0), version: 1, createdAt: "2026-01-01T00:00:00Z",
});

/**
 * F77 — the saga write and the agreement write are not atomic.
 *
 * `applyAgreementOpWithSaga` persists the ARMED saga (commerce-recovery.ts:147) and
 * RETURNS; the route then persists the agreement (route.ts:310). Two transactions,
 * no enclosing one. If the route's write never lands, the store keeps an ARMED saga
 * that no agreement names — and every later op finds its saga through
 * `agreement.sagaIds` (commerce-recovery.ts:167), so nothing can ever advance it.
 *
 * The stranded saga also carries the §15.5 commitment F76 added: a real keccak256
 * hash, on disk, belonging to a route nobody can check or run.
 *
 * `it.fails` because the invariant is NOT currently held. It is kept as a canary
 * rather than deleted: when the fund path is made atomic, this test starts passing
 * and vitest reports the `it.fails` as a failure, which is the signal to flip it to
 * `it` and record the fix. A plain `it` asserting today's behaviour would make the
 * repair look like a regression.
 */
describe("F77 — the saga write and the agreement write are not atomic", () => {
  beforeEach(() => { __resetLedgerForTests(); __resetStoreForTests(); });

  it.fails("a persisted ARMED saga is never left unreachable", async () => {
    const { repo } = await getStore();
    const r = openAgreement(space(), {
      agreementId: "ag_1", runId: "run_1", intentId: "intent_1",
      client: "buyer_1", provider: "provider_1",
      externalJobRefs: [], price: USDC(10), deadline: "2027-01-01T00:00:00Z",
      acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
    } as never, { capability: "research", amount: USDC(10) });
    if (!r.ok) throw new Error(r.reason);
    // The route persisted it at open (route.ts:200), so the starting state is real.
    await repo.saveAgreement!(r.value.agreement);

    // The kernel writes the saga (commerce-recovery.ts:147) and RETURNS. The route
    // writes the agreement afterwards (route.ts:310). Those are two transactions,
    // so simulate the tear the only way it can happen: the kernel succeeds, and the
    // route's own write never lands.
    const outcome = await applyAgreementOpWithSaga(repo, space(), r.value.agreement, "fund", {
      capability: "research", amount: USDC(10),
      onChainEscrow: {
        chain: "baseSepolia",
        contractAddress: "0x6a731a654423d64afb9839742c3e48c6c54eea9c",
        jobId: `0x${"9a".repeat(32)}`,
      },
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    // ...route.ts:310 throws here. Nothing rolls the saga back.

    // ── The invariant, which does not hold today ────────────────────────────
    // The agreement must record the saga it armed. It does not, so this fails now
    // and `it.fails` is satisfied; when the fund path becomes atomic it passes and
    // vitest flags this, which is when it becomes a plain `it`.
    const stored = await repo.getAgreement!("ag_1");
    expect(stored?.sagaIds ?? []).toHaveLength(1);

    // Everything below is the consequence, and is asserted only to keep the shape of
    // the bug in the file: a stranded ARMED saga, unreachable by any op.
    const stranded = await repo.listSagas("run_1");
    expect(stranded.length, "the kernel wrote the saga before the route wrote the agreement").toBe(1);
    expect(stranded[0].status, "ARMED, with a live §15.5 commitment nobody can run").toBe("ARMED");
    expect(stranded[0].routeCommitments, "F76's commitment is on disk and unverifiable").toBeTruthy();
  });
});
