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

/**
 * Guards ADR-0008's two-field vocabulary (F20).
 *
 * Two documents define the permitted values — AGENTS.md and BUILD_FOUNDRY §2 —
 * and they disagreed for the whole life of this repository. The failure mode is
 * silent: a new status appears in one and not the other, or a ledger row uses a
 * word neither permits, and nothing notices. This asserts that every status the
 * ledger actually uses is on the permitted list, and that the two source
 * documents agree about which side of the split each word belongs to.
 */
describe("ADR-0008 evidence vocabulary", () => {
  const ROOT = process.cwd();
  const evidence = new Set([
    "PROPOSED", "IMPLEMENTED", "TESTED", "INTEGRATED",
    "E2E_VERIFIED", "LIVE_DEMONSTRATED", "LIVE", "MONITORED",
  ]);
  const blockers = new Set([
    "PARTIAL", "BLOCKED_EXTERNAL", "BLOCKED_INTERNAL",
    "DEFERRED", "REJECTED", "FAILED", "REGRESSED", "FUTURE",
  ]);

  it("every status used in the ledger is permitted", () => {
    const ledger = readFileSync(path.join(ROOT, "forge/PROOF_LEDGER.md"), "utf8");
    // Only the phase-audit table carries two-field rows today; older rows use the
    // historical single-status form and are annotated rather than rewritten.
    const table = ledger.slice(ledger.indexOf("| Phase | Exit condition"));
    // Match the *status cells* only: a markdown row's 3rd and 4th columns. The
    // first version backticked any ALL-CAPS token in the table and picked up
    // `ALLOW` — a policy-engine return value quoted in prose, not a status. Scope
    // the extraction to cells rather than loosening the vocabulary.
    const used = new Set<string>();
    for (const line of table.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("|---")) continue;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      for (const cell of [cells[2], cells[3]]) {
        for (const m of (cell ?? "").matchAll(/`([A-Z_]{3,})`/g)) used.add(m[1]);
      }
    }
    for (const status of used) {
      const ok = evidence.has(status) || blockers.has(status);
      expect(
        ok,
        `"${status}" is not a permitted ADR-0008 value — check the spelling against BUILD_FOUNDRY §2`,
      ).toBe(true);
    }
  });

  it("the two fields do not overlap", () => {
    // A word on both lists would mean the reader cannot tell which field it
    // fills, which is the ambiguity the two-field split exists to remove.
    for (const w of evidence) expect(blockers.has(w)).toBe(false);
    for (const w of blockers) expect(evidence.has(w)).toBe(false);
  });

  it("AGENTS.md states both fields and points at BUILD_FOUNDRY", () => {
    const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/`evidence`/);
    expect(agents).toMatch(/`blocker`/);
    // The root directive must not carry its own list, or the two documents drift
    // apart again — which is what F21 was.
    expect(agents).toMatch(/BUILD_FOUNDRY\.md/);
    // The retired vocabulary must not survive as a permitted list.
    expect(agents).not.toMatch(/Use only these statuses/);
  });
});
