/**
 * Re-export of the enforced participation surface.
 *
 * This file previously DEFINED the tool list, which meant the boundary lived in a
 * 5-line array that nothing checked. It now re-exports from `surface.ts`, where
 * `assertNoCapitalVerb` runs at module load — so a capital verb appended here
 * would be a duplicate, and appended there would throw on import.
 */
export {
  mcpTools,
  prohibitedDirectTools,
  assertNoCapitalVerb,
  isProhibited,
  type McpToolName,
  type ProhibitedTool,
} from "@/lib/mcp/surface";
