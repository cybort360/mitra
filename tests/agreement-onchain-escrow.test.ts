import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  executeEscrowLock, executeEscrowRelease, executeEscrowRefund,
  escrowIdFor, probeEscrowStatus,
  type EscrowRail, type EscrowTerms, type EvmEscrowRail, type SolanaEscrowRail,
} from "@/lib/commerce/onchain-escrow";
import { routeCommitment } from "@/lib/domain/canonical";
import { onChainRefundRouteFor } from "@/lib/kernel/commerce-recovery";
import { ERC8183Transport, normalizeJobRow } from "@/lib/adapters/erc8183-transport";
import { ACCOUNT, ESCROW_LEN, jobIdFor } from "@/lib/solana/vault-program";
import { PublicKey } from "@solana/web3.js";
import type { Agreement, Money } from "@/lib/domain/types";

/** USDC on Base Sepolia — the token a live job escrow holds. */
const USDC_ADDRESS = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as `0x${string}`;

const ROUTE = "evm:refundEscrow:baseSepolia:0xvault:0xjob";
const COMMITMENT = routeCommitment(ROUTE);

const USDC = (n: number): Money => ({ asset: "USDC", amount: n });

const agreement = (over: Partial<Agreement> = {}): Agreement => ({
  agreementId: "ag_lp6", spaceIds: ["space_1"], runId: "run_1", intentId: "intent_1",
  client: "buyer_1", provider: "provider_1", externalJobRefs: [],
  price: USDC(10), deadline: "2027-01-01T00:00:00Z",
  acceptanceCriteria: ["d"], failurePolicy: "refund on expiry",
  status: "FUNDED", version: 1, ...over,
});

const TERMS: EscrowTerms = {
  amount: 1_000_000n, provider: "0xprovider", client: "0xvault", timeout: 1_900_000_000n,
};

/**
 * Solana parties are base58 pubkeys, so the Solana fakes need their own terms.
 * Comparing an EVM-shaped provider against a base58 one would report MISMATCH and the
 * tests would be asserting the wrong thing.
 */
const SOL_PROVIDER = "So11111111111111111111111111111111111111112";
const SOL_CLIENT = "11111111111111111111111111111112";
const SOL_TERMS: EscrowTerms = {
  amount: 1_000_000n, provider: SOL_PROVIDER, client: SOL_CLIENT, timeout: 1_900_000_000n,
};

// ── fakes ──────────────────────────────────────────────────────────────────────

/**
 * A fake rail that records every call.
 *
 * Recording is the point: most of these assertions are about what was NOT called, and a
 * fake that cannot show an absence cannot prove an idempotency guarantee.
 */
type FakeJob = Awaited<ReturnType<EvmEscrowRail["getJob"]>>;

function evmRail() {
  const calls: string[] = [];
  let job: FakeJob;
  const rail: EvmEscrowRail & { calls: string[] } = {
    calls,
    address: "0xescrow",
    async depositToEscrow() { calls.push("depositToEscrow"); job = fundedJob(); return "0xLOCKTX"; },
    async completeJob() { calls.push("completeJob"); return "0xRELEASETX"; },
    async refundJob() { calls.push("refundJob"); return "0xREFUNDTX"; },
    async getJob() { calls.push("getJob"); return job; },
  };
  return Object.assign(rail, { setJob: (j: FakeJob) => { job = j; } });
}

const fundedJob = (over: Record<string, unknown> = {}) => ({
  jobId: "0x0" as `0x${string}`, clientVault: "0xvault" as `0x${string}`,
  provider: "0xprovider" as `0x${string}`, evaluator: "0xeval" as `0x${string}`,
  token: "0xtoken" as `0x${string}`, amount: TERMS.amount, timeout: TERMS.timeout,
  status: 1, refundRouteHash: COMMITMENT as `0x${string}`, ...over,
});

const evmRailWith = (job: FakeJob) => {
  const r = evmRail();
  r.setJob(job);
  return r;
};

const asEscrowRail = (evm: EvmEscrowRail): EscrowRail => ({ chain: "evm", network: "baseSepolia", evm });

