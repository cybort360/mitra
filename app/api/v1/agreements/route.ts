import { NextResponse } from "next/server";
import { refuseIfPaused } from "@/lib/admin/incident";
import { z } from "zod";
import { isAddress } from "viem";
import { getStore } from "@/lib/store/provider";
import {
  openAgreement,
  availableAgreementOps,
  mayInstruct,
  type AgreementOp,
} from "@/lib/kernel/commerce";
import { commitAgreementOp } from "@/lib/commerce/commit-op";
import {
  executeEscrowLock, executeEscrowRelease, executeEscrowRefund,
  escrowIdFor, refundRouteHashFor,
  type EscrowOutcome, type EscrowTerms, type EscrowRail,
} from "@/lib/commerce/onchain-escrow";
import { resolveEscrowRail } from "@/lib/commerce/escrow-rail";
import { onChainRefundRouteFor } from "@/lib/kernel/commerce-recovery";
import { reconcileEscrow } from "@/lib/commerce/escrow-reconcile";
import { routeCommitment } from "@/lib/domain/canonical";
import { recordEvent } from "@/lib/store/events";
import { requestBodyHash, verifySignedRequest } from "@/lib/identity/signed-request";
import { signatureVerifierFor } from "@/lib/identity/verifier";
import type { Agreement, Money, Space } from "@/lib/domain/types";

/**
 * List agreements, optionally filtered to one Space or by agreementId.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const spaceId = url.searchParams.get("spaceId") ?? undefined;
  const agreementId = url.searchParams.get("agreementId") ?? undefined;
  const { repo, backend } = await getStore();

  if (agreementId) {
    const loaded = repo.getAgreement
      ? await repo.getAgreement(agreementId)
      : (await repo.listAgreements()).find((a) => a.agreementId === agreementId) ?? null;
    // F97: an escrow may have been refunded by someone who is not a party — a keeper after
    // a timeout, a client changing their mind — and Mitra learns of it from the chain rather
    // than from a message. A read that can heal is normally wrong; returning a KNOWN-STALE
    // status to whoever asked is worse, because the caller cannot tell which number is stale.
    // Bounded to agreements that HAVE an escrow, healed only in the refunded direction, and
    // every heal records an event so the write is visible in the audit log.
    const agreement = loaded ? await reconcileOnRead(repo, loaded) : loaded;

    if (!agreement) {
      return NextResponse.json(
        { error: "AGREEMENT_NOT_FOUND", agreementId, backend },
        { status: 404 },
      );
    }

    // F94: the deliverable travels WITH the agreement. An evaluator deciding whether to
    // accept needs the content hash and artifact refs the provider actually signed — and
    // before this they existed only in a request body that was discarded, so "accept"
    // accepted an assertion about work nobody could inspect.
    const deliverables = (await repo.listDeliverables()).filter((d) => d.agreementId === agreement.agreementId);

    return NextResponse.json({
      data: {
        ...agreement,
        availableOps: availableAgreementOps(agreement.status),
        deliverables,
      },
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  const agreements = await repo.listAgreements(spaceId);
  return NextResponse.json({
    data: agreements.map((a) => ({
      ...a,
      availableOps: availableAgreementOps(a.status),
    })),
    count: agreements.length,
    spaceId: spaceId ?? null,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}

const MoneySchema = z.object({
  asset: z.string().min(1),
  amount: z.number().positive(),
});

const OpenAgreementSchema = z.object({
  op: z.literal("open"),
  spaceId: z.string().min(1),
  draft: z.object({
    agreementId: z.string().min(1),
    runId: z.string().min(1),
    intentId: z.string().min(1),
    client: z.string().min(1),
    provider: z.string().min(1),
    evaluator: z.string().min(1),
    externalJobRefs: z
      .array(
        z.union([
          z.string(),
          z.object({ system: z.string(), id: z.string(), url: z.string().optional() }),
        ]),
      )
      .default([]),
    price: MoneySchema,
    deadline: z.string().min(1),
    acceptanceCriteria: z.array(z.string()).default([]),
    failurePolicy: z.string().optional(),
    /** Where the provider is paid. A term, fixed here; settlement never takes a payee from its caller. */
    payTo: z.object({
      chain: z.enum(["solana", "base", "tempo"]),
      address: z.string().min(1),
    }).optional(),
  }),
  proposal: z.object({
    capability: z.string().min(1),
    amount: MoneySchema,
  }),
});

