/**
 * Tempo settlement (PRD Phase 9).
 *
 * Exit condition: "A Mitra obligation can target Tempo settlement through the same
 * abstract interface."
 *
 * ## Two traps this adapter is built around, both already paid for
 *
 * **F12 — `eth_getBalance` on Tempo returns a large CONSTANT**, identical for
 * every address. Native-balance logic therefore cannot work at all: it fails
 * silently and produces plausible numbers. Tempo settles in TIP-20, so that is the
 * only path taken here. There is no `balanceOf` fallback to native.
 *
 * **F15 — `api.tempo.xyz` indexes MAINNET**, while the funded testnet is Moderato.
 * A funded Moderato address queried through it returns `{"data":[]}` —
 * **byte-identical to the response for an address that holds nothing.** So "the
 * balance read returned empty" carries NO information about funding on this chain,
 * and any code treating it as zero would report a funded account as broke.
 *
 * `BalanceStatus` exists because of that. `EMPTY` is not `ZERO`: it means *this
 * source cannot speak for this account*, and callers must handle it differently
 * from a genuine zero.
 */

import type { Chain, EvidenceLevel, Money } from "@/lib/domain/types";
import type { SettlementAdapter } from "./types";
import { UnconfiguredAdapterError } from "./types";
import type { EvidenceBundle } from "@/lib/evm/evidence";

/** TIP-20 mints on Tempo. TIP-20 is the settlement asset; native balance is not usable (F12). */
export const TEMPO_TOKENS: Record<string, { symbol: string; mint: `0x${string}`; decimals: number }> = {
  USDC: { symbol: "USDC", mint: "0x5dDFa3e0d2C9d0dF4D6b1C6bA9E1A0eD4C5f2B1", decimals: 6 },
};

export type TempoNetwork = "moderato" | "mainnet";

export interface TempoBalanceSource {
  /** Returns TIP-20 balances. An empty array does NOT mean unfunded — see F15. */
  balances(network: TempoNetwork, address: string): Promise<{ data: Array<{ mint: string; amount: string }> }>;
}

export type BalanceStatus =
  /** The source answered with a balance for this token. */
  | { kind: "known"; amount: bigint }
  /**
   * The source returned nothing for this account. On Tempo this is ambiguous
   * (F15), so it is NOT collapsed into `known: 0`.
   */
  | { kind: "EMPTY" }
  /** The source itself failed. */
  | { kind: "error"; reason: string };

export class TempoBalanceReader {
  constructor(private readonly source: TempoBalanceSource, private readonly network: TempoNetwork) {}

  async read(asset: string, address: string): Promise<BalanceStatus> {
    const token = TEMPO_TOKENS[asset];
    if (!token) return { kind: "error", reason: `UNSUPPORTED_ASSET_ON_TEMPO:${asset}` };
    let res: { data: Array<{ mint: string; amount: string }> };
    try {
      res = await this.source.balances(this.network, address);
    } catch (e) {
      return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
    const row = res.data.find((b) => b.mint.toLowerCase() === token.mint.toLowerCase());
    if (!row) return { kind: "EMPTY" };
    return { kind: "known", amount: BigInt(row.amount) };
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface TempoTransport {
  send(input: { to: string; mint: string; amountAtomic: string; commitment: string }): Promise<{ txHash: string }>;
  verify(txHash: string): Promise<{ confirmed: boolean }>;
}

export class TempoSettlementAdapter implements SettlementAdapter {
  readonly chain: Chain = "tempo";

  constructor(
    private readonly opts: { network: TempoNetwork; transport?: TempoTransport },
    private readonly commit: (i: { settlementId: string; from: string; to: string; amount: Money; network: string }) => string,
  ) {}

  async validateTarget(input: { asset: string; recipient: string; amount: number }): Promise<void> {
    if (!EVM_ADDRESS.test(input.recipient)) throw new Error("INVALID_RECIPIENT_ADDRESS");
    if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("INVALID_AMOUNT");
    if (!Number.isInteger(input.amount * 10 ** 6)) throw new Error("AMOUNT_BELOW_ATOMIC_PRECISION");
    // TIP-20 only. A native-denominated Tempo settlement is refused rather than
    // silently converted, because the native balance is a constant (F12).
    if (!TEMPO_TOKENS[input.asset]) throw new Error("TEMPO_SETTLES_IN_TIP20_ONLY");
  }

  async settle(input: {
    settlementId: string;
    from: string;
    to: string;
    amount: Money;
    commitmentHash: string;
  }): Promise<{ txHash: string; evidenceLevel: EvidenceLevel }> {
    await this.validateTarget({ asset: input.amount.asset, recipient: input.to, amount: input.amount.amount });
    if (!EVM_ADDRESS.test(input.from)) throw new Error("INVALID_SENDER_ADDRESS");

    const expected = this.commit({
      settlementId: input.settlementId, from: input.from, to: input.to,
      amount: input.amount, network: this.opts.network,
    });
    if (expected !== input.commitmentHash) throw new Error("COMMITMENT_MISMATCH");
    if (!this.opts.transport) throw new UnconfiguredAdapterError("tempo settlement");

    const token = TEMPO_TOKENS[input.amount.asset];
    const { txHash } = await this.opts.transport.send({
      to: input.to,
      mint: token.mint,
      amountAtomic: (input.amount.amount * 10 ** token.decimals).toFixed(0),
      commitment: input.commitmentHash,
    });
    return { txHash, evidenceLevel: "LOCAL_PASS" as EvidenceLevel };
  }

  async verify(txHash: string): Promise<{ confirmed: boolean }> {
    if (!this.opts.transport) return { confirmed: false };
    return this.opts.transport.verify(txHash);
  }
  /**
   * PRD 21.4 `getEvidence`. Returns null rather than a bundle assembled from
   * nothing: a bundle with no observed chain behind it is indistinguishable from
   * one that watched a transfer, and the counterparty has no way to tell.
   */
  async getEvidence(_ref: { settlementId: string }): Promise<EvidenceBundle | null> {
    return null;
  }

}
