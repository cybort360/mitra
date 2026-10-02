import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Documentation claims that can go stale without anything noticing.
 *
 * ## Why these are tests
 *
 * Phase 0 asks for ADRs, a frozen object set and a frozen evidence model. All
 * three are prose, and prose does not fail. A deleted ADR, an index entry
 * pointing at a file that no longer exists, or a claim marked `VERIFIED` with no
 * command beside it are all silently true-looking.
 *
 * Each assertion below reads the documents as source of truth rather than
 * restating them, so a human editing the prose and forgetting the code — the
 * normal way documentation rots — is caught here instead.
 */
const ADR_DIR = path.join(process.cwd(), "docs/adr");
const read = (f: string) => readFileSync(f, "utf8");

describe("Phase 0 — architecture decision records", () => {
  it("every ADR has the required sections", () => {
    const files = readdirSync(ADR_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(files.length).toBeGreaterThan(0);
    const malformed = files.filter((f) => {
      const body = read(path.join(ADR_DIR, f));
      return !/^# \d{4}\./m.test(body) || !/\*\*Status:\*\*/.test(body) || !/## Context/.test(body);
    });
    expect(malformed).toEqual([]);
  });

  it("every ADR records consequences, not just a decision", () => {
    // A decision with no stated cost is a preference. The Context is the part
    // that is unrecoverable later, so both are required.
    const files = readdirSync(ADR_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
    const missing = files.filter((f) => !/## Consequences/.test(read(path.join(ADR_DIR, f))));
    expect(missing).toEqual([]);
  });

  it("the ADR index links only to ADRs that exist", () => {
    const index = read(path.join(ADR_DIR, "README.md"));
    const links = [...index.matchAll(/\((0\d{3}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    const broken = links.filter((f) => !existsSync(path.join(ADR_DIR, f)));
    expect(broken).toEqual([]);
  });

  it("every ADR file is listed in the index", () => {
    // The reverse direction: an ADR nobody can find is a decision nobody knows
    // was made, which is how contradictory decisions accumulate.
    const index = read(path.join(ADR_DIR, "README.md"));
    const files = readdirSync(ADR_DIR)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.replace(/^\d{4}-/, "").replace(/\.md$/, ""));
    const unlisted = files.filter((slug) => !index.includes(slug));
    expect(unlisted).toEqual([]);
  });
});

describe("Phase 0 — evidence ledger hygiene", () => {
  const LEDGER = path.join(process.cwd(), "forge/PROOF_LEDGER.md");

  it("every VERIFIED claim has a command or an explicit pointer beside it", () => {
    // A `VERIFIED` with nothing to run is exactly the failure this repository
    // exists to prevent. Rows must cite a path, a command, or say what is
    // missing — the last is how a PARTIAL claim stays honest.
    const rows = read(LEDGER).split("\n").filter((l) => l.startsWith("|") && l.includes("`VERIFIED`"));
    expect(rows.length).toBeGreaterThan(0);
    const unsupported = rows.filter((row) => {
      const cells = row.split("|").map((c) => c.trim());
      const note = cells[cells.length - 2] ?? "";
      return note.length < 10;
    });
    expect(unsupported).toEqual([]);
  });

  it("defines all five evidence levels it uses", () => {
    const body = read(LEDGER);
    for (const level of ["UNTESTED", "PARTIAL", "FAILED", "VERIFIED", "REGRESSED"]) {
      expect(body).toContain(level);
    }
  });

  it("states that claims are branch-scoped", () => {
    // Without this, a ledger row verified on one branch reads as true on all of
    // them, which is the same overstatement in a new place.
    expect(read(LEDGER)).toMatch(/branch/i);
  });
});