const OnChainEscrowSchema = z.object({
  chain: z.string().min(1),
  contractAddress: z.string().min(1),
  jobId: z.string().min(1),
  timeout: z.number().optional(),
});

const TransitionAgreementSchema = z.object({
  op: z.enum([
    "fund",
    "startExecution",
    "submitDeliverable",
    "acceptDeliverable",
    "rejectDeliverable",
    "refund",
  ]),
  agreementId: z.string().min(1),
  spaceId: z.string().optional(),
  capability: z.string().optional(),
  amount: MoneySchema.optional(),
  artifactRefs: z.array(z.string()).optional(),
  contentHash: z.string().optional(),
  failureReason: z.string().optional(),
  onChainEscrow: OnChainEscrowSchema.optional(),
  /** F55: who is acting, and their wallet's EIP-712 signature over this exact request. */
  auth: z.object({
    actor: z.string().min(1),
    signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainId: z.number().int().positive(),
    signature: z.string().regex(/^0x[0-9a-fA-F]*$/),
    expiresAt: z.number().int().positive(),
  }).optional(),
});

const AgreementPostSchema = z.discriminatedUnion("op", [
  OpenAgreementSchema,
  TransitionAgreementSchema,
]);

/**
 * Drive commercial agreement lifecycle.
 *
 * All operations are bound to TALOS recovery sagas via `applyAgreementOpWithSaga`.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = AgreementPostSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  // Incident controls (PP-4): opening and funding stop under a pause; refunds,
  // rejections and the other transitions do not (lib/admin/incident.ts).
  const pauseScope = body.op === "open" ? "agreements" : body.op === "fund" ? "funding" : null;
  const paused = pauseScope ? await refuseIfPaused(pauseScope) : null;
  if (paused) return paused;
  const { repo, backend } = await getStore();
  // F94: the deliverable deadline check needs a clock, and one taken here is the same
  // instant used for the event log — two clocks would make "late" depend on which one ran.
  const now = new Date();

  // These writes used to be skipped with `if (repo.saveAgreement)`, so a store
  // without them answered 2xx and persisted nothing (the Postgres repository had
  // none until sprint item 1). Refuse instead: a 2xx must mean it was written.
  if (!repo.getAgreement || !repo.saveAgreement || !repo.updateAgreement || !repo.getSpace || !repo.updateSpace) {
    return NextResponse.json({ error: "STORE_CANNOT_PERSIST_AGREEMENTS", backend }, { status: 501 });
  }

  if (body.op === "open") {
    const space = repo.getSpace
      ? await repo.getSpace(body.spaceId)
      : (await repo.listSpaces()).find((s) => s.spaceId === body.spaceId) ?? null;

    if (!space) {
      return NextResponse.json(
        { error: "SPACE_NOT_FOUND", spaceId: body.spaceId, backend },
        { status: 404 },
      );
    }

    const openResult = openAgreement(
      space,
      body.draft as unknown as Omit<Agreement, "status" | "version" | "spaceIds">,
      body.proposal as unknown as { capability: string; amount: Money },
    );

    if (!openResult.ok) {
      await recordEvent(repo, {
        runId: body.draft.runId, kind: "COMMERCE", title: "Agreement refused at open", status: "WARNING",
        description: `The Space refused the agreement: ${openResult.reason}.`, objectRef: body.draft.agreementId,
        metadata: { reason: openResult.reason, spaceId: body.spaceId },
      });
      return NextResponse.json(
        { error: openResult.reason, backend },
        { status: 400 },
      );
    }

    await repo.saveAgreement(openResult.value.agreement);
    await repo.updateSpace(openResult.value.space);
    await recordEvent(repo, {
      runId: openResult.value.agreement.runId, kind: "COMMERCE", title: "Agreement opened", status: "SUCCESS",
      description: `${openResult.value.agreement.client} → ${openResult.value.agreement.provider}, ${openResult.value.agreement.price.amount} ${openResult.value.agreement.price.asset}.`,
      objectRef: openResult.value.agreement.agreementId,
      metadata: { spaceId: body.spaceId, amount: openResult.value.agreement.price.amount, asset: openResult.value.agreement.price.asset },
    });

    return NextResponse.json(
      {
        data: {
          agreement: {
            ...openResult.value.agreement,
            availableOps: availableAgreementOps(openResult.value.agreement.status),
          },
          space: openResult.value.space,
        },
        backend,
        evidenceLevel: "LOCAL_PASS",
      },
      { status: 201 },
    );
  }

  // Lifecycle transition operations. Each is an instruction from a party, so it
  // must prove which party sent it (F55); the API never takes a caller's word.
  if (!body.auth) {
    return NextResponse.json({ error: "SIGNATURE_REQUIRED", backend }, { status: 401 });
  }

  const agreement = repo.getAgreement
    ? await repo.getAgreement(body.agreementId)
    : (await repo.listAgreements()).find((a) => a.agreementId === body.agreementId) ?? null;

  if (!agreement) {
    return NextResponse.json(
      { error: "AGREEMENT_NOT_FOUND", agreementId: body.agreementId, backend },
      { status: 404 },
    );
  }

  const { auth, ...signedFields } = body;
  if (!mayInstruct(agreement, body.op as AgreementOp, auth.actor)) {
    return NextResponse.json({ error: "ACTOR_NOT_PERMITTED", op: body.op, actor: auth.actor, backend }, { status: 403 });
  }
  const actor = await repo.getAgent(auth.actor);
  if (!actor) {
    return NextResponse.json({ error: "ACTOR_NOT_REGISTERED", actor: auth.actor, backend }, { status: 401 });
  }
  // The hash covers the PARSED body, so what was signed is exactly what is applied.
  const verdict = await verifySignedRequest({
    request: {
      op: body.op, agreementId: agreement.agreementId, fromStatus: agreement.status, actor: auth.actor,
      bodyHash: requestBodyHash(signedFields), expiresAt: auth.expiresAt,
    },
    auth: { signer: auth.signer as `0x${string}`, chainId: auth.chainId, signature: auth.signature as `0x${string}` },
    agent: actor,
    now: Math.floor(Date.now() / 1000),
    verifier: signatureVerifierFor(auth.chainId),
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason, backend }, { status: 401 });
  }

  const spaceId = body.spaceId ?? agreement.spaceIds?.[0];
  if (!spaceId) {
    return NextResponse.json(
      { error: "SPACE_ID_REQUIRED", agreementId: body.agreementId, backend },
      { status: 400 },
    );
  }

  const space = repo.getSpace
    ? await repo.getSpace(spaceId)
    : (await repo.listSpaces()).find((s) => s.spaceId === spaceId) ?? null;

  if (!space) {
    return NextResponse.json(
      { error: "SPACE_NOT_FOUND", spaceId, backend },
      { status: 404 },
    );
  }

  // ── LP-6: the chain half of a dual write, BEFORE the database half ──────────
  //
  // Order is the whole design, and neither ordering is safe alone. Database-then-chain
  // leaves an agreement claiming capital it does not have with nothing to retry;
  // chain-then-database leaves capital escrowed with no agreement recording it. So the
  // chain goes first, and if its write is lost the RETRY heals the database instead of
  // funding a second escrow — `executeEscrowLock` probes and returns `skipped`.
  //
  // Both halves are idempotent under replay, which is what makes the ordering survivable.
  const escrowStep = await runEscrowStep(agreement, body.op as AgreementOp, body.onChainEscrow);
  if (escrowStep.refused) {
    // A requested escrow that cannot be executed is a REFUSAL, never a silent skip.
    // Recording the intent and answering 200 is the defect LP-6 exists to remove: an
    // agreement that looks funded while no capital is escrowed.
    await recordEvent(repo, {
      runId: agreement.runId, kind: "COMMERCE", title: `Agreement ${body.op} refused`, status: "WARNING",
      description: `On-chain escrow ${escrowStep.refused.action} refused: ${escrowStep.refused.reason}.`,
      objectRef: agreement.agreementId,
      metadata: {
        op: body.op,
        reason: escrowStep.refused.reason,
        ...(body.onChainEscrow ? { chain: body.onChainEscrow.chain } : {}),
        ...(escrowStep.refused.detail ? { detail: escrowStep.refused.detail } : {}),
      },
    });
    return NextResponse.json({ error: escrowStep.refused.reason, backend, detail: escrowStep.refused.detail }, { status: 409 });
  }

  // `commitAgreementOp` loads the agreement's saga, applies the op through the
  // store-free kernel, and persists the whole result — agreement first, then sagas.
  // That order is the F77 fix, and it lives in ONE function so the test suite and the
  // route cannot drift apart on it.
  const opResult = await commitAgreementOp(
    repo,
    space,
    agreement,
    body.op as AgreementOp,
    {
      capability: body.capability,
      amount: body.amount as unknown as { asset: Agreement["price"]["asset"]; amount: number } | undefined,
      artifactRefs: body.artifactRefs,
      contentHash: body.contentHash,
      failureReason: body.failureReason,
      onChainEscrow: body.onChainEscrow,
      // F94: the deadline check needs a clock, and a kernel must be given one rather than
      // reading `Date.now()` — otherwise whether a submission counts is not testable.
      now,
    },
  );

  if (!opResult.ok) {
    await recordEvent(repo, {
      runId: agreement.runId, kind: "COMMERCE", title: `Agreement ${body.op} refused`, status: "WARNING",
      description: `${body.op} was refused: ${opResult.reason}.`, objectRef: agreement.agreementId,
      metadata: { op: body.op, reason: opResult.reason, from: agreement.status },
    });
    return NextResponse.json(
      { error: opResult.reason, backend },
      { status: 400 },
    );
  }

  // Already persisted by `commitAgreementOp`, in the order that matters.
  await recordEvent(repo, {
    runId: agreement.runId, kind: "COMMERCE", title: `Agreement ${agreement.status} → ${opResult.value.agreement.status}`,
    status: opResult.value.agreement.status === "REJECTED" ? "WARNING" : "SUCCESS",
    description: `${body.op} applied.`, objectRef: agreement.agreementId,
    metadata: {
      op: body.op, from: agreement.status, to: opResult.value.agreement.status,
      // The chain half is recorded too. `escrowTxHash` appears ONLY when something was
      // broadcast — a skipped replay has none, and must not acquire a fake one, so the
      // absence is a missing key rather than an empty or placeholder string.
      ...(escrowStep.performed
        ? {
            escrowAction: escrowStep.performed.action,
            escrowSkipped: escrowStep.performed.skipped,
            ...(escrowStep.performed.txHash ? { escrowTxHash: escrowStep.performed.txHash } : {}),
          }
        : {}),
    },
  });

  // Fields are destructured rather than spread. `CoupledResult` carries `sagasToPersist` —
  // the internal write-set the caller had already applied — and `...opResult.value` published
  // it as API surface. Harmless today, but it invites a client to couple to a write-set that
  // is a persistence detail, and adding a field to the kernel would silently publish it.
  //
  // `deliverable` IS published: it is the work the provider signed and the evaluator judges
  // (F94), so a client needs it.
  const { space: spaceAfter, agreement: agreementAfter, saga, deliverable } = opResult.value;
  return NextResponse.json({
    data: {
      space: spaceAfter,
      agreement: {
        ...agreementAfter,
        availableOps: availableAgreementOps(agreementAfter.status),
      },
      ...(saga ? { saga } : {}),
      ...(deliverable ? { deliverable } : {}),
    },
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}

/**
 * The on-chain half of a commercial transition (LP-6).
 *
 * Extracted from `POST` so the ordering is readable in one place and so the route stays a
 * sequence of decisions rather than a sequence of chain calls.
 *
 * Returns `refused` for anything that must stop the transition, and `performed`
 * describing what actually happened on chain. **Never returns a synthetic transaction
 * hash**: `performed.txHash` is present only when a broadcast happened.
 *
 * A caller that did not ask for an on-chain escrow gets `{}` — no rail is consulted and
 * no chain is touched, so the ordinary offline lifecycle is untouched.
 */
