import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import { registrationRequest, signsFor, verifySignedRequest } from "@/lib/identity/signed-request";
import { signatureVerifierFor } from "@/lib/identity/verifier";
import type { Agent } from "@/lib/domain/types";

/**
 * Agents (backlog #5), read-only: one by `?agentId=`, or the list filtered by
 * `?capability=` and/or `?chain=` (an agent with a wallet on that chain).
 *
 * Registration (POST) needs a signature from every EVM wallet listed (F55), so no
 * one can register a wallet they do not control. Identity claims from outside
 * registries are never accepted as proof (ERC-8004 is projected outward only).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const capability = url.searchParams.get("capability");
  const chain = url.searchParams.get("chain");
  const { repo, backend } = await getStore();
  if (agentId) {
    const agent = await repo.getAgent(agentId);
    if (!agent) return NextResponse.json({ error: "AGENT_NOT_FOUND", agentId, backend }, { status: 404 });
    return NextResponse.json({ data: agent, backend });
  }
  const data = (await repo.listAgents())
    .filter((a) => !capability || a.capabilities.includes(capability))
    .filter((a) => !chain || a.wallets.some((w) => w.chain === chain));
  return NextResponse.json({ data, count: data.length, backend });
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const RegisterSchema = z.object({
  agent: z.object({
    agentId: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().min(1),
    wallets: z.array(z.object({ chain: z.enum(["solana", "base", "tempo"]), address: z.string().min(1) })).min(1),
    capabilities: z.array(z.string()).default([]),
    protocols: z.array(z.string()).default([]),
  }),
  expiresAt: z.number().int().positive(),
  proofs: z.array(z.object({
    signer: z.string().regex(EVM_ADDRESS),
    chainId: z.number().int().positive(),
    signature: z.string().regex(/^0x[0-9a-fA-F]*$/),
  })),
});

/**
 * Register an agent (F55). Each proof is the wallet's EIP-712 signature over
 * the registration; an id that exists is refused rather than overwritten.
 */
export async function POST(req: Request) {
  const parsed = RegisterSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const { agent: draft, expiresAt, proofs } = parsed.data;
  const { repo, backend } = await getStore();

  // Only EVM wallets can prove control today. A Solana wallet needs an ed25519
  // proof that does not exist yet, and an unproven wallet is never stored.
  const unprovable = draft.wallets.find((w) => w.chain === "solana");
  if (unprovable) {
    return NextResponse.json({ error: "WALLET_CHAIN_UNPROVABLE", wallet: unprovable, backend }, { status: 400 });
  }

  const request = registrationRequest(draft, expiresAt);
  const now = Math.floor(Date.now() / 1000);
  for (const proof of proofs) {
    const verdict = await verifySignedRequest({
      request,
      auth: { signer: proof.signer as `0x${string}`, chainId: proof.chainId, signature: proof.signature as `0x${string}` },
      agent: draft,
      now,
      verifier: signatureVerifierFor(proof.chainId),
    });
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason, signer: proof.signer, backend }, { status: 401 });
  }

  // Every listed wallet must be among the verified signers. A proof for one
  // wallet says nothing about another, which may belong to someone else.
  for (const wallet of draft.wallets) {
    if (!proofs.some((p) => signsFor(wallet, { signer: p.signer as `0x${string}`, chainId: p.chainId }))) {
      return NextResponse.json({ error: "WALLET_NOT_PROVEN", wallet, backend }, { status: 401 });
    }
  }

  const agent: Agent = {
    ...draft, status: "REGISTERED", marketplaceRefs: [], activeMandates: [], activeRuns: [], exposure: 0,
    createdAt: new Date().toISOString(), version: 1,
  };
  if (!(await repo.insertAgent(agent))) {
    return NextResponse.json({ error: "AGENT_EXISTS", agentId: agent.agentId, backend }, { status: 409 });
  }
  return NextResponse.json({ data: agent, backend }, { status: 201 });
}
