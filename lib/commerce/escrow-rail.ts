/**
 * Resolving an on-chain escrow rail from the environment.
 *
 * ## Why this is separate from the bridge
 *
 * `lib/commerce/onchain-escrow.ts` takes a rail as an argument so it can be tested with a
 * fake and no network. Something still has to decide, in production, *which* rail a given
 * `onChainEscrow` refers to and construct it — and that decision is the part with
 * consequences, because **absence is a refusal, not a skip**.
 *
 * ## The rule that matters: a requested escrow with no rail is an error
 *
 * `POST /api/v1/agreements` accepts `onChainEscrow`. If a caller supplies it and no rail
 * is configured, the honest answer is a refusal (`ESCROW_RAIL_NOT_CONFIGURED`), not a 200
 * with the escrow recorded in the database and nothing on chain. The second answer is the
 * exact defect LP-6 exists to remove: an agreement that looks funded while no capital is
 * escrowed, with a §15.5 commitment pointing at an account that does not exist.
 *
 * So `escrowRailFor` returns `null` only when the caller did *not* ask for an on-chain
 * escrow. A request with no rail behind it is a refusal the route raises.
 */

import type { EscrowRail, EvmEscrowRail } from "@/lib/commerce/onchain-escrow";
import { ERC8183Transport, type EscrowNetwork } from "@/lib/adapters/erc8183-transport";

/** Chains `onChainEscrow.chain` may name. Anything else is not a rail we have. */
const EVM_NETWORKS = new Set<string>(["baseSepolia", "moderato", "base", "tempo"]);

export function isEvmNetwork(chain: string): boolean {
  return EVM_NETWORKS.has(chain);
}

export function isSolanaNetwork(chain: string): boolean {
  return chain === "solana" || chain === "devnet" || chain === "solanaDevnet";
}

/**
 * Test-only rail override.
 *
 * ## Why a seam exists at all
 *
 * The hermetic suite has to drive the route's escrow path — including the case where the
 * chain write succeeded and the database write was lost, which is the only way to test the
 * dual-write guarantee. It cannot do that with a real `ERC8183Transport`, because that
 * means an RPC url and a funded key.
 *
 * ## What this does NOT do
 *
 * It does not make a fake settlement look real. The override changes only *which object*
 * the bridge talks to; `executeEscrowLock` still refuses mismatched terms, still refuses a
 * missing §15.5 commitment, and still emits `txHash` only when the rail hands one back. A
 * rail that lies produces a fake transaction hash in a log, which is why the setter refuses
 * to run outside a test environment rather than trusting every caller to behave.
 *
 * `null` is not accepted: a test that wants "no rail" sets the environment instead, so the
 * refusal path stays reachable and is not special-cased away.
 */
let override: ((chain: string) => EscrowRail | null) | null = null;

export function __setEscrowRailResolverForTests(
  fn: ((chain: string) => EscrowRail | null) | null,
): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("__setEscrowRailResolverForTests: refusing outside a test environment");
  }
  override = fn;
}

/** The single call site the route uses, so the override cannot be bypassed. */
export function resolveEscrowRail(
  requestedChain: string,
  env: Record<string, string | undefined> = process.env,
): EscrowRail | null {
  return override ? override(requestedChain) : escrowRailFor(requestedChain, env);
}

/**
 * Build the rail for a requested chain, or `null` when this process cannot service it.
 *
 * `null` means "I have no way to reach that chain", which the caller must treat as a
 * refusal. It never means "the escrow is fine, skip it".
 *
 * The EVM transport is constructed with the relayer key. It is only ever handed to the
 * bridge for signing, never stored, and the bridge itself is the only thing that decides
 * whether to broadcast.
 */
export function escrowRailFor(
  requestedChain: string,
  env: Record<string, string | undefined> = process.env,
): EscrowRail | null {
  if (isEvmNetwork(requestedChain)) {
    const network = (EVM_NETWORKS.has(requestedChain) ? requestedChain : "baseSepolia") as EscrowNetwork;
    const key = env.MITRA_EVM_SETTLEMENT_KEY_FILE
      ? readKeyFile(env.MITRA_EVM_SETTLEMENT_KEY_FILE)
      : env.MITRA_EVM_SETTLEMENT_KEY;
    if (!key) return null;
    if (network === "baseSepolia" && !env.BASE_SEPOLIA_RPC && !env.BASE_RPC_URL) return null;
    // No cast. F82 existed because `as unknown as EvmEscrowRail` let a `getJob` that
    // returned an array pass as one that returned named fields. If the transport's shape
    // and the bridge's interface ever diverge again, this must fail to compile.
    const evm: EvmEscrowRail = new ERC8183Transport(network, key);
    return { chain: "evm", network, evm };
  }

  if (isSolanaNetwork(requestedChain)) {
    // No rail is constructed here yet: the Solana escrow rail needs a funded
    // `Connection`, a vault PDA and an authority keypair, which is the next slice of LP-6
    // rather than something to fake. Returning null makes the route REFUSE a Solana
    // escrow, which is the correct behaviour while the rail cannot exist — an agreement
    // whose capital was never escrowed must not be recorded as funded.
    return null;
  }

  return null;
}

/** Read a key file as hex. Kept tolerant of a trailing newline, which `openssl` adds. */
function readKeyFile(path: string): string | undefined {
  // Imported lazily so a process that never configures an EVM rail does not pay for it,
  // and so a missing file surfaces as "no rail" rather than as a module-load failure.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = readFileSync(path, "utf8").trim();
    return raw.startsWith("0x") ? raw : `0x${raw}`;
  } catch {
    return undefined;
  }
}
