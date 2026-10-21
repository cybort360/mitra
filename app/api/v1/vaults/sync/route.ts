import { NextResponse } from "next/server";
import { z } from "zod";
import { refuseIfPaused } from "@/lib/admin/incident";
import { cardNetwork, rpcCardReader } from "@/lib/kernel/card-network";
import { syncCard } from "@/lib/kernel/card-sync";
import { signatureVerifierFor } from "@/lib/identity/verifier";
import { engineAddressFromEnv } from "@/lib/settlement/rails";
import { getStore } from "@/lib/store/provider";

/**
 * POST /api/v1/vaults/sync — the engine learns a customer's spend card from the chain,
 * on the vault owner's signature. See lib/kernel/card-sync.ts for what is checked and why
 * no operator token is involved. Budget, cap, expiry and positions are READ from the
 * contract; the request carries only engine policy (capabilities, counterparties).
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TAG = /^[a-z0-9_.:*-]{1,40}$/;

const SyncSchema = z.object({
  card: z.object({
    chain: z.enum(["base", "tempo"]),
    principal: z.string().regex(EVM_ADDRESS),
    holder: z.string().regex(EVM_ADDRESS),
    agentId: z.string().min(1).max(80),
    capabilities: z.array(z.string().regex(TAG)).max(32),
    counterparties: z.array(z.string().min(1).max(80)).min(1).max(32),
    issuedAt: z.number().int().positive(),
  }),
  auth: z.object({
    signer: z.string().regex(EVM_ADDRESS),
    chainId: z.number().int().positive(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }),
});

export async function POST(req: Request) {
  const parsed = SyncSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  const { card, auth } = parsed.data;
  // A sync writes a Mandate: the limit every later authorization is checked against. It
  // stops with mandate creation when the operator pauses authority (F100, PP-4).
  const paused = await refuseIfPaused("authority");
  if (paused) return paused;

  const where = cardNetwork(card.chain);
  if ("missing" in where) return NextResponse.json({ error: "RPC_NOT_CONFIGURED", missing: where.missing }, { status: 503 });

  const { repo, backend } = await getStore();
  let outcome;
  try {
    outcome = await syncCard({
      repo,
      network: where.network,
      reader: rpcCardReader(where.network, where.viemChain, where.rpc),
      engine: engineAddressFromEnv(),
      card: { ...card, principal: card.principal as `0x${string}`, holder: card.holder as `0x${string}` },
      auth: { signer: auth.signer as `0x${string}`, chainId: auth.chainId, signature: auth.signature as `0x${string}` },
      verifier: signatureVerifierFor(auth.chainId),
      now: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    // A chain read that failed is not a card that does not exist: say which.
    return NextResponse.json({ error: "CHAIN_READ_FAILED", detail: e instanceof Error ? e.message : String(e), backend }, { status: 502 });
  }
  if (!outcome.ok) return NextResponse.json({ error: outcome.reason, detail: outcome.detail, backend }, { status: outcome.httpStatus });
  return NextResponse.json({ data: { vault: outcome.vault, mandate: outcome.mandate, vaultWrite: outcome.vaultWrite }, backend });
}
