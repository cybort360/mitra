/**
 * EVM Commercial Escrow Adapter (PRD §15, ADR-0012).
 *
 * Interacts with MitraVault.sol's commercial escrow primitives:
 * - lockEscrow: moves available -> escrowed
 * - releaseEscrow: moves escrowed -> total (leaves vault to provider)
 * - refundEscrow: moves escrowed -> available (returns to buyer after timeout/failure)
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export const MITRA_VAULT_ESCROW_ABI = parseAbi([
  "function lockEscrow(bytes32 jobId, address provider, address token, uint256 amount, uint64 timeout) external",
  "function releaseEscrow(bytes32 jobId) external",
  "function refundEscrow(bytes32 jobId) external",
  "function escrows(bytes32 jobId) external view returns (address client, address provider, address token, uint256 amount, uint64 timeout, bool completed, bool refunded)",
  "function vaults(address principal, address token) external view returns (uint256 total, uint256 available, uint256 reserved, uint256 escrowed, uint256 encumbered, uint256 settling, bool emergencyFreeze)",
  "event EscrowLocked(bytes32 indexed jobId, address indexed client, address indexed provider, address token, uint256 amount, uint64 timeout)",
  "event EscrowReleased(bytes32 indexed jobId, address indexed provider, uint256 amount)",
  "event EscrowRefunded(bytes32 indexed jobId, address indexed client, uint256 amount)",
]);

export interface EscrowJobDetails {
  client: Address;
  provider: Address;
  token: Address;
  amount: bigint;
  timeout: bigint;
  completed: boolean;
  refunded: boolean;
}

export interface VaultPositions {
  total: bigint;
  available: bigint;
  reserved: bigint;
  escrowed: bigint;
  encumbered: bigint;
  settling: bigint;
  emergencyFreeze: boolean;
}

/**
 * Derives a deterministic bytes32 jobId for a commercial escrow.
 */
export function deriveJobId(
  agreementId: string,
  runId: string,
  client: Address,
  provider: Address,
  amount: bigint,
  timeout: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
      ],
      [agreementId, runId, client, provider, amount, timeout],
    ),
  );
}

export interface EscrowClientOptions {
  vaultAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  chain?: any;
}

export class EvmEscrowAdapter {
  readonly vaultAddress: Address;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly chain?: any;

  constructor(opts: EscrowClientOptions) {
    this.vaultAddress = opts.vaultAddress;
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.chain = opts.chain ?? opts.walletClient?.chain ?? null;
  }

  async getEscrow(jobId: Hex): Promise<EscrowJobDetails> {
    const res = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: MITRA_VAULT_ESCROW_ABI,
      functionName: "escrows",
      args: [jobId],
    });
    const [client, provider, token, amount, timeout, completed, refunded] = res;
    return { client, provider, token, amount, timeout, completed, refunded };
  }

  async getVaultPositions(principal: Address, token: Address): Promise<VaultPositions> {
    const res = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: MITRA_VAULT_ESCROW_ABI,
      functionName: "vaults",
      args: [principal, token],
    });
    const [total, available, reserved, escrowed, encumbered, settling, emergencyFreeze] = res;
    return { total, available, reserved, escrowed, encumbered, settling, emergencyFreeze };
  }

  async lockEscrow(
    jobId: Hex,
    provider: Address,
    token: Address,
    amount: bigint,
    timeout: bigint,
  ): Promise<{ txHash: Hex; blockNumber: bigint }> {
    if (!this.walletClient) throw new Error("WALLET_CLIENT_REQUIRED_FOR_LOCK_ESCROW");
    const hash = await (this.walletClient.writeContract as any)({
      address: this.vaultAddress,
      abi: MITRA_VAULT_ESCROW_ABI,
      functionName: "lockEscrow",
      args: [jobId, provider, token, amount, timeout],
      chain: this.chain,
      account: this.walletClient.account,
    });
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`LOCK_ESCROW_REVERTED: tx ${hash}`);
    return { txHash: hash, blockNumber: rc.blockNumber };
  }

  async releaseEscrow(jobId: Hex): Promise<{ txHash: Hex; blockNumber: bigint }> {
    if (!this.walletClient) throw new Error("WALLET_CLIENT_REQUIRED_FOR_RELEASE_ESCROW");
    const hash = await (this.walletClient.writeContract as any)({
      address: this.vaultAddress,
      abi: MITRA_VAULT_ESCROW_ABI,
      functionName: "releaseEscrow",
      args: [jobId],
      chain: this.chain,
      account: this.walletClient.account,
    });
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`RELEASE_ESCROW_REVERTED: tx ${hash}`);
    return { txHash: hash, blockNumber: rc.blockNumber };
  }

  async refundEscrow(jobId: Hex): Promise<{ txHash: Hex; blockNumber: bigint }> {
    if (!this.walletClient) throw new Error("WALLET_CLIENT_REQUIRED_FOR_REFUND_ESCROW");
    const hash = await (this.walletClient.writeContract as any)({
      address: this.vaultAddress,
      abi: MITRA_VAULT_ESCROW_ABI,
      functionName: "refundEscrow",
      args: [jobId],
      chain: this.chain,
      account: this.walletClient.account,
    });
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`REFUND_ESCROW_REVERTED: tx ${hash}`);
    return { txHash: hash, blockNumber: rc.blockNumber };
  }
}
