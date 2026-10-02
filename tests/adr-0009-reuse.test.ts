import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards ADR-0009's refusals.
 *
 * The point of the ADR is that Mitra *reused Engraving's semantics* rather than
 * *porting Engraving's implementation*. That is a claim about a boundary, and a
 * boundary asserted in prose is a boundary that erodes — the next person
 * implementing "we need pause semantics" will find `EngravingStatus` sitting in
 * the source repo and take it.
 *
 * So the refusals are checked rather than promised.
 */
const TYPES = readFileSync(
  path.join(process.cwd(), "lib/domain/types.ts"), "utf8",
);
const AUTHZ = readFileSync(
  path.join(process.cwd(), "lib/kernel/authorization.ts"), "utf8",
);

describe("ADR-0009 — reuse, not port", () => {
  it("Mandate keeps version, principal and agent binding", () => {
    // The three properties that make an Engraving an Engraving. If these go,
    // "versioned authority" is no longer a claim Mitra can make.
    expect(TYPES).toMatch(/export interface Mandate/);
    expect(TYPES).toMatch(/version: number/);
    expect(TYPES).toMatch(/principal: string/);
    expect(TYPES).toMatch(/agentId: string/);
  });

  it("Mandate.status does NOT acquire Engraving's state machine", () => {
    // EngravingStatus = ACTIVE | PAUSED | REVOKED | EXPIRED.
    //
    // The first version of this assertion forbade the *words* PAUSED and REVOKED
    // and failed immediately — because Mitra's own `MandateStatus` already
    // contains "REVOKED" and "SUSPENDED". The assertion was wrong, not the code,
    // and it would have forced a rename of correct existing vocabulary.
    //
    // What actually matters is the *member set*, not the labels: Engraving's
    // distinctive member is PAUSED, and Mitra's SUSPENDED is a distinct concept
    // from Engraving's PAUSED. So: forbid PAUSED and EngravingStatus outright,
    // and assert Mitra's own set is unchanged.
    expect(TYPES).not.toMatch(/EngravingStatus/);
    expect(TYPES).not.toMatch(/"PAUSED"/);
    expect(TYPES).toMatch(
      /export type MandateStatus = "DRAFT" \| "ACTIVE" \| "EXPIRED" \| "REVOKED" \| "SUSPENDED";/,
    );
    // If Engraving's vocabulary were imported wholesale, PAUSED would appear
    // and one of Mitra's own members would likely be dropped. Pinning the exact
    // union makes that a compile-visible change rather than a silent one.
  });

  it("no COTI types leaked into the domain model", () => {
    // COTI was never a Mitra target (project ruling, PRD §50). Its type shapes
    // — `0x${string}` pubkeys, bigint version fields — would also break the
    // canonical serialization pinned in F11.
    expect(TYPES).not.toMatch(/0x\$\{string\}/);
    expect(TYPES).not.toMatch(/coti|COTI/);
  });

  it("the replay field remains caller-supplied — the gap ADR-0009 exists to close", () => {
    // This assertion documents a KNOWN WEAKNESS rather than endorsing it.
    // `consumedNonces` is optional, so a caller that omits it gets no replay
    // refusal. Phase 3 closes this by making Authorization a consumable
    // on-chain object. Until then this test fails if someone removes the field —
    // which would silently delete the only replay defence that exists.
    expect(AUTHZ).toMatch(/consumedNonces\?: number\[\]/);
  });

  it("the authorization decision is not permission — guard still present", () => {
    // ADR-0007 rule 3 and `AGENTS.md`: "an ALLOW decision is never itself
    // permission to move value". If this docstring disappears, the central
    // invariant of the project has been quietly dropped.
    expect(AUTHZ).toMatch(/not itself permission/i);
  });
});
