/**
 * Phase 5 — "An external agent can participate without becoming Mitra-native."
 *
 * The claim is falsifiable in one direction: the surface must be able to express
 * the whole commercial lifecycle AND be incapable of moving capital. A test that
 * only checked the first would pass for a surface that simply handed over the
 * keys, which is the failure this phase exists to prevent.
 *
 * The A2A lifecycle is asserted to be a *separate* vocabulary from Mitra's. An
 * external agent that has to speak our state names is, in practice, a native —
 * interoperability is the translation, not the adoption.
 */
import { describe, expect, it } from "vitest";
import {
  A2A_TRANSITIONS,
  assertNoCapitalVerb,
  canTransitionTask,
  isProhibited,
  isTaskTerminal,
  mcpTools,
  prohibitedDirectTools,
  toAgreementStatus,
  surfaceWasValidated,
  type A2ATaskState,
  type ProhibitedTool,
} from "@/lib/mcp/surface";
import { mcpTools as reexportedTools } from "@/lib/mcp/tools";

describe("the surface cannot move capital", () => {
  it("no exposed tool is a capital-moving verb", () => {
    for (const t of mcpTools) expect(isProhibited(t), t).toBe(false);
  });

  it("no tool name even suggests a direct transfer", () => {
    // A belt-and-braces check the type system cannot make: a new tool called
    // "mitra_transfer_funds" would typecheck perfectly.
    const suspicious = /transfer|withdraw|send_|raw_|key|secret|export_key/i;
    for (const t of mcpTools) {
      expect(t, `${t} looks like a capital verb`).not.toMatch(suspicious);
    }
  });

  it("the prohibited list is refused if anything tries to surface one", () => {
    expect(() => assertNoCapitalVerb(["mitra_create_intent"])).not.toThrow();
    expect(() => assertNoCapitalVerb(["raw_arbitrary_transfer"])).toThrow(/capital-moving/i);
    expect(() => assertNoCapitalVerb(["mitra_get_intent", "raw_key_access"])).toThrow(/raw_key_access/);
  });

  it("all five prohibitions are recognised", () => {
    const expected: ProhibitedTool[] = [
      "raw_arbitrary_transfer", "raw_arbitrary_contract_call", "raw_account_export",
      "raw_key_access", "raw_policy_mutation",
    ];
    for (const p of expected) expect(isProhibited(p), p).toBe(true);
    expect(prohibitedDirectTools).toHaveLength(5);
  });

  it("the whole lifecycle IS expressible, so the restriction is not evasion", () => {
    // Without this, "no transfer verbs" could be satisfied by exposing nothing.
    const needed = [
      "mitra_register_agent", "mitra_create_intent", "mitra_request_authorization",
      "mitra_create_agreement", "mitra_fund_agreement", "mitra_submit_deliverable",
      "mitra_accept_deliverable", "mitra_reject_deliverable", "mitra_request_clearing",
    ];
    for (const t of needed) expect(mcpTools, t).toContain(t);
  });

  it("the import-time check actually RAN, not merely exists", () => {
    // Removing the `assertNoCapitalVerb(mcpTools)` call survived mutation audit,
    // because every other test asserts the PROPERTY and the property still held
    // with the guard deleted. The guard's own execution had no coverage.
    expect(surfaceWasValidated()).toBe(true);
  });

  it("tools.ts re-exports the SAME list, not a second definition", () => {
    // Two lists would drift, and the enforced one is the one nothing reviews.
    expect(reexportedTools).toEqual(mcpTools);
    expect(reexportedTools).toHaveLength(mcpTools.length);
  });
});

describe("the A2A lifecycle is its own vocabulary", () => {
  it("walks a submitted -> working -> completed task", () => {
    expect(canTransitionTask("submitted", "working").ok).toBe(true);
    expect(canTransitionTask("working", "completed").ok).toBe(true);
    expect(canTransitionTask("working", "failed").ok).toBe(true);
  });

  it("an agent blocked on its client can return to work", () => {
    expect(canTransitionTask("working", "input-required").ok).toBe(true);
    expect(canTransitionTask("input-required", "working").ok).toBe(true);
  });

  it("terminal states admit nothing", () => {
    for (const s of ["completed", "failed", "canceled"] as A2ATaskState[]) {
      expect(isTaskTerminal(s), s).toBe(true);
      for (const to of Object.keys(A2A_TRANSITIONS) as A2ATaskState[]) {
        expect(canTransitionTask(s, to).ok, `${s} -> ${to}`).toBe(false);
      }
    }
  });

  it("refuses an unknown state and a no-op", () => {
    expect(canTransitionTask("nonsense" as A2ATaskState, "working")).toEqual({ ok: false, reason: "UNKNOWN_STATE" });
    expect(canTransitionTask("working", "working")).toEqual({ ok: false, reason: "NO_OP_TRANSITION" });
  });

  it("A2A state names are NOT Mitra status names", () => {
    // Lower-case external vocabulary vs upper-case internal. Sharing names would
    // be how a foreign agent quietly becomes native.
    for (const s of Object.keys(A2A_TRANSITIONS)) {
      expect(s).toBe(s.toLowerCase());
    }
  });
});

describe("the translation is honest about what it cannot map", () => {
  it("maps the states that have an equivalent", () => {
    expect(toAgreementStatus("submitted")).toBe("OPEN");
    expect(toAgreementStatus("working")).toBe("EXECUTING");
    expect(toAgreementStatus("completed")).toBe("ACCEPTED");
    expect(toAgreementStatus("failed")).toBe("REJECTED");
    expect(toAgreementStatus("canceled")).toBe("CANCELED");
  });

  it("refuses to map input-required rather than calling it EXECUTING", () => {
    // An agent waiting on its client is NOT work in progress. Reporting it as
    // EXECUTING would make a stalled task look healthy, and the recovery machinery
    // would never be triggered for it.
    expect(toAgreementStatus("input-required")).toBeNull();
  });
});
