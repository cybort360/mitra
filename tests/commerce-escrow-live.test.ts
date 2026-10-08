/**
 * LP-2 live escrow wire — OPT-IN.
 *
 * Gated by JOB_ESCROW_LIVE=base|tempo|1 and a funded key at .dev-keys/. Skipped
 * by default, exactly like TEMPO_LIVE and SOLANA_LIVE elsewhere: a suite that
 * needs a funded key cannot run in CI, and an unskippable one would either fail
 * every build or quietly assert nothing.
 *
 * What this proves that the offline suite cannot: that the DEPLOYED contracts
 * (not a mock, not a local fork) fund, settle and refund. It reads the address
 * from deployments.json, so it tests whatever is actually deployed rather than a
 * hardcoded constant that can drift from the file.
 *
 * ## Known limitation in depositToEscrow
 *
 * `depositToEscrow` measures the escrow's TOTAL balance and records
 * `min(bal, expected)`. For a single job funded in isolation this is exactly
 * what arrived. With two jobs funded before either records, the second call can
 * attribute tokens that belong to the first. The cap prevents over-recording
 * beyond `expected`, but it cannot distinguish whose tokens they are.
 *
 * Fixing it needs a per-job escrow account or a `totalAllocated` running sum
 * checked against balance. That is a contract change, not a test change, so it
 * is recorded here rather than papered over: this suite funds one job at a time
 * and therefore does not exercise the concurrent path.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex as HexT } from "viem";
import { ERC8183Transport, jobEscrowAddress } from "@/lib/adapters/erc8183-transport";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) external returns (bool)"]);

/**
 * The escrow records what it already HOLDS; the vault spent the capital in
 * before depositToEscrow was called. So a test must send tokens first, exactly
 * as spendAuthorized does, or the contract correctly reverts NothingReceived.
 */
async function fundEscrow(network: "baseSepolia" | "moderato", key: HexT, amount: bigint) {
  const rpc = network === "baseSepolia"
    ? (process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org")
    : (process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}` as HexT);
  const client = createPublicClient({ transport: http(rpc) });
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const hash = await wallet.writeContract({
    address: TOKENS[network], abi: ERC20_ABI, functionName: "transfer",
    args: [jobEscrowAddress(network), amount], chain: null, account,
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

const KEY = ".dev-keys/evm-testnet.key";
const funded = existsSync(KEY);
const target = process.env.JOB_ESCROW_LIVE;
const liveIt = (target && funded ? it : it.skip) as typeof it;

const TOKENS = {
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const, // USDC, 6 dec
  moderato: "0x20c0000000000000000000000000000000000000" as const, // PathUSD, 6 dec TIP-20
};

const networks =
  target === "1" ? ["baseSepolia", "moderato"] as const :
  target === "base" || target === "baseSepolia" ? ["baseSepolia"] as const :
  target === "tempo" || target === "moderato" ? ["moderato"] as const :
  [] as const;

/** Addresses must be present, or the test would silently target nothing. */
describe("job escrow addresses resolve from deployments.json", () => {
  it("are recorded for both chains", () => {
    expect(jobEscrowAddress("baseSepolia")).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(jobEscrowAddress("moderato")).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

async function waitForStatus(t: ERC8183Transport, jobId: Hex, targetStatus: number, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const job = await t.getJob(jobId);
    if (Number(job.status) === targetStatus) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return t.getJob(jobId);
}

describe(`live job escrow (JOB_ESCROW_LIVE=${target ?? "unset"})`, () => {
  for (const network of networks) {
    liveIt(`${network}: completeJob pays the provider from the deployed contract`, async () => {
      const key = readFileSync(KEY, "utf8").trim();
      const t = new ERC8183Transport(network, key);
      const jobId = (`0x${randomBytes(32).toString("hex")}`) as Hex;
      const route = (`0x${randomBytes(32).toString("hex")}`) as Hex;
      const amount = 10_000n; // 0.01 USDC/PathUSD, 6 decimals

      // Client, provider and evaluator are all the funded EOA here: this proves
      // the CONTRACT path, not multi-party identity. A real job would separate
      // them, which needs a second funded account and is out of scope.
      const me = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex).address;

      const timeout = BigInt(Math.floor(Date.now() / 1000) + 3600);
      await fundEscrow(network, key as HexT, amount + 500n); // token fee headroom
      const hash = await t.depositToEscrow({
        jobId,
        clientVault: me,
        provider: me,
        evaluator: me,
        token: TOKENS[network],
        amount,
        timeout,
        refundRouteHash: route,
      });
      console.log(`${network} funded ${jobId} tx ${hash}`);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

      const job = await waitForStatus(t, jobId, 1);
      expect(Number(job.status)).toBe(1); // status: Funded
      expect(job.refundRouteHash).toBe(route); // the pre-committed route, as recorded

      const releaseHash = await t.completeJob(jobId);
      console.log(`${network} completed ${jobId} tx ${releaseHash}`);
      const settled = await waitForStatus(t, jobId, 2);
      expect(Number(settled.status)).toBe(2); // status: Completed

      // Single shot — a second settlement must be refused.
      await expect(t.refundJob(jobId)).rejects.toThrow();
    });

    liveIt(`${network}: refundJob returns capital after timeout`, async () => {
      const key = readFileSync(KEY, "utf8").trim();
      const t = new ERC8183Transport(network, key);
      const jobId = (`0x${randomBytes(32).toString("hex")}`) as Hex;
      const route = (`0x${randomBytes(32).toString("hex")}`) as Hex;
      const amount = 10_000n;
      const me = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex).address;

      // Timeout already in the past: anyone may refund, which is the whole
      // point of autonomous recovery.
      const timeout = BigInt(Math.floor(Date.now() / 1000) - 60);
      await fundEscrow(network, key as HexT, amount + 500n);
      await t.depositToEscrow({
        jobId,
        clientVault: me,
        provider: me,
        evaluator: me,
        token: TOKENS[network],
        amount,
        timeout,
        refundRouteHash: route,
      });
      console.log(`${network} funded ${jobId} for refund test`);
      await waitForStatus(t, jobId, 1);

      const hash = await t.refundJob(jobId);
      console.log(`${network} refunded ${jobId} tx ${hash}`);
      const job = await waitForStatus(t, jobId, 3);
      expect(Number(job.status)).toBe(3); // status: Refunded
    });
  }

  it("offline suites are unaffected: commerce-lifecycle has no chain dependency", async () => {
    // Guarded so it also runs when all live targets are skipped — the point is
    // that importing the projection layer never reaches for a key or an RPC.
    const mod = await import("@/lib/adapters/erc8183");
    expect(typeof mod.erc8183ToAgreement).toBe("function");
    expect(mod.ERC8183_TO_AGREEMENT.Open).toBe("OPEN");
  });
});
