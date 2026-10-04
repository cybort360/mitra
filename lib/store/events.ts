/**
 * Writes one event to the store's append-only log (sprint item 5).
 *
 * Routes call this at each consequential step — including REFUSALS, because a
 * denied reservation or a refused execution is exactly what an operator watching
 * the live stream needs to see. Before item 5 only settlement wrote events, so the
 * log (and any console reading it) was silent about everything else.
 */
import type { RunEvent } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";

export function recordEvent(
  repo: EconomicRepository,
  e: Omit<RunEvent, "eventId" | "at" | "metadata"> & { at?: string; metadata?: RunEvent["metadata"] },
): Promise<RunEvent> {
  return repo.appendEvent({ ...e, at: e.at ?? new Date().toISOString(), metadata: e.metadata ?? {} });
}
