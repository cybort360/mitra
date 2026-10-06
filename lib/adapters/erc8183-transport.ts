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

export type EscrowNetwork = "baseSepolia" | "moderato";

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

const RPC: Record<EscrowNetwork, string | undefined> = {
  baseSepolia: process.env.BASE_SEPOLIA_RPC,
  moderato: process.env.TEMPO_RPC,
};
const FALLBACK_RPC: Record<EscrowNetwork, string> = {
  baseSepolia: "https://sepolia.base.org",
  moderato: "https://rpc.moderato.tempo.xyz",
};

/** Reads deployments.json fresh, so a redeploy is picked up by a long-lived process. */
export function jobEscrowAddress(network: EscrowNetwork): Address {
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

  async getJob(jobId: Hex) {
    return this.public().readContract({
      address: this.address,
      abi: MITRA_JOB_ESCROW_ABI,
      functionName: "jobs",
      args: [jobId],
    });
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