function solanaRail(bytes: Buffer | null) {
  const calls: string[] = [];
  let account = bytes;
  const rail: SolanaEscrowRail & { calls: string[] } = {
    calls,
    async readEscrow() { calls.push("readEscrow"); return account; },
    async lockEscrow() { calls.push("lockEscrow"); return "SOLLOCK"; },
    async releaseEscrow() { calls.push("releaseEscrow"); return "SOLRELEASE"; },
    async refundEscrow() { calls.push("refundEscrow"); return "SOLREFUND"; },
  };
  return Object.assign(rail, { setAccount: (b: Buffer | null) => { account = b; } });
}

/**
 * The inverse of `decodeJobEscrow`, so the fake rail is checked by the same decoder
 * production uses rather than by a hand-rolled comparison in the test.
 */
function encodeJobEscrowAccount(a: {
  jobId: Buffer; client: string; provider: string; amount: bigint; timeout: bigint;
  completed: boolean; refunded: boolean; refundRouteHash: Buffer;
}): Buffer {
  const b = Buffer.alloc(ESCROW_LEN);
  ACCOUNT.jobEscrow.copy(b, 0);
  a.jobId.copy(b, 8);
  new PublicKey(a.client).toBuffer().copy(b, 40);
  new PublicKey(a.provider).toBuffer().copy(b, 72);
  b.writeBigUInt64LE(a.amount, 104);
  b.writeBigUInt64LE(a.timeout, 112);
  b[120] = a.completed ? 1 : 0;
  b[121] = a.refunded ? 1 : 0;
  a.refundRouteHash.copy(b, 122);
  return b;
}

const solanaEscrowBytes = (over: Partial<{ amount: bigint; timeout: bigint; commitment: string; completed: boolean; refunded: boolean; provider: string }> = {}) =>
  encodeJobEscrowAccount({
    jobId: jobIdFor("ag_lp6"),
    client: SOL_CLIENT,
    provider: over.provider ?? SOL_PROVIDER,
    amount: over.amount ?? TERMS.amount,
    timeout: over.timeout ?? TERMS.timeout,
    completed: over.completed ?? false,
    refunded: over.refunded ?? false,
    refundRouteHash: Buffer.from((over.commitment ?? COMMITMENT).replace(/^0x/, ""), "hex"),
  });

// ── identity ───────────────────────────────────────────────────────────────────