async function runEscrowStep(
  agreement: Agreement,
  op: AgreementOp,
  /** The request's escrow ref, when the caller supplied one. */
  requestedFromRequest?: { chain: string; contractAddress: string; jobId: string; timeout?: number },
): Promise<
  | { refused?: undefined; performed?: EscrowOutcome & { ok: true } }
  | { refused: { action: string; reason: string; detail?: string }; performed?: undefined }
> {
  const action = ESCROW_ACTION_FOR_OP[op];
  if (!action) return {}; // open/startExecution/submit are not chain moments.

  // **The escrow comes from the AGREEMENT unless the caller restates it.**
  //
  // Every op after `fund` needs to reach the escrow, and `onChainEscrow` is a request field
  // a client has no reason to still be carrying — `recovery.refundEscrow` sends `{ op:
  // "refund", agreementId }` and nothing else, because the agreement's own terms are where
  // the escrow is described. Requiring the caller to restate the chain made F97's refund op
  // a database-only transition: Mitra recorded `REFUNDED` while the chain kept the capital.
  //
  // The agreement records `escrowChain`, `escrowContract` and `escrowRef` (F97 added the
  // first two, precisely so this lookup is possible). A restated ref is still checked against
  // the agreement's — the jobId mismatch guard is unchanged — so restating cannot redirect.
  const requested = requestedFromRequest ?? (
    agreement.escrowRef && agreement.escrowChain
      ? {
          chain: agreement.escrowChain,
          contractAddress: agreement.escrowContract ?? agreement.payTo?.address ?? "",
          jobId: agreement.escrowRef,
          timeout: agreement.escrowTimeout ?? (Number.isFinite(Date.parse(agreement.deadline)) ? Math.floor(Date.parse(agreement.deadline) / 1000) : undefined),
        }
      : undefined
  );
  if (!requested) return {};

  const rail = resolveEscrowRail(requested.chain);
  if (!rail) {
    // Absence is a refusal. The caller asked for capital to be escrowed and this process
    // cannot reach the chain; recording the intent anyway is how an agreement ends up
    // looking funded with nothing escrowed.
    return { refused: { action, reason: "ESCROW_RAIL_NOT_CONFIGURED", detail: `no rail for chain "${requested.chain}"` } };
  }

  // Terms come from the AGREEMENT, never from the request. `onChainEscrow` carries a
  // jobId and a contract address — a caller-chosen identity would let one caller fund a
  // different escrow than the agreement's own §15.5 commitment covers.
  const jobId = escrowIdFor(agreement.agreementId);
  if (requested.jobId && requested.jobId.toLowerCase() !== jobId.toLowerCase()) {
    return {
      refused: {
        action,
        reason: "ESCROW_JOB_ID_MISMATCH",
        detail: `requested ${requested.jobId}, agreement derives ${jobId}`,
      },
    };
  }

  // The §15.5 commitment, derived through the KERNEL's own function rather than read off
  // the agreement. On `fund` it cannot be read: the kernel is what computes it, and the
  // chain step has to run first. Both sides call `onChainRefundRouteFor`, so the string
  // that is hashed here is the string the kernel commits and the recovery engine verifies.
  //
  // For a release or refund the agreement already carries the commitment, so the
  // chain-held hash is checked against what was actually committed rather than recomputed.
  const refundRouteHash = action === "locked"
    ? routeCommitment(onChainRefundRouteFor({ chain: requested.chain, contractAddress: requested.contractAddress, jobId }))
    : refundRouteHashFor(agreement);
  if (!refundRouteHash) {
    return { refused: { action, reason: "ESCROW_REFUND_ROUTE_UNCOMMITTED", detail: "no §15.5 commitment for this agreement" } };
  }

  // The escrow's PROVIDER must be an on-chain address, and it comes from `payTo` — the
  // term `assertSettlementBinding` records precisely so the payee cannot be chosen by
  // whoever calls settle (the F51 defect, caller-chosen payee, on chain).
  //
  // `agreement.provider` is a Mitra agent id (`agent_data_03`) and is NOT a valid EVM
  // address or Solana pubkey, so using it here produced `ESCROW_PROVIDER_DIFFERS` against
  // every real escrow. An agreement with no `payTo` cannot be escrowed on chain, and must
  // say so rather than escrow to a name.
  const providerAddress = agreement.payTo?.address;
  if (!providerAddress) {
    return {
      refused: {
        action,
        reason: "ESCROW_PROVIDER_ADDRESS_MISSING",
        detail: `agreement ${agreement.agreementId} has no payTo.address, so there is no on-chain provider to escrow for`,
      },
    };
  }

  // The escrow's chain and the agreement's payTo chain must agree. An escrow on
  // Base Sepolia paying a `payTo` recorded for Solana is incoherent: the provider address
  // would be a base58 pubkey where the contract wants 20 bytes, and the payout could not
  // land. The Space already refuses a `payTo` on a chain it does not settle
  // (`SETTLEMENT_CHAIN_NOT_ALLOWED_IN_SPACE`), which is why this surfaced while writing
  // the tests — but that check is about the Space, not about the escrow being requested.
  if (!railMatchesPayTo(rail, agreement.payTo!.chain)) {
    return {
      refused: {
        action,
        reason: "ESCROW_CHAIN_DISAGREES_WITH_PAYTO",
        detail: `escrow on ${requested.chain} but payTo is recorded for ${agreement.payTo!.chain}`,
      },
    };
  }

  // ── Terms are RAIL-SPECIFIC, and guessing here is how the two rails drift ──────
  //
  // The same agreement means different numbers on different chains, so there is no
  // single conversion:
  //
  //   EVM     `client` is a deployed MitraVault address the caller names; `amount` is the
  //           token in base units; the refund returns tokens to that vault.
  //   Solana  `client` is FIXED BY THE SIGNING KEY — `vaultPda(client)` derives the vault
  //           from it and the program checks it as the authority — so it is read from the
  //           rail, never taken from the request; `amount` is lamports.
  //
  // Reading `client` from `requested.contractAddress` on both rails is what the first
  // version did, and on Solana it would have compared a base58 authority against an
  // EVM-shaped address and reported `ESCROW_PROVIDER_DIFFERS` for every probe.
  let lamports: bigint | null = null;
  if (rail.solana) {
    try {
      lamports = lamportsFor(agreement);
    } catch (e) {
      return { refused: { action, reason: "SOLANA_ESCROW_AMOUNT_UNSUPPORTED", detail: (e as Error).message } };
    }
  }
  // The agreement's own `escrowTimeout` is preferred over the deadline: it is what the
  // escrow was opened with, and every probe compares these terms exactly.
  const timeoutSeconds = agreement.escrowTimeout ?? requested.timeout ?? Math.floor(new Date(agreement.deadline).getTime() / 1000);
  const timeout = BigInt(timeoutSeconds);
  const intended: EscrowTerms = rail.solana
    ? {
        amount: lamports!,
        provider: providerAddress,
        client: rail.solana.authority,
        timeout,
      }
    : {
        amount: agreementOnChainAmount(agreement),
        provider: providerAddress,
        client: requested.contractAddress,
        timeout,
      };

  if (action === "locked") {
    // `rail.evm` decides whether there IS an EVM leg; `escrowEvmTerms` decides whether the
    // parties for that leg can be named. Both must hold before anything is broadcast.
    let evmTerms: { clientVault: `0x${string}`; token: `0x${string}`; evaluator: `0x${string}` } | undefined;
    if (rail.evm) {
      const terms = escrowEvmTerms(agreement, requested, rail);
      if (!terms.ok) return { refused: { action, reason: terms.reason, detail: terms.detail } };
      evmTerms = terms.value;
    }
    const outcome = await executeEscrowLock({
      agreement, intended, refundRouteHash, rail,
      evm: evmTerms,
    });
    return outcome.ok ? { performed: outcome } : { refused: outcome };
  }

  const outcome = action === "released"
    ? await executeEscrowRelease(agreement, rail, intended)
    : await executeEscrowRefund(agreement, rail, intended);
  return outcome.ok ? { performed: outcome } : { refused: outcome };
}

