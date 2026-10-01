import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted recursively so the same
 * logical entry always produces the same hash regardless of insertion order.
 * Without this, two peers recording an identical entry in different key order
 * would compute different hashes and the merge would report a false conflict.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const GENESIS = "0".repeat(64);

/** Hash of an entry's content, excluding the id/hash fields themselves. */
export function hashEntry(material: Record<string, unknown>): string {
  return sha256(canonical(material));
}
