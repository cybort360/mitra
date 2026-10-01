import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateProposal, type ActionProposal } from "@/lib/kernel/authorization";
import { mandates } from "@/lib/store/seed";
import { actionDigestFor, getLedger, newId } from "@/lib/store/ledger";
import type { Authorization } from "@/lib/domain/types";

/**
 * Authorize a proposed action against a mandate and vault.
 *
 * This is the first production caller of `evaluateProposal`. A DENY here is a
 * real, reachable outcome carrying machine-readable reason codes — an ALLOW is
 * explicitly NOT permission to move value; that remains the execution guard's
 * job in /api/v1/reservations/execute.
 */
const proposalSchema = z.object({
  mandateId: z.string().min(1),
  vaultId: z.string().min(1),
  amount: z.number().positive(),
  asset: z.string().min(1),
  chain: z.string().min(1),
  counterparty: z.string().min(1),
  capability: z.string().min(1),
  intentId: z.string().min(1).default("intent_unspecified"),
  runId: z.string().min(1).default("run_unspecified"),
  // Optional clock injection. Absent means "now"; the kernel stays pure either way.
  now: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const parsed = proposalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const mandate = mandates.find((m) => m.mandateId === body.mandateId);
  if (!mandate) return NextResponse.json({ error: "MANDATE_NOT_FOUND", mandateId: body.mandateId }, { status: 404 });

  const vault = getLedger().getVault(body.vaultId);
  if (!vault) return NextResponse.json({ error: "VAULT_NOT_FOUND", vaultId: body.vaultId }, { status: 404 });

  // A proposal for a vault the mandate does not cover must not be evaluated as
  // if it were: the capital and the authority are different objects.
  if (mandate.vaultId !== vault.vaultId) {
    return NextResponse.json(
      { error: "MANDATE_VAULT_MISMATCH", mandateVaultId: mandate.vaultId, requestedVaultId: vault.vaultId },
      { status: 409 },
    );
  }

  const now = body.now ? new Date(body.now) : new Date();
  const proposal: ActionProposal = {
    amount: body.amount, asset: body.asset, chain: body.chain,
    counterparty: body.counterparty, capability: body.capability,
    actionDigest: actionDigestFor({
      vaultId: vault.vaultId, mandateId: mandate.mandateId, mandateVersion: mandate.version,
      amount: body.amount, asset: body.asset, chain: body.chain,
      counterparty: body.counterparty, capability: body.capability,
    }),
    now,
  };

  // Spend history is derived server-side from settled reservations, never taken
  // from the request, so a caller cannot under-report it to slip the limit.
  const recentSpend = getLedger().recentSpend(
    vault.vaultId, mandate.mandateId, now, mandate.velocityLimit?.windowMinutes ?? 60,
  );

  const result = evaluateProposal(mandate, vault, proposal, { recentSpend });

  const auth: Authorization = {
    authorizationId: newId("auth"),
    runId: body.runId, intentId: body.intentId,
    mandateId: mandate.mandateId, mandateVersion: mandate.version,
    vaultId: vault.vaultId,
    decision: result.decision,
    actionDigest: proposal.actionDigest,
    asset: body.asset as Authorization["asset"],
    amountCeiling: body.amount,
    recipientConstraint: body.counterparty,
    chain: body.chain as Authorization["chain"],
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    nonce: 0,
    reasonCodes: result.reasonCodes,
    signer: "policy-engine:local",
    version: 1,
  };
  getLedger().recordAuthorization(auth);

  return NextResponse.json(
    { data: auth, evidenceLevel: "LOCAL_PASS", note: "An ALLOW is not permission to move capital. Execution is gated separately by the reservation binding guard." },
    { status: result.decision === "ALLOW" ? 201 : 403 },
  );
}
