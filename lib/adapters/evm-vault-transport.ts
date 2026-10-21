/**
 * Settlement THROUGH the canonical `contracts/MitraVault.sol` — v2, the lead's
 * `[principal][holder]` + `actionHash` permit contract (package B.4; ported to v2 on
 * `feat/backlog-on-v2`) — the EVM counterpart of the Solana `VaultTransport`.
 *
 * Before this, Base and Tempo settled from a key (EOA) or a smart account: the
 * deployed vault contract enforced nothing on any Mitra payment. Here the capital sits
 * in the contract, and a payment is `spendAuthorized`: the mandate's engine signs an
 * EIP-712 permit whose `actionHash` is Mitra's settlement commitment, binding principal,
 * holder, token, amount and recipient; a relayer submits it; the contract re-checks the
 * engine, the mandate's ceiling, version, expiry and revocation, single use, and the
 * principal's freeze — and only then moves tokens. (Not the per-spend limit: see below.)
 *
 * ## Whose money
 *
 * The payer named in the settlement (and in its commitment, and on the Mitra vault
 * record) is the PRINCIPAL whose position pays. The tokens physically leave the vault
 * contract; the observation therefore requires both the contract's `SpendExecuted` for
 * this principal and a token `Transfer` from the contract to the recipient.
 *
 * ## What counts as confirmed (v2)
 *
 * v2's `SpendExecuted(principal, recipient, token, amount, actionHash)` carries the
 * EIP-712 digest of the WHOLE permit as `actionHash` — not Mitra's commitment, which
 * lives in the permit's own `actionHash` field, i.e. only in calldata. So confirmation
 * reads both: the `spendAuthorized` calldata (this principal and holder, a registered
 * token, the commitment) AND a `SpendExecuted` from the vault whose digest equals the
 * one recomputed from that calldata permit — which binds the event to exactly that
 * permit — plus a token `Transfer` from the vault to the recipient for the amount.
 *
 * ## Where the per-spend limit lives (v2, ADR-0009)
 *
 * v2 checks the mandate's `limit` only at ISSUANCE — never at spend (re-checking would
 * strand outstanding permits on every amendment). The engine is the issuer, and this
 * transport is the engine: its `EXCEEDS_MANDATE_LIMIT` check before signing is the only
 * place the limit is enforced, so it is load-bearing, not a convenience.
 */

import {
  createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData, hashTypedData, http, parseAbi,
  type Chain as ViemChain, type Hex, type LocalAccount, type PublicClient, type Transport,
} from "viem";
import type { ChainObservation } from "./types";
import type { BaseChainId, BaseTransport, Erc20Asset } from "./base";
import type { TempoTransport } from "./tempo";

