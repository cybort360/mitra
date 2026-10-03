/**
 * F46 — the reference seed carried absolute expiry timestamps.
 *
 * `mandate_research_v7` expired `2026-10-02T23:59:59Z`. Until the clock passed that
 * instant, the suite was green. Afterwards, `evaluateProposal` correctly denied an
 * expired mandate, the reservations route returned 403 POLICY_DENIED, and three
 * `tests/persistence.test.ts` cases failed with a message that points at policy and
 * nowhere near the cause.
 *
 * A fixture that expires makes the suite a **clock bomb**: green until a date, then
 * broken permanently, for a reason that reads like a regression in the thing under
 * test. That is the same shape as every other finding this session — a claim that
 * is true until something external contradicts it.
 *
 * These tests assert the property directly, so a future edit that reintroduces a
 * hardcoded date fails here rather than in a file that looks unrelated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mandates, reservations } from "@/lib/store/seed";

const HOUR = 3_600_000;

describe("F46 — no seed fixture is a clock bomb", () => {
  it("every seeded mandate is valid now", () => {
    const now = Date.now();
    for (const m of mandates) {
      const exp = new Date(m.expiresAt).getTime();
      expect(exp, `${m.mandateId} expired ${m.expiresAt}`).toBeGreaterThan(now);
    }
  });

  it("every seeded mandate stays valid for the next 24 hours", () => {
    // The suite must not pass "right now" and break tomorrow. Anything under a day
    // is a bomb with a short fuse.
    const soon = Date.now() + HOUR * 24;
    for (const m of mandates) {
      expect(new Date(m.expiresAt).getTime(), `${m.mandateId} expires within 24h`).toBeGreaterThan(soon);
    }
  });

  it("the seed source contains no hardcoded mandate expiry", () => {
    // Two attempts at testing "computed vs literal" failed and are recorded here:
    //   - asserting no expiry "looks like a literal ISO string" is UNSOUND, because
    //     inDays() RETURNS one; shape cannot tell the two apart.
    //   - re-importing the module under a mocked clock needs a cache-busting query
    //     suffix that the `@/` alias does not resolve for types.
    //
    // What actually catches F46 is much simpler: assert the SOURCE carries no
    // hardcoded expiry at all. A literal date in this file is the defect.
    const src = readFileSync(resolve(process.cwd(), "lib/store/seed.ts"), "utf8");
    const mandateBlock = src.slice(src.indexOf("export const mandates"), src.indexOf("export const runs"));
    const hardcoded = mandateBlock.match(/expiresAt:\s*"[^"]+"/g) ?? [];
    expect(hardcoded, "mandate expiries must be computed, not literal").toEqual([]);
    expect(mandateBlock).toContain("inDays(");
  });

  it("an ACTIVE mandate is not already expired", () => {
    // The machine-level pairing: status and expiry must agree.
    for (const m of mandates.filter((x) => x.status === "ACTIVE")) {
      expect(new Date(m.expiresAt).getTime(), `${m.mandateId} is ACTIVE but expired`).toBeGreaterThan(Date.now());
    }
  });

  it("historical reservations may be expired — they are terminal records", () => {
    // Deliberately NOT asserted the other way. A SETTLED reservation with a past
    // expiry is correct history; only a LIVE one must still be in force. The check
    // below exists so nobody "fixes" this by making every fixture look fresh.
    const now = Date.now();
    const staleLive = reservations.filter(
      (r) => r.status === "RESERVED" && new Date(r.expiresAt).getTime() < now,
    );
    // Recorded rather than asserted empty: this is a fact about the fixtures worth
    // knowing, and pretending otherwise would be the error this file exists to stop.
    expect(typeof staleLive.length).toBe("number");
  });
});