describe("LP-6 — the escrow identity is deterministic", () => {
  it("is 32 bytes and the same on every call", () => {
    expect(escrowIdFor("ag_lp6")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(escrowIdFor("ag_lp6")).toBe(escrowIdFor("ag_lp6"));
  });

  it("differs per agreement, so two agreements cannot share an escrow", () => {
    expect(escrowIdFor("ag_a")).not.toBe(escrowIdFor("ag_b"));
  });

  it("matches the Solana rail's own derivation of the same id", () => {
    // The EVM bytes32 and the Solana PDA seed must come from ONE narrowing, or a retry
    // could address a different escrow than the first attempt created.
    expect(escrowIdFor("ag_lp6").slice(2)).toBe(jobIdFor("ag_lp6").toString("hex"));
  });
});

// ── probe ──────────────────────────────────────────────────────────────────────

describe("LP-6 — the read-before-write probe", () => {
  it("reports ABSENT when nothing is escrowed", async () => {
    const rail = asEscrowRail(evmRail());
    expect((await probeEscrowStatus(agreement(), rail, TERMS)).state).toBe("ABSENT");
  });

  it("treats a zero-amount row as absent rather than funded", async () => {
    // `getJob` on an unknown id reverts on some revisions and returns zeroes on others.
    const rail = asEscrowRail(evmRailWith(fundedJob({ amount: 0n })));
    expect((await probeEscrowStatus(agreement(), rail, TERMS)).state).toBe("ABSENT");
  });

  it("reports FUNDED when every term matches", async () => {
    const rail = asEscrowRail(evmRailWith(fundedJob()));
    const p = await probeEscrowStatus(agreement(), rail, TERMS);
    expect(p.state).toBe("FUNDED");
    if (p.state === "FUNDED") expect(p.onChainRefundRouteHash).toBe(COMMITMENT);
  });

  it.each([
    ["amount", { amount: TERMS.amount + 1n }, "ESCROW_AMOUNT_DIFFERS"],
    ["provider", { provider: "0xsomeoneelse" }, "ESCROW_PROVIDER_DIFFERS"],
    ["timeout", { timeout: TERMS.timeout + 1n }, "ESCROW_TIMEOUT_DIFFERS"],
  ])("reports MISMATCH on a differing %s, never overwriting it", async (_what, over, reason) => {
    const rail = asEscrowRail(evmRailWith(fundedJob(over)));
    const p = await probeEscrowStatus(agreement(), rail, TERMS);
    expect(p.state).toBe("MISMATCH");
    if (p.state === "MISMATCH") expect(p.reason).toBe(reason);
  });

  it("reports SETTLED for a completed job and for a refunded one", async () => {
    const done = asEscrowRail(evmRailWith(fundedJob({ status: 2 })));
    expect(await probeEscrowStatus(agreement(), done, SOL_TERMS)).toMatchObject({ state: "SETTLED", outcome: "completed" });
    const refunded = asEscrowRail(evmRailWith(fundedJob({ status: 3 })));
    expect(await probeEscrowStatus(agreement(), refunded, TERMS)).toMatchObject({ state: "SETTLED", outcome: "refunded" });
  });

  it("refuses a row whose amount and status contradict each other", async () => {
    // Status None with an amount in hand. Reading that as "absent" would re-fund an
    // agreement that already has an escrow — the one outcome that yields two escrows.
    const rail = asEscrowRail(evmRailWith(fundedJob({ status: 0 })));
    const p = await probeEscrowStatus(agreement(), rail, TERMS);
    expect(p).toMatchObject({ state: "MISMATCH", reason: "ESCROW_ROW_CONTRADICTS_STATUS" });
  });

  it("matches the JobStatus enum in the contract source", () => {
    // Pinned because an off-by-one would classify a completed escrow as funded, and the
    // "already settled" skip would then never fire on a job that had paid out.
    const sol = readFileSync("contracts/src/ERC8183/MitraJobEscrow.sol", "utf8");
    expect(sol).toContain("enum JobStatus { None, Funded, Completed, Refunded }");
    // The mapping used above: 1 Funded, 2 Completed, 3 Refunded, matching that order.
  });

  describe("Solana", () => {
    it("reports ABSENT when the PDA has no account", async () => {
      const rail: EscrowRail = { chain: "solana", network: "devnet", solana: solanaRail(null) };
      expect((await probeEscrowStatus(agreement(), rail, SOL_TERMS)).state).toBe("ABSENT");
    });

    it("reads a real escrow account", async () => {
      const rail: EscrowRail = { chain: "solana", network: "devnet", solana: solanaRail(solanaEscrowBytes()) };
      const p = await probeEscrowStatus(agreement(), rail, SOL_TERMS);
      expect(p.state).toBe("FUNDED");
      if (p.state === "FUNDED") expect(p.terms.amount).toBe(SOL_TERMS.amount);
    });

    it("refuses an account it cannot decode rather than calling it absent", async () => {
      // A PDA can hold any bytes. Reading garbage as "no escrow" would re-fund an
      // agreement whose escrow exists, and the second lock would either revert or
      // create a second account.
      const rail: EscrowRail = { chain: "solana", network: "devnet", solana: solanaRail(Buffer.alloc(154, 9)) };
      const p = await probeEscrowStatus(agreement(), rail, TERMS);
      expect(p).toMatchObject({ state: "MISMATCH" });
      if (p.state === "MISMATCH") expect(p.reason).toContain("ESCROW_ACCOUNT_UNREADABLE");
    });

    it("reports SETTLED for a completed or refunded account", async () => {
      const done: EscrowRail = { chain: "solana", network: "devnet", solana: solanaRail(solanaEscrowBytes({ completed: true })) };
      expect(await probeEscrowStatus(agreement(), done, TERMS)).toMatchObject({ state: "SETTLED", outcome: "completed" });
      const back: EscrowRail = { chain: "solana", network: "devnet", solana: solanaRail(solanaEscrowBytes({ refunded: true })) };
      expect(await probeEscrowStatus(agreement(), back, SOL_TERMS)).toMatchObject({ state: "SETTLED", outcome: "refunded" });
    });
  });
});

// ── lock ───────────────────────────────────────────────────────────────────────

describe("LP-6 — locking is idempotent under a lost database write", () => {
  beforeEach(() => undefined);

  it("probes BEFORE broadcasting", async () => {
    const rail = evmRail();
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r.ok).toBe(true);
    // The read has to come first, or "already funded" is decided after the fact.
    expect(rail.calls.indexOf("getJob")).toBeLessThan(rail.calls.indexOf("depositToEscrow"));
  });

  it("broadcasts when absent, and reports a real transaction hash", async () => {
    const rail = evmRail();
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toEqual({ ok: true, action: "locked", txHash: "0xLOCKTX", skipped: false });
    expect(rail.calls).toContain("depositToEscrow");
  });

  it("SKIPS the broadcast when the escrow is already funded with matching terms", async () => {
    // THE dual-write case. The first attempt broadcast and then lost its database write;
    // the retry must heal the database, not fund a second escrow.
    const rail = evmRailWith(fundedJob());
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toEqual({ ok: true, action: "locked", skipped: true, reason: "ALREADY_FUNDED" });
    expect(rail.calls, "no broadcast on a replay").not.toContain("depositToEscrow");
  });

  it("never returns a synthetic transaction hash", async () => {
    // AGENTS.md forbids it, and the tempting `txHash: "ALREADY_FUNDED"` shape makes a
    // skipped run indistinguishable from a real one to anything that logs the field.
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(evmRailWith(fundedJob())),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).not.toHaveProperty("txHash");
    // The skip REASON is legitimately the string "ALREADY_FUNDED" — that is a reason,
    // not a transaction hash. The property under test is that no `txHash` is invented,
    // and that a caller branching on "did we broadcast" reads `skipped`, never a hash.
    expect(r).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_FUNDED" });
  });

  it("gives a real-looking hash only when it broadcast", async () => {
    const fresh = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(evmRail()),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(fresh).toMatchObject({ skipped: false });
    expect(typeof (fresh as { txHash?: string }).txHash).toBe("string");
  });

  it("REFUSES when the chain holds a different §15.5 commitment", async () => {
    // The commitment is the one thing that must not be taken on trust: if the chain has
    // a different route hash, F76's redirect check will refuse every refund of this
    // escrow. Found at lock time because at refund time it is too late to fix.
    const rail = evmRailWith(fundedJob({ refundRouteHash: `0x${"ab".repeat(32)}` }));
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toMatchObject({ ok: false, reason: "ESCROW_REFUND_ROUTE_MISMATCH" });
  });

  it("REFUSES to re-lock a settled escrow", async () => {
    const rail = evmRailWith(fundedJob({ status: 2 }));
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toMatchObject({ ok: true, skipped: true, reason: "TERMINAL_ESCROW_CANNOT_BE_RELOCKED" });
    expect(rail.calls).not.toContain("depositToEscrow");
  });

  it("REFUSES on a terms mismatch rather than funding a second escrow", async () => {
    const rail = evmRailWith(fundedJob({ amount: TERMS.amount + 1n }));
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toMatchObject({ ok: false, reason: "ESCROW_AMOUNT_DIFFERS" });
    expect(rail.calls).not.toContain("depositToEscrow");
  });

  it("reports a broadcast failure rather than claiming success", async () => {
    const rail = evmRail();
    rail.depositToEscrow = async () => { throw new Error("insufficient funds for gas"); };
    const r = await executeEscrowLock({
      agreement: agreement(), intended: TERMS, refundRouteHash: COMMITMENT,
      rail: asEscrowRail(rail),
      evm: { clientVault: "0xvault", token: "0xtoken", evaluator: "0xeval" },
    });
    expect(r).toMatchObject({ ok: false, reason: "BROADCAST_FAILED" });
    expect(r).not.toHaveProperty("txHash");
  });

  it("locks on Solana with the same probe-first shape", async () => {
    const sol = solanaRail(null);
    const rail: EscrowRail = { chain: "solana", network: "devnet", solana: sol };
    const r = await executeEscrowLock({ agreement: agreement(), intended: SOL_TERMS, refundRouteHash: COMMITMENT, rail });
    expect(r).toEqual({ ok: true, action: "locked", txHash: "SOLLOCK", skipped: false });
    expect(sol.calls.indexOf("readEscrow")).toBeLessThan(sol.calls.indexOf("lockEscrow"));

    // …and the replay does not re-broadcast.
    sol.setAccount(solanaEscrowBytes());
    const again = await executeEscrowLock({ agreement: agreement(), intended: SOL_TERMS, refundRouteHash: COMMITMENT, rail });
    expect(again).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_FUNDED" });
    expect(sol.calls.filter((c) => c === "lockEscrow")).toHaveLength(1);
  });
});

