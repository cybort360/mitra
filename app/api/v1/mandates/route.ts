import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import { recordEvent } from "@/lib/store/events";
import { refuseIfPaused } from "@/lib/admin/incident";
import type { AssetSymbol, Chain, Mandate } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

/**
 * Mandates: the ROOT of the authority tree.
 *
 * ```
 * Mandate → Authorization → Intent → Agreement
 * ```
 *
 * Everything downstream is bounded by this record — `evaluateProposal` reads its budget,
 * `maxTransaction`, velocity window, approved chains and capability lists, and the vault
 * re-checks headroom and freeze at spend time. A Mandate is the only place where a number
 * like "this agent may spend up to 100,000 USDC of that vault" is actually asserted.
 *
 * ## Who may create one (F100 — read this before deploying)
 *
 * **This route is unauthenticated, and that is a real exposure, not an oversight.**
 *
 * The prescribed shape for this packet created a Mandate from an unauthenticated POST. Every
 * other authority write in this repository is bounded — an `Authorization` is bounded by a
 * Mandate that already exists, so the worst an attacker gets is one authorized action inside
 * limits somebody else set. **A Mandate is not bounded that way.** Creating one is minting
 * the limit itself, so an unauthenticated `POST` lets any caller grant any agent any budget
 * over any vault, including vaults belonging to other principals.
 *
 * It is built this way because it matches the operator-plane posture the rest of the
 * repository already takes (`POST /api/v1/authorizations` is likewise unauthenticated) and
 * because the packet's showcase needs to run unattended. That is a **recorded decision to
 * defer**, not an endorsement, and the guards below narrow it as far as is possible without
 * breaking the showcase:
 *
 * - the `vaultId` must **exist**, so authority cannot be minted over nothing;
 * - the `agentId` must be a **registered agent**, so authority cannot be granted to an
 *   identity the repository has never seen;
 * - a mandate is **first-write-wins**, so an existing one cannot be silently replaced.
 *
 * What remains is the real gap: a caller who knows a real `vaultId` and a real `agentId`
 * can grant that agent a budget over that vault. Closing it needs a signature from the
 * principal, exactly as F55 gave the agreement transitions one, and that is a larger change
 * than a polish packet. Tracked as F100.
 */

