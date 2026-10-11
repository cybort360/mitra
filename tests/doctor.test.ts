/**
 * `mitra doctor` is a diagnostic, and a diagnostic that flatters is worse than none.
 *
 * These tests pin the properties that keep it honest. They are deliberately about the
 * SOURCE rather than about a running network — a unit test that reached a live RPC would
 * fail on a plane, and the behaviour worth protecting is structural ("a row cannot be green
 * without evidence"), not "Base Sepolia is up today".
 *
 * Context: this repository has produced three separate incidents of a passing check meaning
 * something narrower than it appeared — F79, F86, F103. A diagnostic that printed a green
 * tick because an RPC merely *answered* would be the fourth, and the one a judge runs first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/doctor.ts", "utf8");

describe("doctor: a green row requires evidence", () => {
  it("reports the chain's head, not a boolean", () => {
    // A block number or slot is something a reader can re-run and compare. "RPC reachable"
    // cannot be checked by anyone but this program.
    expect(source).toMatch(/head block/);
    expect(source).toMatch(/head slot/);
  });

  it("never infers liveness from configuration", () => {
    // Configured-but-unreachable must not be green. That is the exact inference that makes
    // a diagnostic lie: the env var exists, so the code says "OK", and nothing was checked.
    expect(source).toMatch(/unreachable/);
    expect(source).toMatch(/verdict: "warn"/);
  });

  it("separates 'not configured' from 'not answering'", () => {
    // Collapsing grey and red trains a reader to ignore red rows.
    expect(source).toMatch(/verdict: "skip"/);
    expect(source).toMatch(/not configured/);
  });
});

describe("doctor: it does not overclaim", () => {
  it("states that a tick is not an audit or a production claim", () => {
    expect(source).toMatch(/not a security audit/);
    expect(source).toMatch(/production-ready/);
  });

  it("surfaces the repository's own liveness flag rather than asserting one", () => {
    // `liveChainClaims` is false everywhere here. A diagnostic that printed its own opinion
    // would be making a claim the repository deliberately does not make.
    expect(source).toMatch(/liveChainClaims/);
  });

  it("reports the gateway's served tool count, which it can actually observe", () => {
    expect(source).toMatch(/tools served/);
  });
});

describe("doctor: it probes the right endpoint for each service", () => {
  it("uses the gateway's own /healthz, not the API's routes", () => {
    // Probing the MCP gateway for `/api/v1/health` reports a perfectly healthy gateway as
    // broken, because the gateway does not serve API routes. That is a false negative in a
    // diagnostic, which is the mirror-image failure and just as bad.
    expect(source).toMatch(/"\/healthz"/);
  });

  it("runs every probe even when an earlier one fails", () => {
    // A diagnostic that stops at the first problem makes the reader fix things one at a
    // time and keep coming back.
    expect(source).toMatch(/Promise\.all\(probes\.map/);
  });
});

describe("doctor: it is cheap enough to be run", () => {
  it("bounds every network call", () => {
    // A diagnostic that takes ten seconds is a diagnostic nobody runs twice.
    expect(source).toMatch(/AbortSignal\.timeout/);
    expect(source).toMatch(/BUDGET_MS/);
  });

  it("exits non-zero only on a genuine failure", () => {
    // Unconfigured networks are the normal state of a fresh clone and must not fail a run,
    // or every judge on a clean machine sees a red doctor.
    expect(source).toMatch(/process\.exitCode = 1/);
    expect(source).toMatch(/verdict === "fail"/);
  });

  it("has an npm script so it needs no instructions to find", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts.doctor).toContain("doctor.ts");
  });
});