/**
 * Heal an agreement whose escrow has been refunded by a third party (F97).
 *
 * Never throws: reconciliation is an enrichment of a read, and a chain that cannot be reached
 * must degrade to "the number we already had" rather than fail the request. It is also
 * strictly one-directional — see `lib/commerce/escrow-reconcile.ts` for why a
 * chain-COMPLETED escrow is not advanced here.
 */
async function reconcileOnRead(repo: Awaited<ReturnType<typeof getStore>>["repo"], agreement: Agreement): Promise<Agreement> {
  if (!agreement.escrowRef || !agreement.payTo) return agreement;
  // The ESCROW's chain, not the payee's. They are not always the same string — a testnet
  // escrow pays a `base` payTo — and the escrow is where the capital is.
  const rail = resolveEscrowRail(agreement.escrowChain ?? agreement.payTo.chain);
  if (!rail) return agreement;
  try {
    const intended: EscrowTerms = {
      amount: agreementOnChainAmount(agreement),
      provider: agreement.payTo.address,
      client: rail.solana ? rail.solana.authority : (agreement.escrowContract ?? agreement.payTo.address),
      // The probe compares terms, so the timeout has to be the one the escrow was opened
      // with. It is not stored on the agreement, so an absent value means the agreement has
      // no escrowed terms to compare and there is nothing to reconcile against.
      timeout: escrowTimeoutOf(agreement),
    };
    const outcome = await reconcileEscrow({ agreement, rail, intended });
    if (!outcome.changed) return agreement;

    const healed: Agreement = { ...agreement, status: outcome.to, escrowReleased: true, version: agreement.version + 1 };
    await repo.updateAgreement!(healed);
    await recordEvent(repo, {
      runId: agreement.runId, kind: "RECOVERY",
      title: `Agreement ${outcome.from} → REFUNDED (escrow refunded on chain)`,
      status: "WARNING",
      description: `The escrow for ${agreement.agreementId} was refunded on chain by a party other than Mitra. ` +
        `The agreement was reconciled to match; without this it would keep reporting ${outcome.from} over capital that has already been returned.`,
      objectRef: agreement.agreementId,
      metadata: { agreementId: agreement.agreementId, from: outcome.from, to: outcome.to, escrowId: escrowIdFor(agreement.agreementId), reconciled: true },
    });
    return healed;
  } catch {
    // A chain that cannot be reached is not a reason to fail a read.
    return agreement;
  }
}

