/**
 * Settlement THROUGH `contracts/src/MitraVault.sol` (the lead's package B.4) — the EVM
 * counterpart of the Solana `VaultTransport`.
 *
 * Before this, Base and Tempo settled from a key (EOA) or a smart account: the
 * deployed vault contract enforced nothing on any Mitra payment. Here the capital sits
 * in the contract, and a payment is `spendAuthorized`: the mandate's engine signs an
 * EIP-712 permit whose `actionHash` is Mitra's settlement commitment, binding principal,
 * holder, token, amount and recipient; a relayer submits it; the contract re-checks the
 * engine, the mandate's limit, ceiling, version, expiry and revocation, single use, and
 * the principal's freeze — and only then moves tokens.
 *
 * ## Whose money
 *
 * The payer named in the settlement (and in its commitment, and on the Mitra vault
 * record) is the PRINCIPAL whose position pays. The tokens physically leave the vault
 * contract; the observation therefore requires both the contract's `SpendExecuted` for
 * this principal and a token `Transfer` from the contract to the recipient.
 *
 * ## What counts as confirmed
 *
 * A successful transaction to the vault contract, containing `SpendExecuted(principal,
 * holder, recipient, token, amount, actionHash, version)` for this transport's principal
 * and holder, and a token `Transfer` from the vault to that recipient for that amount.
 */

import {
  createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseAbi,
  type Chain as ViemChain, type Hex, type LocalAccount, type PublicClient, type Transport,
} from "viem";
import type { ChainObservation } from "./types";
import type { BaseChainId, BaseTransport, Erc20Asset } from "./base";
import type { TempoTransport } from "./tempo";

export const MITRA_VAULT_ABI = parseAbi([
  "function mandates(address principal, address holder) view returns (address engine, address token, uint128 limit, uint128 ceiling, uint128 spent, uint64 expiresAt, uint64 version, bool revoked)",
  "function spendAuthorized((address principal, address holder, address token, bytes32 actionHash, uint256 amount, address recipient, uint64 mandateVersion, uint64 deadline) p, bytes engineSignature)",
  "event SpendExecuted(address indexed principal, address indexed holder, address indexed recipient, address token, uint256 amount, bytes32 actionHash, uint64 mandateVersion)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const SPEND_PERMIT_TYPES = {
  SpendPermit: [
    { name: "principal", type: "address" }, { name: "holder", type: "address" }, { name: "token", type: "address" },
    { name: "actionHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "recipient", type: "address" },
    { name: "mandateVersion", type: "uint64" }, { name: "deadline", type: "uint64" },
  ],
} as const;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export interface MitraVaultTransportOptions {
  chain: ViemChain;
  /** The deployed MitraVault (lib/evm/deployments.json). */
  vault: `0x${string}`;
  /** Whose position pays. Must be the principal that opened the mandate. */
  principal: `0x${string}`;
  /** The agent the mandate is held by. */
  holder: `0x${string}`;
  /** Signs permits; must be the engine the principal named on the mandate. */
  engine: LocalAccount;
  /** Submits `spendAuthorized` and pays gas. Cannot change anything the engine signed. */
  relayer: LocalAccount;
  /** Tokens this rail may pay in (lowercase addresses). */
  tokens: ReadonlySet<string>;
  transport?: Transport;
  /** Seconds a permit stays spendable. */
  permitTtlSeconds?: number;
  /** Tempo's eth_gasPrice lags the effective price; pay a multiple (scripts/tempo-pay.mjs). */
  gasPriceMultiplier?: bigint;
  now?: () => number;
}

export class MitraVaultTransport {
  private readonly publicClient: PublicClient;
  private readonly walletClient;

  constructor(private readonly opts: MitraVaultTransportOptions) {
    for (const [k, v] of Object.entries({ vault: opts.vault, principal: opts.principal, holder: opts.holder })) {
      if (!EVM_ADDRESS.test(v)) throw new Error(`INVALID_${k.toUpperCase()}_ADDRESS`);
    }
    const transport = opts.transport ?? http();
    this.publicClient = createPublicClient({ chain: opts.chain, transport }) as PublicClient;
    this.walletClient = createWalletClient({ chain: opts.chain, transport, account: opts.relayer });
  }

  /** The payment: an engine-signed permit, submitted to the vault by the relayer. */
  async pay(input: { to: string; token: string; amountAtomic: string; commitment: string }): Promise<{ txHash: `0x${string}` }> {
    // Every refusal needing no network comes first.
    if (!EVM_ADDRESS.test(input.to)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!this.opts.tokens.has(input.token.toLowerCase())) throw new Error("UNREGISTERED_TOKEN_FOR_VAULT_RAIL");
    if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("INVALID_ATOMIC_AMOUNT");
    if (!BYTES32.test(input.commitment)) throw new Error("COMMITMENT_NOT_BYTES32");

    const reported = await this.publicClient.getChainId();
    if (reported !== this.opts.chain.id) throw new Error(`CHAIN_MISMATCH: expected ${this.opts.chain.id}, node reports ${reported}`);

    // The mandate as the chain holds it. Refusing here, before signing, is friendlier
    // than a revert — the contract re-checks every one of these regardless.
    const [engine, token, limit, , , expiresAt, version, revoked] = await this.publicClient.readContract({
      address: this.opts.vault, abi: MITRA_VAULT_ABI, functionName: "mandates", args: [this.opts.principal, this.opts.holder],
    });
    const amount = BigInt(input.amountAtomic);
    const now = Math.floor((this.opts.now ?? Date.now)() / 1000);
    if (version === 0n) throw new Error("MANDATE_NOT_FOUND");
    if (engine.toLowerCase() !== this.opts.engine.address.toLowerCase()) throw new Error("POLICY_ENGINE_MISMATCH");
    if (token.toLowerCase() !== input.token.toLowerCase()) throw new Error("MANDATE_TOKEN_MISMATCH");
    if (revoked) throw new Error("MANDATE_REVOKED");
    if (BigInt(now) >= expiresAt) throw new Error("MANDATE_EXPIRED");
    if (amount > limit) throw new Error("EXCEEDS_MANDATE_LIMIT");

    const permit = {
      principal: this.opts.principal, holder: this.opts.holder, token: input.token as Hex,
      actionHash: input.commitment as Hex, amount, recipient: input.to as Hex,
      mandateVersion: version, deadline: BigInt(now + (this.opts.permitTtlSeconds ?? 900)),
    };
    const engineSignature = await this.opts.engine.signTypedData({
      domain: { name: "MitraVault", version: "1", chainId: this.opts.chain.id, verifyingContract: this.opts.vault },
      types: SPEND_PERMIT_TYPES, primaryType: "SpendPermit", message: permit,
    });

    const gasPrice = await this.publicClient.getGasPrice();
    const mult = this.opts.gasPriceMultiplier ?? 1n;
    const txHash = await this.walletClient.sendTransaction({
      account: this.opts.relayer, chain: this.opts.chain, to: this.opts.vault,
      data: encodeFunctionData({ abi: MITRA_VAULT_ABI, functionName: "spendAuthorized", args: [permit, engineSignature] }),
      ...(mult > 1n ? { maxFeePerGas: gasPrice * mult, maxPriorityFeePerGas: gasPrice } : {}),
    });
    return { txHash };
  }

  async observe(txHash: string): Promise<ChainObservation | null> {
    if (!BYTES32.test(txHash)) return null;
    let receipt;
    try { receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex }); } catch { return null; }
    return observeVaultSpend({
      txHash, vault: this.opts.vault, principal: this.opts.principal, holder: this.opts.holder, tokens: this.opts.tokens,
      receipt: { status: receipt.status, to: receipt.to, blockNumber: receipt.blockNumber, logs: receipt.logs },
    });
  }

  /** As a Base rail transport. */
  asBaseTransport(chainId: BaseChainId): BaseTransport {
    return {
      send: async (i: { to: `0x${string}`; amountAtomic: string; asset: Erc20Asset | null; chainId: BaseChainId; data: string }) => {
        if (i.chainId !== chainId) throw new Error(`CHAIN_MISMATCH: transport is ${chainId}, settlement is ${i.chainId}`);
        if (!i.asset) throw new Error("NATIVE_SETTLEMENT_NOT_SUPPORTED");
        return this.pay({ to: i.to, token: i.asset.address, amountAtomic: i.amountAtomic, commitment: i.data });
      },
      verify: async (tx, cid) => ({ confirmed: cid === chainId && (await this.observe(tx)) !== null }),
      observe: async (tx, cid) => (cid === chainId ? this.observe(tx) : null),
    };
  }

  /** As a Tempo rail transport. */
  asTempoTransport(): TempoTransport {
    return {
      send: (i) => this.pay({ to: i.to, token: i.mint, amountAtomic: i.amountAtomic, commitment: i.commitment }),
      verify: async (tx) => ({ confirmed: (await this.observe(tx)) !== null }),
      observe: (tx) => this.observe(tx),
    };
  }
}

