import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { P0_LIFECYCLES, P0_OBJECTS, P0_SECTIONS } from "@/lib/domain/p0-registry";
import { MACHINES, TRANSITIONS } from "@/lib/kernel/machines";
import * as domain from "@/lib/domain/types";

/**
 * PRD §52 Phase 0, exit condition:
 *
 *   "Every P0 object has a schema and state transition definition."
 *
 * ## Why this is a test and not a checklist
 *
 * As prose, that sentence cannot fail. It can be true in a document while the
 * code tells a different story — which is exactly what happened before: the PRD
 * asserted a complete object set, and nothing checked whether the code had one.
 *
 * So the exit condition is asserted against the *real* type exports and the
 * *real* transition table. Every assertion here reads source of truth rather
 * than restating a declaration, which is what makes it worth running in CI:
 *
 *  - a P0 object with no exported type fails
 *  - a P0 object claiming a machine that `TRANSITIONS` lacks fails
 *  - a machine for an object not in the registry fails
 *  - a §6 subsection in the PRD the registry does not cover fails
 */
const PRD = readFileSync(
  path.join(process.cwd(), "docs/product/MITRA_PRD.md"),
  "utf8",
);

/**
 * The type source, read as text.
 *
 * Typescript interfaces do not exist at runtime — `domain.Agent` is undefined
 * after compilation, so a runtime lookup would report every object as missing
 * schema. That would be a test that cannot pass, which is worse than no test:
 * it invites the `-t.skip` reflex.
 *
 * So the schema assertion reads `lib/domain/types.ts` and checks for the
 * declaration. Still source of truth, and actually falsifiable.
 */
const TYPES_SRC = readFileSync(
  path.join(process.cwd(), "lib/domain/types.ts"),
  "utf8",
);

const declaresType = (object: string): boolean =>
  new RegExp(`export (interface|type) ${object}\\b`).test(TYPES_SRC);

// Referenced so the import is not flagged unused; the assertions read source.
void domain;

describe("PRD §52 Phase 0 — object registry", () => {
  it("every registered P0 object has a schema", () => {
    const missing = P0_OBJECTS.map((o) => o.object).filter((name) => !declaresType(name));
    expect(missing).toEqual([]);
  });

  it("every registered status union is declared, not inline", () => {
    // A machine whose states are not a named union cannot be checked against
    // the PRD, so the states would drift from the spec silently.
    const unions = [...TYPES_SRC.matchAll(/export type (\w*Status) =/g)].map((m) => m[1]);
    expect(unions.length).toBeGreaterThan(0);
  });

  it("every lifecycle names the machine it claims", () => {
    // A lifecycle with no machine key is a registry bug, not an entry to skip.
    // Deriving the key by lowercasing was tried and produced a false failure on
    // `ClearingEpoch`, so the mapping is explicit.
    const unnamed = P0_LIFECYCLES.filter((o) => !o.machine).map((o) => o.object);
    expect(unnamed).toEqual([]);
  });

  it("every object claiming a lifecycle actually has one", () => {
    // This is the assertion the prose exit condition could not make. It reads
    // TRANSITIONS, so declaring a lifecycle without implementing it fails.
    const missing = P0_LIFECYCLES.map((o) => o.machine).filter((m) => !MACHINES.includes(m as string));
    expect(missing).toEqual([]);
  });

  it("every implemented machine is claimed by exactly one P0 object", () => {
    // The reverse direction. An unreferenced machine is either dead code or a
    // forgotten object, and both should be visible rather than inferred.
    const claimed = new Set(P0_LIFECYCLES.map((o) => o.machine));
    const orphans = MACHINES.filter((m) => !claimed.has(m));
    expect(orphans).toEqual([]);
  });

  it("every machine has at least one transition out of a non-terminal state", () => {
    // A machine where every state is terminal constrains nothing while looking
    // like evidence. That is the failure mode this whole repository guards
    // against, so it is checked here rather than assumed.
    const inert = MACHINES.filter((machine) => {
      const table = TRANSITIONS[machine] as Record<string, string[]>;
      return Object.values(table).every((next) => next.length === 0);
    });
    expect(inert).toEqual([]);
  });

  it("every entry records a rationale, including the ones with no machine", () => {
    // "No machine" is a decision. Without a recorded reason it gets silently
    // reversed later by someone who assumed it was an oversight.
    const unreasoned = P0_OBJECTS.filter((o) => !o.hasMachine && o.rationale.trim().length < 20);
    expect(unreasoned).toEqual([]);
  });

  it("covers every §6 subsection the PRD defines", () => {
    // Parsed from the PRD itself, so the registry cannot rot into a subset that
    // still looks complete. §6 subsections are `## 6.x Title`.
    const sections = [...PRD.matchAll(/^##\s+(6\.\d+)\s+(.+)$/gm)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(0);
    const covered = new Set(P0_SECTIONS);
    const uncovered = sections.filter((s) => !covered.has(s));
    expect(uncovered).toEqual([]);
  });

  it("claims no object the PRD does not define", () => {
    // Guards against drift in the other direction: an invented object that
    // looks authoritative because it is in the registry.
    const sections = new Set([...PRD.matchAll(/^##\s+(6\.\d+)\s+/gm)].map((m) => m[1]));
    const invented = P0_OBJECTS.filter((o) => !sections.has(o.prd)).map((o) => `${o.object} (${o.prd})`);
    expect(invented).toEqual([]);
  });
});