/**
 * The deadline the escrow was opened with, as unix seconds.
 *
 * `runEscrowStep` uses `requested.timeout ?? deadline`, so a request may have set its own.
 * The agreement does not record which, so the deadline is used and, when an agreement has an
 * escrow but no deadline-derived timeout, reconciliation simply finds no terminal divergence
 * rather than guessing. Guessing a timeout here would let a live escrow read as timed out.
 */
function escrowTimeoutOf(agreement: Agreement): bigint {
  const parsed = Date.parse(agreement.deadline);
  return Number.isFinite(parsed) ? BigInt(Math.floor(parsed / 1000)) : 0n;
}

/**
 * The EVM-only escrow terms, resolved or refused (F96).
 *
 * ## Why this is not a cast
 *
 * `MitraJobEscrow` takes `evaluator` as an `address` and treats it as an **authority**: it is
 * one of the two callers permitted to `refundJob` for a failed verdict. The agreement names
 * its evaluator as a Mitra **agent id** — `sandbox_provider`, `agent_eval_02` — so the first
 * implementation cast the string and let viem fail inside the ABI encode, surfacing as
 * `BROADCAST_FAILED` with a viem error message and no indication that the evaluator had never
 * been an address at all.
 *
 * So the resolution is explicit: use the agreement's evaluator **only if it is an address**,
 * otherwise fall back to the relayer's own address — which is the party this transport has
 * actually authorised to execute verdicts — and if neither exists, **refuse**. A placeholder
 * address here would silently confer refund authority on nobody, which is worse than an
 * error because the escrow would still fund.
 *
 * `token` is resolved the same way for the same reason: the old code defaulted it to the
 * **zero address** when unset, which is an escrow holding nothing at an address that exists.
 */
