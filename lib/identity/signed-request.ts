/**
 * Caller identity (F55): a request is authorised by an EIP-712 signature over
 * the exact request, from a wallet registered to the actor making it.
 *
 * The API cannot take a caller's word for who it is, so a name in a header is
 * never identity. A signature over the request proves the actor's wallet
 * approved THIS instruction, the same question the execution guard asks before
 * value moves. Decision: shared context ctx_d236086bde9601ee.
 */

import { hashTypedData, keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { canonicalize } from "@/lib/domain/canonical";
import { verifyDigestSignature, type AuthorisationVerdict, type SignatureVerifier } from "@/lib/evm/eip712";
import type { Agent, Chain } from "@/lib/domain/types";

/** The chain ids a wallet registered on each EVM chain may sign under. Solana has none: no ed25519 path yet. */
const EVM_CHAIN_IDS: Partial<Record<Chain, readonly number[]>> = {
  base: [8453, 84532],
  tempo: [4217, 42431],
};

export interface MitraRequest {
  op: string;
  agreementId: string;
  /** The status the agreement was in when signed. The transition makes the signature stale. */
  fromStatus: string;
  /** The agent the caller acts as. */
  actor: string;
  /** Hash of the request body's remaining fields, so none can be swapped after signing. */
  bodyHash: `0x${string}`;
  /** Unix seconds. */
  expiresAt: number;
}

/** Whether a signature from `auth` speaks for `wallet`: same address, under a chain id of the wallet's chain. */
export function signsFor(wallet: Agent["wallets"][number], auth: Pick<RequestAuth, "signer" | "chainId">): boolean {
  return wallet.address.toLowerCase() === auth.signer.toLowerCase() && !!EVM_CHAIN_IDS[wallet.chain]?.includes(auth.chainId);
}

export interface RequestAuth {
  signer: `0x${string}`;
  chainId: number;
  signature: `0x${string}`;
}

export const MITRA_REQUEST_TYPES = {
  MitraRequest: [
    { name: "op", type: "string" },
    { name: "agreementId", type: "string" },
    { name: "fromStatus", type: "string" },
    { name: "actor", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/**
 * The `bodyHash` a client signs: keccak-256 over the canonical request body,
 * minus the `auth` envelope that carries the signature itself. Key order and
 * float spelling cannot change it; any changed value does.
 */
export function requestBodyHash(body: Record<string, unknown>): `0x${string}` {
  const { auth: _auth, ...signed } = body;
  return keccak256(toBytes(canonicalize({ domain: "mitra.request.body", value: signed })));
}

/**
 * A registration is the same signed message, with no agreement: the actor is
 * the agent being registered and the body hash covers its whole draft. It
 * cannot be replayed into a second agent, because an agentId registers once.
 */
export function registrationRequest(agent: { agentId: string } & Record<string, unknown>, expiresAt: number): MitraRequest {
  return {
    op: "registerAgent", agreementId: "", fromStatus: "UNREGISTERED", actor: agent.agentId,
    bodyHash: requestBodyHash(agent), expiresAt,
  };
}

/** What a client signs (e.g. `account.signTypedData(mitraRequestTypedData(r, chainId))`). */
export function mitraRequestTypedData(request: MitraRequest, chainId: number) {
  return {
    domain: { name: "Mitra API", version: "1", chainId },
    types: MITRA_REQUEST_TYPES,
    primaryType: "MitraRequest" as const,
    message: { ...request, expiresAt: BigInt(request.expiresAt) },
  };
}

export async function verifySignedRequest(input: {
  request: MitraRequest;
  auth: RequestAuth;
  agent: Pick<Agent, "agentId" | "wallets">;
  /** Unix seconds. */
  now: number;
  verifier: SignatureVerifier;
}): Promise<AuthorisationVerdict> {
  const { request, auth } = input;
  if (input.now >= request.expiresAt) return { ok: false, reason: "REQUEST_EXPIRED" };
  // A valid signature only proves who signed. It authorises nothing unless the
  // signer is a wallet registered to the agent it claims to act as, on the chain
  // it signed for: a contract wallet's address elsewhere may be someone else's.
  const registered = input.agent.wallets.some((w) => signsFor(w, auth));
  if (!registered) return { ok: false, reason: "SIGNER_NOT_AGENT_WALLET" };

  const typed = mitraRequestTypedData(request, auth.chainId);
  return verifyDigestSignature({
    digest: hashTypedData(typed),
    signature: auth.signature,
    expectedSigner: auth.signer,
    verifier: input.verifier,
    recover: () => recoverTypedDataAddress({ ...typed, signature: auth.signature }),
  });
}
