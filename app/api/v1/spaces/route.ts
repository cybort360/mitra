import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
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
