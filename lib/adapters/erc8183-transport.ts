/**
 * Live on-chain transport for the ERC-8183 job escrow (LP-2 wire).
 *
 * ## Why this is a separate module from `erc8183.ts`
 *
 * `erc8183.ts` is a pure projection: it maps job state to Mitra agreement state
 * and back, and it is testable with no network, no key and no deployments.json.
 * Merging the two would make every offline suite depend on a filesystem file and
 * an RPC url to test a function that has nothing to do with either — which is how
 * a projection layer ends up covered only by tests that need a funded key, and
 * therefore skipped.
 *
 * So: projection stays pure, transport carries the chain.
 *
 * ## Address resolution
 *
 * Addresses are read from `lib/evm/deployments.json` at CALL time, not module
 * load time. Reading at import would make `require`ing this module fail when the
 * file is absent (fresh clone, partial checkout), and would bake a stale address
 * into any process that imported before a redeploy. A live test that picks up
 * the address it actually deployed is also self-consistent after a revision bump.
 *
 * ## The deployment commit
 *
 * `refundJob` requires a non-zero `refundRouteHash` (PRD §15.5). The transport
 * takes it as an argument and refuses to synthesize a default — a default would
 * be exactly the post-failure calldata the rule exists to prevent.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const MITRA_JOB_ESCROW_ABI = parseAbi([
  "function depositToEscrow(bytes32 jobId, address clientVault, address provider, address evaluator, address token, uint256 expected, uint64 timeout, bytes32 refundRouteHash) external returns (uint256 received)",
  "function completeJob(bytes32 jobId) external",
  "function refundJob(bytes32 jobId) external",
  "function jobs(bytes32 jobId) external view returns (bytes32 jobId, address clientVault, address provider, address evaluator, address token, uint256 amount, uint64 timeout, uint8 status, bytes32 refundRouteHash)",
  "event JobFunded(bytes32 indexed jobId, address indexed clientVault, address indexed provider, uint256 received, bytes32 refundRouteHash)",
  "event JobCompleted(bytes32 indexed jobId, address indexed provider, uint256 amount)",
  "event JobRefunded(bytes32 indexed jobId, address indexed clientVault, uint256 amount)",
]);

/**
 * `local` is a throwaway chain (anvil) for the PP-7 sandbox. It has no entry in
 * deployments.json and no fallback RPC: its RPC and escrow address come only from
 * MITRA_LOCAL_EVM_RPC and MITRA_LOCAL_JOB_ESCROW, so an unset variable is an error
 * rather than a silent hop to a public network.
 */
export type EscrowNetwork = "baseSepolia" | "moderato" | "local";
type PublicNetwork = Exclude<EscrowNetwork, "local">;

/** The shape of one `Job` struct, as `jobs()` returns it. */
export interface JobRow {
  jobId: Hex;
  clientVault: Address;
  provider: Address;
  evaluator: Address;
  token: Address;
  amount: bigint;
  timeout: bigint;
  status: number;
  refundRouteHash: Hex;
}

/**
 * Maps a `jobs()` return into named fields. F82.
 *
 * Accepts an already-named object so the function is idempotent, and **throws** on a shape
 * it does not recognise rather than returning `undefined` fields — an unreadable answer
 * must not be mistaken for "no escrow", because that is what turns a read into a
 * double-fund.
 */
export function normalizeJobRow(raw: unknown): JobRow {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "amount" in raw) {
    return raw as JobRow;
  }
  if (!Array.isArray(raw) || raw.length < 9) {
    throw new Error(`MitraJobEscrow.jobs: UNREADABLE_RETURN_SHAPE (${typeof raw}, ${Array.isArray(raw) ? `length ${raw.length}` : "not an array"})`);
  }
  const [jobId, clientVault, provider, evaluator, token, amount, timeout, status, refundRouteHash] = raw;
  return {
    jobId: jobId as Hex,
    clientVault: clientVault as Address,
    provider: provider as Address,
    evaluator: evaluator as Address,
    token: token as Address,
    amount: amount as bigint,
    timeout: timeout as bigint,
    status: Number(status),
    refundRouteHash: refundRouteHash as Hex,
  };
}

export interface EscrowJob {
  jobId: Hex;
  clientVault: Address;
  provider: Address;
  evaluator: Address;
  token: Address;
  amount: bigint;
  timeout: bigint;
  /** PRD §15.5 — must be supplied by the caller, never defaulted. */
  refundRouteHash: Hex;
}

const RPC: Record<PublicNetwork, string | undefined> = {
  baseSepolia: process.env.BASE_SEPOLIA_RPC,
  moderato: process.env.TEMPO_RPC,
};
const FALLBACK_RPC: Record<PublicNetwork, string> = {
  baseSepolia: "https://sepolia.base.org",
  moderato: "https://rpc.moderato.tempo.xyz",
};