function escrowEvmTerms(
  agreement: Agreement,
  requested: { chain: string; contractAddress: string },
  rail: { evm?: { evaluatorFallback?: `0x${string}` } },
): { ok: true; value: { clientVault: `0x${string}`; token: `0x${string}`; evaluator: `0x${string}` } } | { ok: false; reason: string; detail: string } {
  if (!isAddress(requested.contractAddress)) {
    return { ok: false, reason: "ESCROW_CLIENT_VAULT_NOT_AN_ADDRESS", detail: requested.contractAddress };
  }
  const token = process.env.MITRA_ESCROW_TOKEN_ADDRESS;
  if (!token || !isAddress(token)) {
    return {
      ok: false,
      reason: "ESCROW_TOKEN_NOT_CONFIGURED",
      detail: `MITRA_ESCROW_TOKEN_ADDRESS is ${token ?? "absent"}; refusing to fund an escrow at the zero address`,
    };
  }
  const named = agreement.evaluator ?? agreement.provider;
  const evaluator = isAddress(named)
    ? named
    : rail.evm?.evaluatorFallback;
  if (!evaluator) {
    return {
      ok: false,
      reason: "ESCROW_EVALUATOR_UNRESOLVABLE",
      detail: `evaluator "${named}" is a Mitra agent id, not an address, and this rail has no fallback address`,
    };
  }
  return { ok: true, value: { clientVault: requested.contractAddress as `0x${string}`, token: token as `0x${string}`, evaluator } };
}

