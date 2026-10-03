/**
 * Base ERC-4337 transport (PRD Phase 8; sprint item 3) — settlement from a SMART
 * ACCOUNT, executed by the real EntryPoint.
 *
 * The lead's seq 55: "For production Phase 8, this transitions to ERC-4337 smart
 * accounts where the server only packages UserOperations and pre-authorized EIP-712
 * payloads. The server is an execution relayer, never naked root authority."
 *
 * ## What is sent
 *
 * The payer is a Coinbase Smart Wallet (v1, factory `0x0BA5ED0c…`, EntryPoint v0.6
 * `0x5FF137D4…`), built with viem's `toCoinbaseSmartAccount`, so the account
 * address, init code, call encoding and UserOperation signature are viem's, not
 * hand-rolled. (`lib/evm/erc4337.ts` hashes a UserOperation without the EntryPoint
 * and chain id, which is not the hash any EntryPoint checks — see FAILURES F54.)
 *
 * The call is the same ERC-20 `transfer` with the 32-byte settlement commitment
 * appended that `BaseRpcTransport` sends, wrapped in the account's
 * `execute(token, 0, data)`. So the commitment is on chain, inside the
 * UserOperation's calldata inside `handleOps`.
 *
 * The relayer EOA submits `handleOps` and is reimbursed by the EntryPoint from the
 * account's own deposit/balance. It never holds the payer's funds or key authority
 * over them: the UserOperation is signed by the account's OWNER key, and the
 * account, not the relayer, is debited.
 *
 * ## What counts as confirmed — and the trap
 *
 * `handleOps` SUCCEEDS even when the UserOperation inside it reverts: the EntryPoint
 * catches the inner failure, charges gas, and emits `UserOperationEvent` with
 * `success = false`. A receipt with `status: success` therefore proves nothing about
 * the payment. Confirmation requires, in one transaction: a `UserOperationEvent` for
 * THIS account with `success = true`, and a token `Transfer` FROM the account to the
 * recipient for the exact amount the inner calldata names.
 */

import {
  concatHex, createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData,
  erc20Abi, http, parseAbi, size, sliceHex, type Hex, type LocalAccount, type PublicClient, type Transport,
} from "viem";
import { baseSepolia } from "viem/chains";
import { entryPoint06Abi, entryPoint06Address, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { BASE_ASSETS, type BaseChainId, type BaseTransport, type Erc20Asset } from "./base";
import type { ChainObservation } from "./types";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** 4-byte selector + two 32-byte words. */
const TRANSFER_CALLDATA_BYTES = 68;

/** The smart account's call surface (Coinbase Smart Wallet). */
export const SMART_ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

export interface Erc4337TransportOptions {
  /** Owns the smart account and signs its UserOperations. */
  owner: LocalAccount;
  /** Submits `handleOps` and pays its gas; reimbursed by the EntryPoint. May be the owner key on testnet. */
  relayer: LocalAccount;
  chainId: BaseChainId;
  transport?: Transport;
  /** Distinguishes several accounts under one owner. Part of the account address. */
  accountNonce?: bigint;
}

type Gas = { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };

export class Erc4337Transport implements BaseTransport {
  private readonly publicClient: PublicClient;
  private readonly walletClient;
  private accountPromise?: ReturnType<typeof toCoinbaseSmartAccount>;

  constructor(private readonly opts: Erc4337TransportOptions) {
    if (opts.chainId !== 84532) throw new Error(`UNSUPPORTED_BASE_CHAIN_FOR_4337: ${opts.chainId}`);
    const transport = opts.transport ?? http();
    this.publicClient = createPublicClient({ chain: baseSepolia, transport }) as PublicClient;
    this.walletClient = createWalletClient({ chain: baseSepolia, transport, account: opts.relayer });
  }

  /** The smart account; its address is the rail's payer. */
  account() {
    this.accountPromise ??= toCoinbaseSmartAccount({
      client: this.publicClient,
      owners: [this.opts.owner],
      version: "1",
      ...(this.opts.accountNonce !== undefined ? { nonce: this.opts.accountNonce } : {}),
    });
    return this.accountPromise;
  }

  async send(input: {
    to: `0x${string}`;
    amountAtomic: string;
    asset: Erc20Asset | null;
    chainId: BaseChainId;
    data: string;
  }): Promise<{ txHash: `0x${string}` }> {
    // The same refusals as the EOA transport, all before anything is signed.
    if (input.chainId !== this.opts.chainId) throw new Error(`CHAIN_MISMATCH: transport is ${this.opts.chainId}, settlement is ${input.chainId}`);
    if (!input.asset) throw new Error("NATIVE_SETTLEMENT_NOT_SUPPORTED");
    const registered = BASE_ASSETS[this.opts.chainId][input.asset.symbol];
    if (!registered || registered.address.toLowerCase() !== input.asset.address.toLowerCase()) {
      throw new Error("UNREGISTERED_ERC20_FOR_CHAIN");
    }
    if (!EVM_ADDRESS.test(input.to)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("INVALID_ATOMIC_AMOUNT");
    if (!BYTES32.test(input.data)) throw new Error("COMMITMENT_NOT_BYTES32");
    const reported = await this.publicClient.getChainId();
    if (reported !== this.opts.chainId) throw new Error(`CHAIN_MISMATCH: expected ${this.opts.chainId}, node reports ${reported}`);

    const account = await this.account();
    const inner = concatHex([
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.to, BigInt(input.amountAtomic)] }),
      input.data as Hex,
    ]);
    const callData = await account.encodeCalls([{ to: registered.address, value: 0n, data: inner }]);
    const deployed = await account.isDeployed();
    const { factory, factoryData } = await account.getFactoryArgs();
    const initCode: Hex = deployed || !factory || !factoryData ? "0x" : concatHex([factory, factoryData]);
    const fees = await this.publicClient.estimateFeesPerGas();
    const gas: Gas = {
      callGasLimit: 150_000n,
      // Deployment runs inside validation when initCode is present.
      verificationGasLimit: initCode === "0x" ? 300_000n : 1_000_000n,
      preVerificationGas: 60_000n,
    };
    const unsigned = {
      sender: account.address,
      nonce: await account.getNonce(),
      initCode,
      callData,
      ...gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };
    const signature = await account.signUserOperation({ ...unsigned, chainId: this.opts.chainId });

    const txHash = await this.walletClient.writeContract({
      address: entryPoint06Address,
      abi: entryPoint06Abi,
      functionName: "handleOps",
      args: [[{ ...unsigned, signature }], this.opts.relayer.address],
      chain: baseSepolia,
      account: this.opts.relayer,
    });
    return { txHash };
  }

  async verify(txHash: string, chainId: BaseChainId): Promise<{ confirmed: boolean }> {
    return { confirmed: (await this.observe(txHash, chainId)) !== null };
  }

  async observe(txHash: string, chainId: BaseChainId): Promise<ChainObservation | null> {
    if (chainId !== this.opts.chainId || !BYTES32.test(txHash)) return null;
    let receipt;
    let tx;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
      tx = await this.publicClient.getTransaction({ hash: txHash as Hex });
    } catch {
      return null;
    }
    const account = await this.account();
    return observeSmartAccountSettlement({
      txHash, account: account.address, chainId: this.opts.chainId,
      tx: { to: tx.to ?? null, input: tx.input },
      receipt: { status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs },
    });
  }
}