/** Reads deployments.json fresh, so a redeploy is picked up by a long-lived process. */
export function jobEscrowAddress(network: EscrowNetwork): Address {
  if (network === "local") {
    const addr = process.env.MITRA_LOCAL_JOB_ESCROW;
    if (!addr) throw new Error("jobEscrow.local: MITRA_LOCAL_JOB_ESCROW is not set");
    return addr as Address;
  }
  const raw = readFileSync("lib/evm/deployments.json", "utf8");
  const db = JSON.parse(raw) as { jobEscrow?: Partial<Record<EscrowNetwork, { address?: string }>> };
  const addr = db.jobEscrow?.[network]?.address;
  if (!addr) throw new Error(`jobEscrow.${network} not present in lib/evm/deployments.json — deploy first`);
  return addr as Address;
}

export class ERC8183Transport {
  constructor(
    private readonly network: EscrowNetwork,
    private readonly accountKey?: string,
  ) {}

  private get url() {
    if (this.network === "local") {
      const url = process.env.MITRA_LOCAL_EVM_RPC;
      if (!url) throw new Error("ERC8183Transport.local: MITRA_LOCAL_EVM_RPC is not set");
      return url;
    }
    return RPC[this.network] ?? FALLBACK_RPC[this.network];
  }
  get address(): Address {
    return jobEscrowAddress(this.network);
  }

  private public() {
    return createPublicClient({ transport: http(this.url) });
  }

  /**
   * Records a job that the vault has already funded.
   *
   * `expected` is what the caller believes was sent; the contract records what
   * arrived. The distinction matters for fee-on-transfer tokens and is why this
   * does not simply assume `amount`.
   */
  async depositToEscrow(job: EscrowJob): Promise<Hex> {
    const { wallet } = this.signer();
    const hash = await wallet.writeContract({
      address: this.address,
      abi: MITRA_JOB_ESCROW_ABI,
      functionName: "depositToEscrow",
      args: [
        job.jobId,
        job.clientVault,
        job.provider,
        job.evaluator,
        job.token,
        job.amount,
        job.timeout,
        job.refundRouteHash,
      ],
      chain: null,
      account: wallet.account!,
    });
    return this.waitFor(hash);
  }

  /** Client or evaluator releases to the provider. */
  async completeJob(jobId: Hex): Promise<Hex> {
    const { wallet } = this.signer();
    const hash = await wallet.writeContract({
      address: this.address,
      abi: MITRA_JOB_ESCROW_ABI,
      functionName: "completeJob",
      args: [jobId],
      chain: null,
      account: wallet.account!,
    });
    return this.waitFor(hash);
  }

  /** Anyone after `timeout`; the client or evaluator before it. */
  async refundJob(jobId: Hex): Promise<Hex> {
    const { wallet } = this.signer();
    const hash = await wallet.writeContract({
      address: this.address,
      abi: MITRA_JOB_ESCROW_ABI,
      functionName: "refundJob",
      args: [jobId],
      chain: null,
      account: wallet.account!,
    });
    return this.waitFor(hash);
  }

  /**
   * The on-chain job record, or the zeroed record for a job that was never funded.
   *
   * ## Why the normalisation (F82)
   *
   * `jobs(...)` declares its return as a FLAT list — `returns (bytes32 jobId, address
   * clientVault, ...)`. viem therefore hands back an **array indexed 0..8**, not an object
   * with those names, so every named access (`job.amount`, `job.status`) was `undefined`.
   *
   * That went unnoticed because the function had no callers: nothing exercised it against
   * a deployed contract. It type-checked, because its inferred return type was
   * `readonly [Hex, Address, ...]` and every *caller* cast its way to whatever shape it
   * wanted — `as unknown as EvmEscrowRail` in particular, which hid the whole thing.
   *
   * LP-6 made this the first thing that reads `getJob` before it moves capital, and the
   * live suite immediately reported `MISMATCH` on a job id that had never been funded: the
   * probe saw `amount === undefined`, which is not `0n`, so it fell through to comparing
   * terms made of `undefined`s. **A probe that cannot tell "no escrow" from "malformed
   * answer" is not a safety mechanism.**
   *
   * The mapping is written out rather than relying on viem naming, and
   * `normalizeJobRow` is exported and tested against the exact wire shape observed on
   * Base Sepolia so it cannot silently regress again.
   */
  async getJob(jobId: Hex) {
    const raw: unknown = await this.public().readContract({
      address: this.address,
      abi: MITRA_JOB_ESCROW_ABI,
      functionName: "jobs",
      args: [jobId],
    });
    return normalizeJobRow(raw);
  }

  private signer() {
    if (!this.accountKey) {
      throw new Error(`ERC8183Transport.${this.network}: no signing key supplied — offline suites must not reach here`);
    }
    const account = privateKeyToAccount(
      this.accountKey.startsWith("0x") ? (this.accountKey as Hex) : (`0x${this.accountKey}` as Hex),
    );
    return {
      account,
      wallet: createWalletClient({ account, transport: http(this.url) }),
    };
  }

  private async waitFor(hash: Hex): Promise<Hex> {
    const rc = await this.public().waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`escrow tx reverted: ${hash}`);
    return hash;
  }
}