/** The canonical v2 contract's surface this transport uses (`contracts/MitraVault.sol`). */
export const MITRA_VAULT_ABI = parseAbi([
  "function mandates(address principal, address holder, address token) view returns (address principal, address holder, uint64 limit, uint64 ceiling, uint64 spent, uint64 expiresAt, uint32 version, address policyEngine, bool revoked)",
  "function spendAuthorized((address principal, address holder, address token, bytes32 actionHash, uint256 amount, address recipient, uint32 mandateVersion, uint64 deadline) permit, bytes signature)",
  "event SpendExecuted(address indexed principal, address indexed recipient, address indexed token, uint256 amount, bytes32 actionHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const SPEND_PERMIT_TYPES = {
  SpendPermit: [
    { name: "principal", type: "address" }, { name: "holder", type: "address" }, { name: "token", type: "address" },
    { name: "actionHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "recipient", type: "address" },
    { name: "mandateVersion", type: "uint32" }, { name: "deadline", type: "uint64" },
  ],
} as const;

export const vaultDomain = (chainId: number, vault: `0x${string}`) =>
  ({ name: "MitraVault", version: "1", chainId, verifyingContract: vault }) as const;

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

  /**
   * The same rail, paying from another principal's position for another holder. The
   * engine key, relayer, vault, chain and tokens are unchanged, so nothing the caller
   * supplies can widen what this engine may sign: every check in `pay` reads the mandate
   * the chain holds for (principal, holder, token) and refuses unless it names THIS
   * engine, and the contract re-checks all of it.
   */
  bind(binding: { principal: `0x${string}`; holder: `0x${string}` }): MitraVaultTransport {
    return new MitraVaultTransport({ ...this.opts, principal: binding.principal, holder: binding.holder });
  }

  /** Whose position this rail pays from. */
  get principal(): `0x${string}` {
    return this.opts.principal;
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

    // The mandate as the chain holds it, for THIS token (F61: mandates are keyed
    // [principal][holder][token], so a limit is in this token's units only).
    // Refusing here, before signing, is friendlier than a revert — the contract
    // re-checks every one of these regardless.
    const [mPrincipal, , limit, ceiling, spent, expiresAt, version, engine, revoked] = await this.publicClient.readContract({
      address: this.opts.vault, abi: MITRA_VAULT_ABI, functionName: "mandates", args: [this.opts.principal, this.opts.holder, input.token as Hex],
    });
    const amount = BigInt(input.amountAtomic);
    const now = Math.floor((this.opts.now ?? Date.now)() / 1000);
    if (mPrincipal.toLowerCase() !== this.opts.principal.toLowerCase() || version === 0) throw new Error("MANDATE_NOT_FOUND");
    if (engine.toLowerCase() !== this.opts.engine.address.toLowerCase()) throw new Error("POLICY_ENGINE_MISMATCH");
    if (revoked) throw new Error("MANDATE_REVOKED");
    if (BigInt(now) >= expiresAt) throw new Error("MANDATE_EXPIRED");
    // v2 never re-checks the limit at spend: this, at issuance, is the only check.
    if (amount > limit) throw new Error("EXCEEDS_MANDATE_LIMIT");
    if (spent + amount > ceiling) throw new Error("EXCEEDS_MANDATE_CEILING");

    const permit = {
      principal: this.opts.principal, holder: this.opts.holder, token: input.token as Hex,
      actionHash: input.commitment as Hex, amount, recipient: input.to as Hex,
      mandateVersion: Number(version), deadline: BigInt(now + (this.opts.permitTtlSeconds ?? 900)),
    };
    const engineSignature = await this.opts.engine.signTypedData({
      domain: vaultDomain(this.opts.chain.id, this.opts.vault),
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
    let tx;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash as Hex });
      tx = await this.publicClient.getTransaction({ hash: txHash as Hex });
    } catch { return null; }
    return observeVaultSpend({
      txHash, vault: this.opts.vault, chainId: this.opts.chain.id, principal: this.opts.principal, holder: this.opts.holder,
      tokens: this.opts.tokens, input: tx.input,
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
 * confirmed v2 spend by this principal's mandate held by this holder.
 */
export function observeVaultSpend(input: {
  txHash: string;
  vault: string;
  chainId: number;
  principal: string;
  holder: string;
  tokens: ReadonlySet<string>;
  /** The transaction's calldata: the commitment and the holder exist only here in v2. */
  input: Hex;
  receipt: { status: "success" | "reverted"; to: string | null; blockNumber: bigint; logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }> };
}): ChainObservation | null {
  const { receipt } = input;
  const vault = input.vault.toLowerCase();
  if (receipt.status !== "success") return null;
  if (!receipt.to || receipt.to.toLowerCase() !== vault) return null;

  // The permit the transaction submitted.
  let permit: { principal: Hex; holder: Hex; token: Hex; actionHash: Hex; amount: bigint; recipient: Hex; mandateVersion: number; deadline: bigint };
  try {
    const { functionName, args } = decodeFunctionData({ abi: MITRA_VAULT_ABI, data: input.input });
    if (functionName !== "spendAuthorized") return null;
    permit = args[0] as typeof permit;
  } catch {
    return null;
  }
  if (permit.principal.toLowerCase() !== input.principal.toLowerCase()) return null;
  if (permit.holder.toLowerCase() !== input.holder.toLowerCase()) return null;
  const token = permit.token.toLowerCase();
  if (!input.tokens.has(token)) return null;

  // The event must be for exactly that permit: v2 emits the permit's EIP-712 digest.
  const digest = hashTypedData({
    domain: vaultDomain(input.chainId, vault as Hex), types: SPEND_PERMIT_TYPES, primaryType: "SpendPermit",
    message: { ...permit, mandateVersion: Number(permit.mandateVersion) },
  }).toLowerCase();
  const recipient = permit.recipient.toLowerCase();
  const executed = receipt.logs.some((l) => {
    if (l.address.toLowerCase() !== vault) return false;
    try {
      const ev = decodeEventLog({ abi: MITRA_VAULT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return ev.eventName === "SpendExecuted" && ev.args.principal.toLowerCase() === input.principal.toLowerCase() &&
        ev.args.recipient.toLowerCase() === recipient && ev.args.token.toLowerCase() === token &&
        ev.args.amount === permit.amount && ev.args.actionHash.toLowerCase() === digest;
    } catch { return false; }
  });
  if (!executed) return null;

  // The tokens actually left the vault for that recipient, in that amount.
  const delivered = receipt.logs.some((l) => {
    if (l.address.toLowerCase() !== token) return false;
    try {
      const ev = decodeEventLog({ abi: MITRA_VAULT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === vault &&
        ev.args.to.toLowerCase() === recipient && ev.args.value === permit.amount;
    } catch { return false; }
  });
  if (!delivered) return null;

  return {
    txHash: input.txHash,
    block: Number(receipt.blockNumber),
    carriedCommitment: permit.actionHash.toLowerCase(),
    from: input.principal.toLowerCase(),
    to: recipient,
    amountAtomic: permit.amount,
    asset: token,
  };
}