/**
 * The pure confirmation rule, testable without a node. Null for anything short of a
 * confirmed spend by this principal's mandate held by this holder.
 */
export function observeVaultSpend(input: {
  txHash: string;
  vault: string;
  principal: string;
  holder: string;
  tokens: ReadonlySet<string>;
  receipt: { status: "success" | "reverted"; to: string | null; blockNumber: bigint; logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }> };
}): ChainObservation | null {
  const { receipt } = input;
  const vault = input.vault.toLowerCase();
  if (receipt.status !== "success") return null;
  if (!receipt.to || receipt.to.toLowerCase() !== vault) return null;

  let spend: { recipient: string; token: string; amount: bigint; actionHash: string } | null = null;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== vault) continue;
    try {
      const ev = decodeEventLog({ abi: MITRA_VAULT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName !== "SpendExecuted") continue;
      if (ev.args.principal.toLowerCase() !== input.principal.toLowerCase()) continue;
      if (ev.args.holder.toLowerCase() !== input.holder.toLowerCase()) continue;
      spend = { recipient: ev.args.recipient.toLowerCase(), token: ev.args.token.toLowerCase(), amount: ev.args.amount, actionHash: ev.args.actionHash.toLowerCase() };
    } catch { /* not a vault event we read */ }
  }
  if (!spend || !input.tokens.has(spend.token)) return null;

  // The tokens actually left the vault for that recipient, in that amount.
  const delivered = receipt.logs.some((l) => {
    if (l.address.toLowerCase() !== spend!.token) return false;
    try {
      const ev = decodeEventLog({ abi: MITRA_VAULT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === vault &&
        ev.args.to.toLowerCase() === spend!.recipient && ev.args.value === spend!.amount;
    } catch { return false; }
  });
  if (!delivered) return null;

  return {
    txHash: input.txHash,
    block: Number(receipt.blockNumber),
    carriedCommitment: spend.actionHash,
    from: input.principal.toLowerCase(),
    to: spend.recipient,
    amountAtomic: spend.amount,
    asset: spend.token,
  };
}