/** True when the rail's chain can carry a payout to an address recorded for `payToChain`. */
function railMatchesPayTo(rail: EscrowRail, payToChain: string): boolean {
  if (rail.chain === "solana") return payToChain === "solana";
  // `base` and `tempo` are the two EVM rails; either address is 20 bytes on either.
  return payToChain === "base" || payToChain === "tempo";
}

/**
 * Which ops move value on chain. Everything else is database-only by design.
 *
 * `refund` was missing (F97): a client changing their mind about a funded escrow left the
 * chain holding capital while Mitra said `FUNDED`, and a timeout refund performed by a keeper
 * — who is not a party and tells nobody — was invisible to the agreement entirely.
 */
const ESCROW_ACTION_FOR_OP: Partial<Record<AgreementOp, "locked" | "released" | "refunded">> = {
  fund: "locked",
  acceptDeliverable: "released",
  rejectDeliverable: "refunded",
  refund: "refunded",
};

/**
 * The escrowed amount in LAMPORTS, for the Solana rail.
 *
 * Solana escrows native lamports, not a token, so a decimal USDC amount has no direct
 * conversion — and inventing one would put the wrong number of lamports in an account whose
 * balance is the whole guarantee. **1 USDC == 1 lamport is refused, not approximated**: a
 * devnet/testnet placeholder that silently differs from mainnet by nine orders of magnitude
 * is exactly the kind of value that looks fine in testing and is catastrophic live.
 */
function lamportsFor(agreement: Agreement): bigint {
  const { amount } = agreement.price;
  if (amount !== 1) {
    throw new Error(
      `SOLANA_ESCROW_AMOUNT_NOT_1: the Solana rail escrows lamports and this agreement prices ${amount} ${agreement.price.asset}; ` +
      `refusing to guess a lamports-per-token conversion`,
    );
  }
  return 1n;
}

/**
 * The escrowed amount, in the asset's smallest unit.
 *
 * A `Money` amount is a decimal number, and an escrow holds an integer number of base
 * units. Converting through a string keeps 10.10 from becoming 10.099999…, which would
 * be a different commitment and a permanent `ESCROW_AMOUNT_DIFFERS` on the next probe.
 */
function agreementOnChainAmount(agreement: Agreement): bigint {
  const { amount } = agreement.price;
  // Six decimals for USDC and USDT; anything else must say so rather than guess.
  const decimals = USDC_DECIMALS[agreement.price.asset] ?? 6;
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

const USDC_DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 };
