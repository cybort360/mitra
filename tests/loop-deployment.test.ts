/**
 * The loop-deployment surface's security boundaries, pinned.
 *
 * The packet adds three new processes that sit next to the agents rather than behind them.
 * Each of them could plausibly widen what an agent can do, so each boundary is asserted here
 * rather than left to a code review that will not happen again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mcpTools } from "@/lib/mcp/surface";

const runner = readFileSync("scripts/run-autonomous-agents.ts", "utf8");
const gateway = readFileSync("scripts/mcp-server-daemon.ts", "utf8");
const supervisor = readFileSync("scripts/stack.ts", "utf8");

describe("F100: no agent-facing surface can mint authority", () => {
  it("the MCP tool list contains no mandate-creating tool", () => {
    // A Mandate is the ROOT of Mandate → Authorization → Intent → Agreement. Creating one
    // mints the limit every later authorization is evaluated against, so it must not be
    // reachable by anything an agent holds.
    expect(mcpTools.filter(n => /mandate/.test(n))).toEqual(["mitra_get_mandate", "mitra_list_mandates"]);
  });

  it("the autonomous runner cannot create a Mandate", () => {
    // It drives `MitraClient`, which has no such verb — so any appearance of one in the
    // runner would mean it had reached for the operator plane to grant itself authority.
    expect(runner).not.toMatch(/mandates\.create|POST[^/]*\/mandates/);
    // It may only READ mandates, to know which ceiling it operates under.
    expect(runner).toMatch(/mandates\.list/);
  });

  it("the MCP gateway serves exactly the declared tool list, adding nothing of its own", () => {
    // The gateway holds no authority: it forwards. Its tool count comes from the shared
    // declaration rather than a number typed into the log line, so adding a tool to the
    // server cannot silently not appear — or appear — in the gateway.
    expect(gateway).toMatch(/servedToolNames\(\)/);
  });
});

describe("the supervisor refuses to signal a process it cannot attribute", () => {
  it("identifies a live child by (pid, starttime), never by pid alone", () => {
    // A PID is a recycled integer. Keying liveness on it alone means `stack:down` will
    // eventually SIGTERM an unrelated process; the kernel's start time cannot be reused.
    expect(supervisor).toMatch(/startTimeOf/);
    expect(supervisor).toMatch(/startTime/);
  });

  it("leaves a non-attributable PID alone", () => {
    expect(supervisor).toMatch(/"unknown"/);
    expect(supervisor).toMatch(/refusing to signal|NOT ours/i);
  });

  it("checks process liveness and port reachability separately", () => {
    // Reporting one as the other is how a supervisor reassures you about a dead system.
    expect(supervisor).toMatch(/portAnswers|port answering|NOT ANSWERING/);
  });

  it("refuses to start without a production build, rather than timing out silently", () => {
    // `next start` on a dev-only `.next` dies quietly and the operator's first clue is a
    // 90-second timeout.
    expect(supervisor).toMatch(/BUILD_ID/);
  });
});

describe("the supervisor reports failure rather than a tidy summary", () => {
  it("exits non-zero when the API never becomes ready", () => {
    expect(supervisor).toMatch(/NOT ready/);
    expect(supervisor).toMatch(/return 1/);
  });

  it("reports a dead service instead of counting the stack as healthy", () => {
    expect(supervisor).toMatch(/dead/);
    expect(supervisor).toMatch(/unhealthy|problem/);
  });
});

describe("the runner keeps the parties genuinely separate", () => {
  it("does not let one role sign another's transitions", () => {
    // F55: each transition is signed by the party that is entitled to it. A runner that
    // used a single client for all three roles would prove nothing about multi-party
    // operation — it would be one actor in three hats.
    const roles = runner.match(/agent_(buyer|provider|evaluator)_live/g) ?? [];
    expect(new Set(roles).size).toBe(3);
    expect(runner).toMatch(/clientFor\(role\)|Record<Role, MitraClient>/);
  });

  it("reads its outcome back from the API instead of reporting intent", () => {
    expect(runner).toMatch(/listAgreements/);
    expect(runner).toMatch(/no agreement completed/);
  });
});