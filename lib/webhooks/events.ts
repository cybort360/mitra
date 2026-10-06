/**
 * Which events a webhook carries, and what it calls them (PP-3).
 *
 * The source is the store's append-only event log, the same one the SSE stream
 * serves, so a webhook says nothing the log does not. Each event's type is
 * `<topic>.<qualifier>`: the topic from the event's kind, the qualifier from
 * `metadata.to` when the event records a state change (`agreement.funded`),
 * otherwise from its status (`agreement.warning` for a refusal).
 */
import type { RunEvent } from "@/lib/domain/types";

const TOPIC: Record<RunEvent["kind"], string> = {
  COMMERCE: "agreement",
  RECOVERY: "saga",
  CLEARING: "clearing",
  SETTLEMENT: "settlement",
  PAYMENT: "payment",
  VAULT: "vault",
  AUTHORITY: "authority",
  OBLIGATION: "obligation",
  DISCOVERY: "discovery",
  SYSTEM: "system",
};

export const WEBHOOK_TOPICS = Object.values(TOPIC);

export function webhookEventType(event: Pick<RunEvent, "kind" | "status" | "metadata">): string {
  const topic = TOPIC[event.kind] ?? "system";
  const to = event.metadata?.to;
  const qualifier = typeof to === "string" && /^[A-Za-z_]+$/.test(to) ? to.toLowerCase() : event.status.toLowerCase();
  return `${topic}.${qualifier}`;
}

/** `*`, `<topic>.*`, or an exact `<topic>.<qualifier>`, for a known topic. */
export function isEventPattern(p: string): boolean {
  if (p === "*") return true;
  const m = /^([a-z]+)\.(\*|[a-z_]+)$/.exec(p);
  return Boolean(m && WEBHOOK_TOPICS.includes(m[1]));
}

export function matchesAny(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

/** The body a subscriber receives. */
export interface WebhookEnvelope {
  /** The event's id: stable across retries, so a receiver can drop duplicates. */
  id: string;
  /** The event's position in Mitra's log. */
  seq: number;
  type: string;
  occurredAt: string;
  data: RunEvent;
}

export function envelopeFor(seq: number, event: RunEvent): WebhookEnvelope {
  return { id: event.eventId, seq, type: webhookEventType(event), occurredAt: event.at, data: event };
}