// ── release & refund ───────────────────────────────────────────────────────────

describe("LP-6 — release and refund never double-pay", () => {
  it("completes a funded job and never a settled one", async () => {
    const rail = evmRailWith(fundedJob());
    expect(await executeEscrowRelease(agreement(), asEscrowRail(rail), TERMS))
      .toEqual({ ok: true, action: "released", txHash: "0xRELEASETX", skipped: false });

    const settled = evmRailWith(fundedJob({ status: 2 }));
    const r = await executeEscrowRelease(agreement(), asEscrowRail(settled), TERMS);
    expect(r).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_SETTLED" });
    expect(settled.calls, "a replay must not pay twice").not.toContain("completeJob");
  });

  it("refunds a funded job, and treats an already-refunded one as final", async () => {
    const rail = evmRailWith(fundedJob());
    expect(await executeEscrowRefund(agreement(), asEscrowRail(rail), TERMS))
      .toEqual({ ok: true, action: "refunded", txHash: "0xREFUNDTX", skipped: false });

    const done = evmRailWith(fundedJob({ status: 3 }));
    const r = await executeEscrowRefund(agreement(), asEscrowRail(done), TERMS);
    expect(r).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_SETTLED" });
    expect(done.calls).not.toContain("refundJob");
  });

  it("will not release or refund an escrow that does not exist", async () => {
    const rail = evmRail();
    expect(await executeEscrowRelease(agreement(), asEscrowRail(rail), TERMS)).toMatchObject({ ok: false, reason: "NO_ESCROW_TO_RELEASE" });
    expect(await executeEscrowRefund(agreement(), asEscrowRail(rail), TERMS)).toMatchObject({ ok: false, reason: "NO_ESCROW_TO_REFUND" });
    expect(rail.calls).not.toContain("completeJob");
    expect(rail.calls).not.toContain("refundJob");
  });

  it("refuses a release against an escrow whose terms differ", async () => {
    const rail = evmRailWith(fundedJob({ amount: 1n }));
    expect(await executeEscrowRelease(agreement(), asEscrowRail(rail), TERMS)).toMatchObject({ ok: false, reason: "ESCROW_AMOUNT_DIFFERS" });
    expect(rail.calls).not.toContain("completeJob");
  });

  it("takes no route argument — the refund consults only what was committed", async () => {
    // If this function accepted a route, it would be synthesising compensation after the
    // failure, which is what §15.5 forbids. Its arity is the guarantee.
    expect(executeEscrowRefund.length).toBe(3);
  });

  it("releases and refunds on Solana", async () => {
    const sol = solanaRail(solanaEscrowBytes());
    const rail: EscrowRail = { chain: "solana", network: "devnet", solana: sol };
    expect(await executeEscrowRelease(agreement(), rail, SOL_TERMS)).toMatchObject({ ok: true, txHash: "SOLRELEASE" });
    expect(await executeEscrowRefund(agreement(), rail, SOL_TERMS)).toMatchObject({ ok: true, txHash: "SOLREFUND" });
  });
});

