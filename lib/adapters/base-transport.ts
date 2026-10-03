/**
 * Base transport (PRD Phase 8) — the live half of `BaseSettlementAdapter`.
 *
 * ## A payment is an ERC-20 `transfer` with the commitment appended
 *
 * ERC-20 has no memo field (Tempo's TIP-20 does — see `tempo-transport.ts`). So
 * the 32-byte EIP-712 settlement commitment is appended to the `transfer`
 * calldata. Solidity's ABI decoder ignores trailing bytes, so the token behaves
 * exactly as for a plain transfer; measured on Base Sepolia USDC (`0x036C…CF7e`),
 * the suffixed call returns `true` and costs 522 more gas. The commitment then
 * sits in the transaction input, where anyone holding the hash can read it,
 * rather than only in Mitra's own records.
 *
 * This is an EOA transfer, the smallest settlement that genuinely executes. The
 * ERC-4337 path (`lib/evm/erc4337.ts`, `scripts/base-4337.mjs`) is separate and
 * not wired through this transport.
 *
 * ## Confirmation is decoded logs, never balances
 *
 * `verify` reads the transaction's calldata to learn the intended recipient and
 * amount, requires the commitment suffix, and confirms only if the receipt holds
 * a `Transfer` log from that same registered token, to that recipient, for that
 * exact amount — the same rule as Tempo, so the two rails agree on what
 * "confirmed" means.
 */

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  sliceHex,
  size,
  type Hex,
  type LocalAccount,
  type Transport,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { BASE_ASSETS, type BaseChainId, type BaseTransport, type Erc20Asset } from "./base";

const CHAINS = { 8453: base, 84532: baseSepolia } as const;

/** ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** selector (4) + address word (32) + amount word (32) */
const TRANSFER_CALLDATA_BYTES = 68;

export interface BaseRpcTransportOptions {
  /** Signs locally. Only the signed transaction leaves the process. */
  account: LocalAccount;
  chainId: BaseChainId;
  /** A viem transport. Defaults to `http()` against the chain's public RPC, with viem's retry on 429. */
  transport?: Transport;
}

export class BaseRpcTransport implements BaseTransport {
  private readonly chain;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly opts: BaseRpcTransportOptions) {
    this.chain = CHAINS[opts.chainId];
    if (!this.chain) throw new Error(`UNSUPPORTED_BASE_CHAIN: ${opts.chainId}`);
    const transport = opts.transport ?? http();
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = createWalletClient({ chain: this.chain, transport, account: opts.account });
  }

  async send(input: {
    to: `0x${string}`;
    amountAtomic: string;
    asset: Erc20Asset | null;
    chainId: BaseChainId;
    data: string;
  }): Promise<{ txHash: `0x${string}` }> {
    // Every refusal happens before anything is signed.
    if (input.chainId !== this.opts.chainId) throw new Error(`CHAIN_MISMATCH: transport is ${this.opts.chainId}, settlement is ${input.chainId}`);
    if (!input.asset) throw new Error("NATIVE_SETTLEMENT_NOT_SUPPORTED");
    const registered = BASE_ASSETS[this.opts.chainId][input.asset.symbol];
    if (!registered || registered.address.toLowerCase() !== input.asset.address.toLowerCase()) {
      throw new Error("UNREGISTERED_ERC20_FOR_CHAIN");
    }
    if (!EVM_ADDRESS.test(input.to)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("INVALID_ATOMIC_AMOUNT");
    // Exactly 32 bytes, so the suffix boundary is unambiguous when verify reads it back.
    if (!BYTES32.test(input.data)) throw new Error("COMMITMENT_NOT_BYTES32");

    // Asked of the node, not assumed from configuration: a signed transfer is valid
    // on any chain with the id it was signed for.
    const reported = await this.publicClient.getChainId();
    if (reported !== this.opts.chainId) throw new Error(`CHAIN_MISMATCH: expected ${this.opts.chainId}, node reports ${reported}`);

    const data = concatHex([
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.to, BigInt(input.amountAtomic)] }),
      input.data as Hex,
    ]);
    const txHash = await this.walletClient.sendTransaction({
      account: this.opts.account,
      chain: this.chain,
      to: registered.address,
      data,
      value: 0n,
    });
    return { txHash };
  }

  async verify(txHash: string, chainId: BaseChainId): Promise<{ confirmed: boolean }> {
    if (chainId !== this.opts.chainId || !BYTES32.test(txHash)) return { confirmed: false };
    const hash = txHash as Hex;

    let receipt;
    let tx;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
      tx = await this.publicClient.getTransaction({ hash });
    } catch {
      // Not found is "not confirmed", not an error the settlement record should carry.
      return { confirmed: false };
    }
    if (receipt.status !== "success") return { confirmed: false };

    const tokens = new Set(Object.values(BASE_ASSETS[this.opts.chainId]).map((a) => a.address.toLowerCase()));
    if (!tx.to || !tokens.has(tx.to.toLowerCase())) return { confirmed: false };
    if (tx.value !== 0n) return { confirmed: false };

    // A transfer without the commitment suffix is not a Mitra settlement, even if
    // it moved the right amount to the right place.
    if (size(tx.input) !== TRANSFER_CALLDATA_BYTES + 32) return { confirmed: false };
    let intent: { to: string; amount: bigint };
    try {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: sliceHex(tx.input, 0, TRANSFER_CALLDATA_BYTES) });
      if (functionName !== "transfer") return { confirmed: false };
      intent = { to: args[0].toLowerCase(), amount: args[1] };
    } catch {
      return { confirmed: false };
    }

    const token = tx.to.toLowerCase();
    const delivered = receipt.logs.some(
      (l) =>
        l.address.toLowerCase() === token &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        l.topics.length === 3 &&
        `0x${l.topics[2]!.slice(-40)}`.toLowerCase() === intent.to &&
        BigInt(l.data) === intent.amount,
    );
    return { confirmed: delivered };
  }
}

/** The commitment a confirmed Base settlement carries, read back from its calldata. */
export function commitmentFromCalldata(input: Hex): Hex | null {
  if (size(input) !== TRANSFER_CALLDATA_BYTES + 32) return null;
  return sliceHex(input, TRANSFER_CALLDATA_BYTES);
}
