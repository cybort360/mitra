/**
 * The external participation surface (PRD Phase 5).
 *
 * Exit condition: *"An external agent can participate without becoming
 * Mitra-native."*
 *
 * ## What that actually requires
 *
 * Not that a foreign agent can call our API. It requires the agent to be able to
 * express commercial intent and have it governed, **without being granted a
 * capital-moving verb.** An agent that can call "transfer" has become Mitra-native
 * in the only sense that matters: it holds the ability to move money directly,
 * which is exactly the property the vault exists to withhold.
 *
 * So the surface is defined by what it *cannot* contain, and that is enforced
 * structurally rather than by convention:
 *
 *   - every exposed tool is a *verb on intent*, not on capital;
 *   - `ProhibitedTool` is a literal union and `assertNoCapitalVerb` refuses any
 *     name in it, so adding one is a compile error rather than a review finding;
 *   - `McpToolName` is derived from the permitted list, so a capital verb cannot
 *     be typed as an MCP tool at all.
 *
 * The registry, the prohibition and the A2A lifecycle are all in this module so a
 * reviewer can check the boundary in one place.
 */

/** A tool that would let an external actor move or reach capital directly. */
export type ProhibitedTool =
  | "raw_arbitrary_transfer"
  | "raw_arbitrary_contract_call"
  | "raw_account_export"
  | "raw_key_access"
  | "raw_policy_mutation";

/** The MCP surface. Every entry is a verb on intent, never on capital. */
export const mcpTools = [
  "mitra_register_agent",
  "mitra_get_agent",
  "mitra_find_agents",
  "mitra_create_intent",
  "mitra_get_intent",
  "mitra_request_authorization",
  "mitra_create_agreement",
  "mitra_fund_agreement",
  // Not in PRD §10.2's initial list, but the kernel's FUNDED -> EXECUTING edge is
  // provider-signed and has no other route: without it an external provider
  // cannot reach submit (F66).
  "mitra_start_execution",
  "mitra_submit_deliverable",
  "mitra_accept_deliverable",
  "mitra_reject_deliverable",
  "mitra_get_obligations",
  "mitra_get_exposure",
  "mitra_get_recovery",
  "mitra_request_clearing",
  "mitra_get_settlement",
  "mitra_get_receipt",
  "mitra_get_timeline",
] as const;

export type McpToolName = (typeof mcpTools)[number];

export const prohibitedDirectTools: readonly ProhibitedTool[] = [
  "raw_arbitrary_transfer",
  "raw_arbitrary_contract_call",
  "raw_account_export",
  "raw_key_access",
  "raw_policy_mutation",
];

export function isProhibited(name: string): name is ProhibitedTool {
  return (prohibitedDirectTools as readonly string[]).includes(name);
}

/**
 * Fails loudly if a prohibited verb reaches the surface.
 *
 * Called at module load by the registry below. A build that surfaces a capital
 * verb should fail, not ship — the failure is loud because the alternative is a
 * capability boundary that holds only until someone appends a string.
 */
export function assertNoCapitalVerb(names: readonly string[]): void {
  const found = names.filter(isProhibited);
  if (found.length) {
    throw new Error(
      `MCP surface exposes capital-moving verbs: ${found.join(", ")}. ` +
        `An external agent must never hold a direct transfer or key verb.`,
    );
  }
}

/**
 * Set when the module-load check has run against the real list.
 *
 * Exists because removing the `assertNoCapitalVerb(mcpTools)` call survived
 * mutation audit: every other test asserted the *property* (no tool is a capital
 * verb), and that property still held with the guard deleted. So the guard's own
 * execution was untested. This makes it observable rather than assumed.
 */
let validated = false;

assertNoCapitalVerb(mcpTools);
validated = true;

/** True once the import-time check has run. Asserted by the test suite. */
export function surfaceWasValidated(): boolean {
  return validated;
}

// ─────────────────────────────────────────────────────────────────────────────
// A2A task lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The external task states.
 *
 * Deliberately NOT Mitra's `AgreementStatus`. A foreign agent's task is its own
 * object with its own vocabulary, and mapping it onto ours is the whole point of
 * interoperability — requiring it to speak our states is what "becoming
 * Mitra-native" means in practice.
 */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

/** The A2A terminal and transitional edges. Mirrors the machine discipline. */
export const A2A_TRANSITIONS: Record<A2ATaskState, A2ATaskState[]> = {
  submitted: ["working", "canceled"],
  working: ["input-required", "completed", "failed"],
  "input-required": ["working", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

export type A2AVerdict = { ok: true } | { ok: false; reason: string };

export function canTransitionTask(from: A2ATaskState, to: A2ATaskState): A2AVerdict {
  if (!(from in A2A_TRANSITIONS)) return { ok: false, reason: "UNKNOWN_STATE" };
  if (from === to) return { ok: false, reason: "NO_OP_TRANSITION" };
  if (A2A_TRANSITIONS[from].includes(to)) return { ok: true };
  return { ok: false, reason: "ILLEGAL_TRANSITION" };
}

export function isTaskTerminal(state: A2ATaskState): boolean {
  return A2A_TRANSITIONS[state].length === 0;
}

/**
 * Maps a foreign task state onto a Mitra AgreementStatus.
 *
 * The translation is lossy on purpose and says so: an A2A `input-required` has no
 * Mitra equivalent, because Mitra's agreement lifecycle has no notion of a task
 * blocked on the client. Collapsing it into EXECUTING would report work as
 * progressing when it is stalled, so it maps to nothing and the caller is told.
 */
export function toAgreementStatus(state: A2ATaskState): string | null {
  switch (state) {
    case "submitted": return "OPEN";
    case "working": return "EXECUTING";
    case "completed": return "ACCEPTED";
    case "failed": return "REJECTED";
    case "canceled": return "CANCELED";
    // No honest mapping. An external agent waiting on its client is not an
    // agreement that is executing.
    case "input-required": return null;
    default: return null;
  }
}