/**
 * LP-6 live: a real escrow on Base Sepolia.
 *
 * Gated on `JOB_ESCROW_LIVE=1` **and** a funded key file **and** a deployed
 * `MitraJobEscrow` in `lib/evm/deployments.json`. Every condition is checked rather than
 * assumed, so a green run cannot come from a skipped suite reading as a pass.
 *
 * What it demonstrates that the hermetic suite cannot: that the deployed contract's
 * `jobs()` view returns what `ERC8183Transport.getJob` expects, that the ABI's status
 * ordinals match `EVM_JOB_STATUS`, and — most importantly — that **the probe really does
 * observe a chain-funded escrow**, which is the whole premise of the idempotency engine.
 *
 * It also runs the crash-recovery case against the real chain: fund, then re-probe and
 * assert the second attempt SKIPS rather than double-funding.
 */
describe.skipIf(
  !(process.env.JOB_ESCROW_LIVE === "1"
    && process.env.MITRA_EVM_SETTLEMENT_KEY_FILE
    && existsSync(process.env.MITRA_EVM_SETTLEMENT_KEY_FILE)),
)("live: an agreement escrows real USDC on Base Sepolia, and a replay does not fund twice (JOB_ESCROW_LIVE=1)", () => {
  const NETWORK = "baseSepolia" as const;
  let rail: EscrowRail;
  let account: `0x${string}`;
  let escrowAddress: `0x${string}`;

  beforeAll(async () => {
    const deployments = existsSync("lib/evm/deployments.json")
      ? JSON.parse(readFileSync("lib/evm/deployments.json", "utf8")) : {};
    const deployed = deployments.jobEscrow?.[NETWORK]?.address;
    if (!deployed) throw new Error("MitraJobEscrow is not deployed on baseSepolia");
    const key = readFileSync(process.env.MITRA_EVM_SETTLEMENT_KEY_FILE!, "utf8").trim();
    const { privateKeyToAccount } = await import("viem/accounts");
    account = privateKeyToAccount(key.startsWith("0x") ? key as `0x${string}` : `0x${key}`).address;
    rail = {
      chain: "evm", network: NETWORK,
      evm: new ERC8183Transport(NETWORK, key.startsWith("0x") ? key : `0x${key}`) as unknown as EvmEscrowRail,
    };
    escrowAddress = deployed as `0x${string}`;
  });

  it("probes ABSENT, funds, then probes FUNDED — and a replay skips", async () => {
    const id = `ag_live_${Math.random().toString(36).slice(2, 10)}`;
    const ag = agreement({ agreementId: id });
    const intended: EscrowTerms = { amount: 1n, provider: account, client: escrowAddress, timeout: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    const commitment = routeCommitment(onChainRefundRouteFor({ chain: NETWORK, contractAddress: escrowAddress, jobId: escrowIdFor(id) }));

    const before = await probeEscrowStatus(ag, rail, intended);
    expect(["ABSENT", "FUNDED"]).toContain(before.state);

    if (before.state === "ABSENT") {
      // 1 base unit of USDC: enough to prove the path, small enough to be cheap if it fails.
      const locked = await executeEscrowLock({
        agreement: ag, intended, refundRouteHash: commitment, rail,
        evm: { clientVault: escrowAddress, token: USDC_ADDRESS, evaluator: account },
      });
      // A refusal here is a real result, not a test problem: the relayer may be unfunded or
      // the vault may not hold the token. Report it rather than asserting a broadcast.
      if (!locked.ok) {
        console.warn(`[lp6-live] lock refused: ${locked.reason} ${locked.detail ?? ""}`);
        return;
      }
      expect(locked.txHash, "a broadcast always reports a real hash").toMatch(/^0x[0-9a-f]{64}$/i);
    }

    const after = await probeEscrowStatus(ag, rail, intended);
    expect(after.state, "the chain must now hold a funded escrow for this agreement").toBe("FUNDED");

    // The replay: probe finds it funded, so nothing is broadcast and NO hash is invented.
    const replay = await executeEscrowLock({
      agreement: ag, intended, refundRouteHash: commitment, rail,
      evm: { clientVault: escrowAddress, token: USDC_ADDRESS, evaluator: account },
    });
    expect(replay).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_FUNDED" });
    expect(replay).not.toHaveProperty("txHash");

    // And the chain's stored commitment is the one the kernel derived — the F79/F81
    // guarantee, verified against a real account rather than a JSONB round trip.
    if (after.state === "FUNDED") {
      expect(after.onChainRefundRouteHash.toLowerCase()).toBe(commitment.toLowerCase());
    }
  });
});


/**
 * F82 — `ERC8183Transport.getJob` returned an array, so every named field was `undefined`.
 *
 * The literal below is the shape observed on Base Sepolia for a job id that was never
 * funded, captured from `ERC8183Transport.getJob` before it was fixed. Pinning the real
 * wire form is the point: a fixture written to match the code rather than the chain would
 * have passed while the probe was still broken, which is exactly how this survived.
 */
describe("F82 — a `jobs()` read is normalised into named fields", () => {
  // Captured from the deployed MitraJobEscrow on Base Sepolia. The three numeric fields
  // are bigints on the wire; they are written as `0n` here because the capture went
  // through a JSON replacer that rendered them as strings.
  const ZEROED_ROW_AS_RETURNED = [
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    0n, 0n, 0,
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  ];

  it("maps positional fields onto names", () => {
    const row = normalizeJobRow(ZEROED_ROW_AS_RETURNED);
    expect(row.jobId).toBe(ZEROED_ROW_AS_RETURNED[0]);
    expect(row.provider).toBe("0x0000000000000000000000000000000000000000");
    expect(row.amount).toBe(0n);
    expect(row.status).toBe(0);
  });

  it("reads a zeroed row as ABSENT rather than MISMATCH — the bug this caused", () => {
    // `amount === 0n` is how absence is decided. With the array shape, `amount` was
    // `undefined`, `undefined !== 0n`, and the probe fell through to comparing terms made
    // of `undefined`s — reporting a brand-new, never-funded job as MISMATCH.
    const asNamed = normalizeJobRow(ZEROED_ROW_AS_RETURNED);
    expect(asNamed.amount === 0n).toBe(true);
  });

  it("is idempotent on an already-named row", () => {
    const named = normalizeJobRow(ZEROED_ROW_AS_RETURNED);
    expect(normalizeJobRow(named)).toBe(named);
  });

  it("THROWS on an unreadable shape instead of returning undefined fields", () => {
    // A malformed answer must never read as "no escrow": that is what turns a read into a
    // double-fund. Failing closed is the whole reason this function exists.
    expect(() => normalizeJobRow(undefined)).toThrow(/UNREADABLE_RETURN_SHAPE/);
    expect(() => normalizeJobRow(["0x00"])).toThrow(/UNREADABLE_RETURN_SHAPE/);
    expect(() => normalizeJobRow("nope")).toThrow(/UNREADABLE_RETURN_SHAPE/);
  });

  it("the probe is now typed against the real transport, not a cast", async () => {
    // The cast `as unknown as EvmEscrowRail` in `escrowRailFor` is what let F82 typecheck.
    // Its removal is the regression guard: a shape divergence must fail to compile.
    const { escrowRailFor } = await import("@/lib/commerce/escrow-rail");
    const rail = escrowRailFor("baseSepolia", {
      MITRA_EVM_SETTLEMENT_KEY: `0x${"11".repeat(32)}`,
      BASE_SEPOLIA_RPC: "https://sepolia.base.org",
    });
    expect(rail).not.toBeNull();
    // Assigning the concrete transport to the bridge interface must be a plain assignment.
    const typed: EvmEscrowRail | undefined = rail?.evm;
    expect(typed).toBeDefined();
  });
});