const createMandateSchema = z.object({
  mandateId: z.string().min(1).optional(),
  name: z.string().min(1),
  principal: z.string().min(1),
  agentId: z.string().min(1),
  vaultId: z.string().min(1),
  asset: z.enum(["USDC", "USDT", "SOL", "ETH", "PathUSD", "AlphaUSD", "BetaUSD", "ThetaUSD", "OpenUSD"]),
  budget: z.number().positive(),
  maxTransaction: z.number().positive(),
  velocityLimit: z.object({ amount: z.number().positive(), windowMinutes: z.number().positive() }).optional(),
  allowedCounterparties: z.array(z.string()).default([]),
  allowedCapabilities: z.array(z.string()).default(["payment", "research"]),
  prohibitedCapabilities: z.array(z.string()).default([]),
  // `z.enum` rather than `z.string().default([...])`: a typo in a chain name would otherwise
  // be accepted and stored, and `approvedChains` is read by the settlement binding check —
  // an unrecognised chain there must fail loudly at the boundary rather than silently widen.
  approvedChains: z.array(z.enum(["solana", "base", "tempo"])).default(["base", "solana"]),
  policyVersion: z.string().default("policy_v1"),
  expiresAt: z.string().datetime(),
  confidentialPolicy: z.boolean().default(false),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mandateId = url.searchParams.get("mandateId");
  const agentId = url.searchParams.get("agentId");
  const principal = url.searchParams.get("principal");
  const vaultId = url.searchParams.get("vaultId");
  const { repo, backend } = await getStore();

  if (mandateId) {
    const mandate = await repo.getMandate(mandateId);
    if (!mandate) {
      return NextResponse.json({ error: "MANDATE_NOT_FOUND", mandateId }, { status: 404 });
    }
    return NextResponse.json({ data: mandate, backend, evidenceLevel: "LOCAL_PASS" });
  }

  const all = await repo.listMandates();
  const filtered = all.filter((m) => {
    if (agentId && m.agentId !== agentId) return false;
    if (principal && m.principal !== principal) return false;
    if (vaultId && m.vaultId !== vaultId) return false;
    return true;
  });

  return NextResponse.json({ data: filtered, count: filtered.length, backend, evidenceLevel: "LOCAL_PASS" });
}

export async function POST(req: Request) {
  // F100: creating a Mandate is MINTING the limit every later authorization is checked
  // against, so it is pausable in its own scope. Granting an Authorization is not — that is
  // bounded by a Mandate that already exists — but granting the Mandate is not bounded at
  // all, so it has to stop when the operator says capital operations have stopped.
  const paused = await refuseIfPaused("authority");
  if (paused) return paused;

  const { repo, backend } = await getStore();
  if (!repo.saveMandate) {
    return NextResponse.json({ error: "STORE_CANNOT_WRITE_MANDATES" }, { status: 501 });
  }

  const parsed = createMandateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_MANDATE", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  if (Date.parse(b.expiresAt) <= Date.now()) {
    return NextResponse.json({ error: "INVALID_MANDATE", reason: "EXPIRES_AT_IN_PAST" }, { status: 400 });
  }
  // A per-transaction ceiling above the whole budget is not a tighter limit, it is a
  // contradictory one: every transaction up to `maxTransaction` would be refused, so the
  // mandate looks real and can never be used.
  if (b.maxTransaction > b.budget) {
    return NextResponse.json({ error: "INVALID_MANDATE", reason: "MAX_TRANSACTION_EXCEEDS_BUDGET" }, { status: 400 });
  }
  if (b.velocityLimit && b.velocityLimit.amount > b.budget) {
    return NextResponse.json({ error: "INVALID_MANDATE", reason: "VELOCITY_EXCEEDS_BUDGET" }, { status: 400 });
  }

  const mandateId = b.mandateId ?? `mandate_${Math.random().toString(36).slice(2, 10)}`;
  // First write wins, as `POST /api/v1/intents` does (F65). A Mandate is the limit; silently
  // replacing one would raise an agent's ceiling with no trace on the record that granted it.
  const existing = await repo.getMandate(mandateId);
  if (existing) {
    return NextResponse.json({ error: "MANDATE_EXISTS", mandateId }, { status: 409 });
  }

  // F100 guards. Authority over a vault that does not exist is a record nobody can enforce
  // and nothing can spend against; authority to an identity the repository has never seen is
  // authority to nobody.
  const vault = await repo.getVault(b.vaultId);
  if (!vault) {
    return NextResponse.json({ error: "VAULT_NOT_FOUND", vaultId: b.vaultId }, { status: 404 });
  }
  const agent = await repo.getAgent(b.agentId);
  if (!agent) {
    return NextResponse.json({ error: "AGENT_NOT_REGISTERED", agentId: b.agentId }, { status: 404 });
  }
  if (vault.chain && !b.approvedChains.includes(vault.chain)) {
    // A mandate that does not approve the chain of the vault it spends from can never
    // authorise anything, for the same reason `maxTransaction > budget` is refused above.
    return NextResponse.json(
      { error: "INVALID_MANDATE", reason: "VAULT_CHAIN_NOT_APPROVED", vaultChain: vault.chain },
      { status: 400 },
    );
  }

  const mandate: Mandate = {
    mandateId,
    name: b.name,
    version: 1,
    principal: b.principal,
    agentId: b.agentId,
    vaultId: b.vaultId,
    asset: b.asset as AssetSymbol,
    budget: b.budget,
    maxTransaction: b.maxTransaction,
    ...(b.velocityLimit ? { velocityLimit: b.velocityLimit } : {}),
    allowedCounterparties: b.allowedCounterparties,
    allowedCapabilities: b.allowedCapabilities,
    prohibitedCapabilities: b.prohibitedCapabilities,
    approvedChains: b.approvedChains as Chain[],
    policyVersion: b.policyVersion,
    expiresAt: b.expiresAt,
    nonce: 0,
    status: "ACTIVE",
    confidentialPolicy: b.confidentialPolicy,
  };

  await repo.saveMandate(mandate);

  // The run log records that authority was granted and on what terms — a ceiling that
  // appears with no event is one nobody can account for, and F100 is precisely the gap where
  // nobody can say who asked for it.
  await recordEvent(repo, {
    runId: `run_${mandateId}`,
    kind: "AUTHORITY",
    title: "Mandate granted",
    status: "SUCCESS",
    description: `${b.agentId} may spend up to ${b.maxTransaction} ${b.asset} per transaction, ` +
      `${b.budget} ${b.asset} in total, from ${b.vaultId}.`,
    objectRef: mandateId,
    metadata: {
      mandateId, agentId: b.agentId, principal: b.principal, vaultId: b.vaultId,
      budget: b.budget, maxTransaction: b.maxTransaction, asset: b.asset,
    },
  });

  return NextResponse.json({ data: mandate, backend, evidenceLevel: "LOCAL_PASS" }, { status: 201 });
}