/**
 * What MitraClearing says about a residual transfer (Phase 7).
 *
 * A residual is paid only when the chain agrees: the epoch is Finalized (or
 * Settling) on MitraClearing, and its transfer at that index is exactly the one
 * being paid. That binds the payment to the challengeable on-chain result, not
 * only to the store. Decision: shared context ctx_9b9e7a8c3172e71b.
 *
 * The on-chain epoch id is keccak256 of the stored epoch id.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, keccak256, parseAbi, toBytes, type PublicClient } from "viem";
import type { Chain } from "@/lib/domain/types";

export const CLEARING_STATUSES = ["None", "Open", "Frozen", "Proposed", "Challenged", "Finalized", "Settling", "Settled"] as const;
export type OnChainEpochStatus = (typeof CLEARING_STATUSES)[number];

export interface OnChainResidual {
  status: OnChainEpochStatus;
  from: string;
  to: string;
  amountAtomic: bigint;
}

export interface ClearingReader {
  /** The epoch's status and transfer `transferIndex`, or null when the chain has no such transfer. */
  residual(input: { chain: Chain; epochId: string; transferIndex: number }): Promise<OnChainResidual | null>;
}

export const onChainEpochId = (epochId: string) => keccak256(toBytes(epochId));

export const CLEARING_ABI = parseAbi([
  "struct TransferInstruction { address from; address to; uint128 amount; }",
  "function epochs(bytes32) view returns (uint8 status, uint64 challengeWindow, uint64 challengeExpiresAt, uint32 obligationCount, bytes32 inputsRoot, bytes32 resultHash, uint32 proposalVersion, uint32 receiptCount)",
  "function transfersOf(bytes32) view returns (TransferInstruction[])",
]);

/** Reads one deployed MitraClearing per chain. */
export function rpcClearingReader(contracts: Partial<Record<Chain, { address: `0x${string}`; client: PublicClient }>>): ClearingReader {
  return {
    async residual({ chain, epochId, transferIndex }) {
      const c = contracts[chain];
      if (!c) throw new Error(`CLEARING_READER_NOT_CONFIGURED:${chain}`);
      const id = onChainEpochId(epochId);
      const [epoch, transfers] = await Promise.all([
        c.client.readContract({ address: c.address, abi: CLEARING_ABI, functionName: "epochs", args: [id] }),
        c.client.readContract({ address: c.address, abi: CLEARING_ABI, functionName: "transfersOf", args: [id] }),
      ]);
      const t = transfers[transferIndex];
      if (!t) return null;
      return { status: CLEARING_STATUSES[epoch[0]] ?? "None", from: t.from, to: t.to, amountAtomic: t.amount };
    },
  };
}

/**
 * From `lib/evm/deployments.json` and the rails' RPC variables (`BASE_RPC_URL`,
 * `TEMPO_RPC_URL`). Null when no chain is configured: a residual is then refused,
 * never paid unchecked.
 */
export function clearingReaderFromEnv(env: NodeJS.ProcessEnv = process.env): ClearingReader | null {
  const deployments = JSON.parse(readFileSync(join(process.cwd(), "lib/evm/deployments.json"), "utf8"));
  const contracts: Partial<Record<Chain, { address: `0x${string}`; client: PublicClient }>> = {};
  const add = (chain: Chain, network: string, rpc: string | undefined) => {
    const address = deployments.clearing?.[network]?.address;
    if (rpc && address) contracts[chain] = { address, client: createPublicClient({ transport: http(rpc) }) as PublicClient };
  };
  add("base", "baseSepolia", env.BASE_RPC_URL);
  add("tempo", "moderato", env.TEMPO_RPC_URL);
  return Object.keys(contracts).length ? rpcClearingReader(contracts) : null;
}

declare global {
  // eslint-disable-next-line no-var
  var __mitraClearingReader: { reader: ClearingReader | null } | undefined;
}

export function getClearingReader(): ClearingReader | null {
  globalThis.__mitraClearingReader ??= { reader: clearingReaderFromEnv() };
  return globalThis.__mitraClearingReader.reader;
}

/** Replace the reader for a test; `null` means "none configured". Restore with `__resetClearingReaderForTests`. */
export function __setClearingReaderForTests(reader: ClearingReader | null): void {
  globalThis.__mitraClearingReader = { reader };
}

export function __resetClearingReaderForTests(): void {
  globalThis.__mitraClearingReader = undefined;
}