/**
 * The pure half of `observe`, so the confirmation rule is testable without a node.
 * Returns null for anything short of a confirmed settlement by `account`.
 */
export function observeSmartAccountSettlement(input: {
  txHash: string;
  account: `0x${string}`;
  chainId: BaseChainId;
  tx: { to: string | null; input: Hex };
  receipt: { status: "success" | "reverted"; blockNumber: bigint; logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }> };
}): ChainObservation | null {
  const { tx, receipt } = input;
  const me = input.account.toLowerCase();
  if (receipt.status !== "success") return null;
  if (!tx.to || tx.to.toLowerCase() !== entryPoint06Address.toLowerCase()) return null;

  // The UserOperation this account sent, from the handleOps calldata.
  let op: { sender: string; callData: Hex } | undefined;
  try {
    const { functionName, args } = decodeFunctionData({ abi: entryPoint06Abi, data: tx.input });
    if (functionName !== "handleOps") return null;
    op = (args[0] as ReadonlyArray<{ sender: string; callData: Hex }>).find((o) => o.sender.toLowerCase() === me);
  } catch {
    return null;
  }
  if (!op) return null;

  // The inner op must have SUCCEEDED; handleOps succeeding is not enough.
  const succeeded = receipt.logs.some((l) => {
    if (l.address.toLowerCase() !== entryPoint06Address.toLowerCase()) return false;
    try {
      const ev = decodeEventLog({ abi: entryPoint06Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return ev.eventName === "UserOperationEvent" && ev.args.sender.toLowerCase() === me && ev.args.success === true;
    } catch {
      return false;
    }
  });
  if (!succeeded) return null;

  // The account's call: execute(token, 0, transfer(to, amount) ++ commitment).
  let token: string;
  let inner: Hex;
  try {
    const { functionName, args } = decodeFunctionData({ abi: SMART_ACCOUNT_ABI, data: op.callData });
    if (functionName !== "execute" || args[1] !== 0n) return null;
    token = args[0].toLowerCase();
    inner = args[2];
  } catch {
    return null;
  }
  const tokens = new Set(Object.values(BASE_ASSETS[input.chainId]).map((a) => a.address.toLowerCase()));
  if (!tokens.has(token)) return null;
  if (size(inner) !== TRANSFER_CALLDATA_BYTES + 32) return null;
  let intent: { to: string; amount: bigint };
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: sliceHex(inner, 0, TRANSFER_CALLDATA_BYTES) });
    if (functionName !== "transfer") return null;
    intent = { to: args[0].toLowerCase(), amount: args[1] };
  } catch {
    return null;
  }

  const topicAddr = (t: Hex | undefined) => (t ? `0x${t.slice(-40)}`.toLowerCase() : "");
  const delivered = receipt.logs.some(
    (l) =>
      l.address.toLowerCase() === token &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics.length === 3 &&
      topicAddr(l.topics[1]) === me &&
      topicAddr(l.topics[2]) === intent.to &&
      BigInt(l.data) === intent.amount,
  );
  if (!delivered) return null;
  return {
    txHash: input.txHash,
    block: Number(receipt.blockNumber),
    carriedCommitment: sliceHex(inner, TRANSFER_CALLDATA_BYTES),
    from: me,
    to: intent.to,
    amountAtomic: intent.amount,
    asset: token,
  };
}
