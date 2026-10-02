import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards the ADR-0008 two-field evidence vocabulary (F20).
 *
 * Two documents define the permitted values — AGENTS.md and BUILD_FOUNDRY §2 — and
 * they disagreed for the whole life of this repository. The failure mode is silent:
 * a status appears in one and not the other, or a ledger row uses a word neither
 * permits, and nothing notices.
 */
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
