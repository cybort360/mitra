import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import type { Space } from "@/lib/domain/types";
// Mirrors the closed `AssetSymbol` union in lib/domain/types.ts. Kept as a
// literal tuple rather than derived, because `z.enum` needs a runtime value;
// the typecheck below fails if the union gains a member and this is not updated.
const ASSET_SYMBOLS = [
  "USDC", "USDT", "SOL", "ETH",
  "PathUSD", "AlphaUSD", "BetaUSD", "ThetaUSD", "OpenUSD",
] as const;
import { externalRulesChanged, isExternallyGoverned, validateGovernance } from "@/lib/kernel/space-governance";


/**
 * List Spaces (PRD §13.1) — the bounded commercial contexts.
 *
 * New surface: the Space type did not exist until Phase 4, and it is the
 * containment boundary every agreement is scoped to. It is read-only here — the
 * write path is the pure kernel in `lib/kernel/commerce.ts`, so a transition is
 * computed and validated before anything is persisted.
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const spaces = await repo.listSpaces();
  return NextResponse.json({
    data: spaces.map((s) => {
      const governance = validateGovernance(s.governance);
      return {
        spaceId: s.spaceId,
        status: s.status,
        governance: {
          mode: s.governance.mode,
          admins: s.governance.admins,
          governors: s.governance.governors,
          threshold: s.governance.threshold,
          valid: governance.ok,
          invalidReason: governance.ok ? null : governance.reason,
        },
        rules: {
          source: s.rules.source,
          ruleSetRef: s.rules.ruleSetRef ?? null,
          digest: s.rules.digest,
          externallyGoverned: isExternallyGoverned(s),
        },
        headroom: { asset: s.budget.asset, amount: s.budget.amount - s.committed.amount },
        admittedAssets: Object.keys(s.assets ?? {}),
        participants: s.participants.length,
      };
    }),
    count: spaces.length,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}

/**
 * Whether an external rule set has drifted from the digest the Space agreed to.
 *
 * A QUESTION rather than a property, because it needs an observed digest from
 * outside. New terms are never adopted automatically: a digest change is a change
 * of terms the participants agreed to something else, and adopting it silently
 * would hand the rule-set publisher unilateral power over every participant.
 */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { spaceId?: string; observedDigest?: string } | null;
  if (!body?.spaceId || !body.observedDigest) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const { repo } = await getStore();
  const space = (await repo.listSpaces()).find((s) => s.spaceId === body.spaceId);
  if (!space) return NextResponse.json({ error: "SPACE_NOT_FOUND" }, { status: 404 });

  const changed = externalRulesChanged(space, body.observedDigest);
  return NextResponse.json({
    data: {
      spaceId: space.spaceId,
      agreedDigest: space.rules.digest,
      observedDigest: body.observedDigest,
      changed,
      action: changed ? "RE_AGREEMENT_REQUIRED" : "NONE",
    },
    evidenceLevel: "LOCAL_PASS",
  });
}

/**
 * Create a Space (PRD §13.1, PK1).
 *
 * The write path is deliberately NOT `listSpaces` + push. A Space is the
 * containment boundary every agreement is scoped to, so its governance, budget
 * and capability allow-list are validated HERE, once, before the row exists —
 * rather than trusted at read time and re-checked by every consumer.
 */
const createBody = z.object({
  spaceId: z.string().min(1).optional(),
  owner: z.string().min(1),
  // Asset is a closed union, not free text. A Space admitting an unknown symbol
  // would resolve no mint address later, so the refusal belongs at the boundary.
  budget: z.object({ asset: z.enum(ASSET_SYMBOLS), amount: z.number().nonnegative() }),
  participants: z.array(z.string().min(1)),
  allowedCapabilities: z.array(z.string().min(1)),
  governance: z.object({
    mode: z.enum(["ADMIN", "QUORUM"]),
    admins: z.array(z.string()),
    governors: z.array(z.string()),
    threshold: z.number().int(),
  }).optional(),
  rules: z.object({
    source: z.enum(["mitra", "external"]),
    ruleSetRef: z.string().optional(),
    digest: z.string().optional(),
  }).optional(),
  assets: z.record(z.string(), z.object({ address: z.string(), decimals: z.number().int() })).optional(),
  settlementChains: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const { repo, backend } = await getStore();
  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_SPACE", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  const governance = b.governance ?? {
    mode: "ADMIN" as const,
    admins: [b.owner],
    governors: [b.owner],
    threshold: 1,
  };
  // A governance config that does not validate would make the Space unbindable or
  // (worse) bindable by anyone. Refuse before persisting.
  const gov = validateGovernance(governance);
  if (!gov.ok) {
    return NextResponse.json({ error: "INVALID_GOVERNANCE", reason: gov.reason }, { status: 400 });
  }

  if (b.budget.amount <= 0) {
    return NextResponse.json({ error: "INVALID_SPACE", reason: "BUDGET_MUST_BE_POSITIVE" }, { status: 400 });
  }
  if (!b.participants.includes(b.owner)) {
    // The owner is not automatically an authority (ADR-0011) — but it also must
    // not be silently outside the containment boundary it created.
    return NextResponse.json({ error: "INVALID_SPACE", reason: "OWNER_NOT_IN_PARTICIPANTS" }, { status: 400 });
  }

  const space: Space = {
    spaceId: b.spaceId ?? `space_${Math.random().toString(36).slice(2, 10)}`,
    owner: b.owner,
    governance,
    // An EXTERNAL rule set must name its digest — that is how a later change
    // becomes visible instead of silently applying. A MITRA-owned Space gets a
    // stable local identity.
    rules:
      b.rules?.source === "external"
        ? {
            source: "external",
            ruleSetRef: b.rules.ruleSetRef ?? "unknown:external",
            digest: b.rules.digest ?? "MISSING_DIGEST",
          }
        : { source: "mitra", digest: "mitra:core:v1" },
    status: "ACTIVE",
    participants: b.participants,
    allowedCapabilities: b.allowedCapabilities,
    settlementChains: b.settlementChains ?? [],
    ...(b.assets ? { assets: b.assets } : {}),
    budget: { asset: b.budget.asset, amount: b.budget.amount },
    committed: { asset: b.budget.asset, amount: 0 },
    version: 1,
    createdAt: new Date().toISOString(),
  };

  if (!repo.createSpace) {
    return NextResponse.json({ error: "BACKEND_MISSING_CREATE_SPACE" }, { status: 501 });
  }
  await repo.createSpace(space);
  return NextResponse.json({ data: space, backend, evidenceLevel: "LOCAL_PASS" }, { status: 201 });
}
