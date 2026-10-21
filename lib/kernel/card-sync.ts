/**
 * Card sync: the engine learns a customer's spend card from the CHAIN, on the owner's
 * signature.
 *
 * A card is a mandate a customer opened in the MitraVault contract from their own wallet
 * (the principal), for an agent's wallet (the holder), naming a policy engine. The
 * customer app (mitra-fe) opens it on chain; this is how the engine finds out.
 *
 * ## What the signature proves, and what the chain proves
 *
 * The principal signs a Mitra request (`lib/identity/signed-request.ts`, op `syncCard`)
 * over the card: chain, principal, holder, agent id, capabilities, counterparties. That
 * proves the vault's owner asked for THIS engine policy (capabilities, counterparties) on
 * THIS card. Nothing money-shaped is taken from the request: the budget, per-payment cap,
 * expiry, version, revocation and the vault's positions are all read from the contract,
 * and the card must name THIS engine as its policy engine. So no operator token is
 * needed, and none is accepted: the authority is the owner's on-chain mandate plus the
 * owner's signature, which is exactly what F100 says the operator plane must not mint.
 *
 * ## What it refuses to do
 *
 * - Register the agent. F55: a wallet is only ever stored behind its own signature. The
 *   agent must already be registered with the holder wallet on this chain.
 * - Overwrite this engine's books mid-payment: the vault's positions are refreshed only
 *   while nothing is reserved, escrowed, encumbered or settling (`upsertChainVault`).
 * - Go backwards: a sync older than the last one applied is refused (`issuedAt` must
 *   exceed the stored mandate's nonce), so a captured signature cannot roll capabilities
 *   back to what they were.
 */
import { formatUnits, hashTypedData, recoverTypedDataAddress } from "viem";
import type { Agent, Chain, Mandate, Vault } from "@/lib/domain/types";
import { verifyDigestSignature, type SignatureVerifier } from "@/lib/evm/eip712";
import { mitraRequestTypedData, requestBodyHash, type MitraRequest, type RequestAuth } from "@/lib/identity/signed-request";
import type { EconomicRepository } from "@/lib/store/repository";

export type CardChain = Extract<Chain, "base" | "tempo">;

export interface CardNetwork {
  chainId: number;
  /** The canonical MitraVault on this chain (lib/evm/deployments.json). */
  vault: `0x${string}`;
  /** The token the card is denominated in, and its engine asset name. */
  token: `0x${string}`;
  asset: Vault["asset"];
  decimals: number;
}

export interface Card {
  chain: CardChain;
  principal: `0x${string}`;
  holder: `0x${string}`;
  agentId: string;
  capabilities: string[];
  counterparties: string[];
  /** Unix seconds. Must be recent, and newer than the last sync applied to this card. */
  issuedAt: number;
}

/** What the contract holds for (principal, holder, token): `mandates(...)`. */
export interface ChainMandate {
  principal: string;
  limit: bigint;
  ceiling: bigint;
  spent: bigint;
  expiresAt: bigint;
  version: number;
  policyEngine: string;
  revoked: boolean;
}

/** What the contract holds for (principal, token): `vaults(...)`. */
export interface ChainPosition {
  total: bigint;
  available: bigint;
  reserved: bigint;
  escrowed: bigint;
  encumbered: bigint;
  settling: bigint;
  frozen: bigint;
  emergencyFreeze: boolean;
}

export interface CardReader {
  mandate(principal: `0x${string}`, holder: `0x${string}`): Promise<ChainMandate>;
  position(principal: `0x${string}`): Promise<ChainPosition>;
}

export type SyncOutcome =
  | { ok: true; vault: Vault; mandate: Mandate; vaultWrite: "created" | "refreshed" | "kept" }
  | { ok: false; httpStatus: number; reason: string; detail?: string };

/** A sync signature is good for ten minutes. */
export const SYNC_TTL_SECONDS = 600;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const no = (httpStatus: number, reason: string, detail?: string): SyncOutcome => ({ ok: false, httpStatus, reason, ...(detail ? { detail } : {}) });

/** The request the principal signs. Exported so a client builds exactly this. */
export function syncRequest(card: Card): MitraRequest {
  return {
    op: "syncCard",
    agreementId: "",
    fromStatus: "",
    actor: card.principal.toLowerCase(),
    bodyHash: requestBodyHash(card as unknown as Record<string, unknown>),
    expiresAt: card.issuedAt + SYNC_TTL_SECONDS,
  };
}

export const cardIds = (card: Pick<Card, "chain" | "principal" | "holder">) => ({
  vaultId: `vault_${card.chain}_${card.principal.toLowerCase()}`,
  mandateId: `mandate_${card.chain}_${card.principal.toLowerCase()}_${card.holder.toLowerCase()}`,
});

export async function syncCard(input: {
  repo: EconomicRepository;
  network: CardNetwork;
  reader: CardReader;
  /** This engine's signing address; null when no key is configured. */
  engine: `0x${string}` | null;
  card: Card;
  auth: RequestAuth;
  verifier: SignatureVerifier;
  /** Unix seconds. */
  now: number;
}): Promise<SyncOutcome> {
  const { repo, network, reader, card, auth } = input;
  if (!input.engine) return no(503, "ENGINE_KEY_NOT_CONFIGURED", "This engine has no signing key, so it can approve no payment.");
  if (!repo.upsertChainVault || !repo.saveMandate) return no(501, "STORE_CANNOT_SYNC_CARDS");
  if (!EVM_ADDRESS.test(card.principal) || !EVM_ADDRESS.test(card.holder)) return no(400, "INVALID_ADDRESS");

  // ── 1. the owner asked for this, recently, on this chain ──────────────────
  if (auth.signer.toLowerCase() !== card.principal.toLowerCase()) return no(403, "SIGNER_IS_NOT_THE_VAULT_OWNER");
  if (auth.chainId !== network.chainId) return no(403, "SIGNED_FOR_ANOTHER_CHAIN");
  if (card.issuedAt > input.now + 60) return no(400, "ISSUED_IN_THE_FUTURE");
  const request = syncRequest(card);
  if (input.now >= request.expiresAt) return no(403, "REQUEST_EXPIRED");
  const typed = mitraRequestTypedData(request, auth.chainId);
  const verdict = await verifyDigestSignature({
    digest: hashTypedData(typed),
    signature: auth.signature,
    expectedSigner: auth.signer,
    verifier: input.verifier,
    recover: () => recoverTypedDataAddress({ ...typed, signature: auth.signature }),
  });
  if (!verdict.ok) return no(403, "BAD_SIGNATURE", verdict.reason);

  // ── 2. the agent proved its own wallet (F55) ──────────────────────────────
  const agent: Agent | null = await repo.getAgent(card.agentId);
  if (!agent) return no(404, "AGENT_NOT_REGISTERED", "The agent registers itself first, signed by its own wallet.");
  const holds = agent.wallets.some((w) => w.chain === card.chain && w.address.toLowerCase() === card.holder.toLowerCase());
  if (!holds) return no(409, "AGENT_WALLET_IS_NOT_THE_CARD_HOLDER");

  // ── 3. the chain holds a live card naming this engine ─────────────────────
  const m = await reader.mandate(card.principal, card.holder);
  if (m.version === 0 || m.principal.toLowerCase() !== card.principal.toLowerCase()) return no(404, "CARD_NOT_ON_CHAIN");
  if (m.revoked) return no(409, "CARD_REVOKED");
  if (BigInt(input.now) >= m.expiresAt) return no(409, "CARD_EXPIRED");
  if (m.policyEngine.toLowerCase() !== input.engine.toLowerCase()) {
    return no(409, "CARD_NAMES_ANOTHER_ENGINE", `The card names ${m.policyEngine}; this engine is ${input.engine}.`);
  }

  // ── 4. not older than what is already applied ─────────────────────────────
  const { vaultId, mandateId } = cardIds(card);
  const existing = await repo.getMandate(mandateId);
  if (existing && card.issuedAt <= existing.nonce) return no(409, "SYNC_IS_NOT_NEWER");

  // ── 5. write what the chain says ──────────────────────────────────────────
  const units = (v: bigint) => Number(formatUnits(v, network.decimals));
  const p = await reader.position(card.principal);
  const vault: Vault = {
    vaultId,
    name: `Vault ${card.principal.slice(0, 6)}…${card.principal.slice(-4)} (${card.chain})`,
    principal: card.principal.toLowerCase(),
    controllerRef: `eip155:${network.chainId}:${network.vault}`,
    chain: card.chain,
    asset: network.asset,
    address: card.principal,
    total: units(p.total), available: units(p.available), reserved: units(p.reserved), escrowed: units(p.escrowed),
    encumbered: units(p.encumbered), settling: units(p.settling), frozen: units(p.frozen),
    activeMandates: [], activeReservations: [],
    emergencyFreeze: p.emergencyFreeze,
    custodyMode: "CAPITAL_HOLDING",
    version: 1,
  };
  const vaultWrite = await repo.upsertChainVault(vault);

  const mandate: Mandate = {
    mandateId,
    name: `${agent.name} card`,
    version: m.version,
    principal: card.principal.toLowerCase(),
    agentId: agent.agentId,
    vaultId,
    asset: network.asset,
    // What is LEFT on the card: the engine's budget check compares one payment against
    // this, and the contract enforces the cumulative ceiling regardless.
    budget: units(m.ceiling - m.spent),
    maxTransaction: units(m.limit),
    allowedCounterparties: card.counterparties,
    allowedCapabilities: card.capabilities,
    prohibitedCapabilities: [],
    approvedChains: [card.chain],
    policyVersion: "policy_v1",
    expiresAt: new Date(Number(m.expiresAt) * 1000).toISOString(),
    nonce: card.issuedAt,
    status: "ACTIVE",
    confidentialPolicy: false,
  };
  await repo.saveMandate(mandate);

  return { ok: true, vault: (await repo.getVault(vaultId)) ?? vault, mandate, vaultWrite };
}
