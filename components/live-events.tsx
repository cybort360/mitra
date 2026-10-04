"use client";
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@/lib/domain/types";
import { RunTimeline } from "./run-timeline";

/**
 * Live economic activity (sprint item 5): Server-Sent Events from
 * `/api/v1/events/stream`, newest first. The browser's EventSource resumes from
 * the last event id on reconnect, so nothing is shown twice or skipped.
 *
 * The connection state is shown, not implied: an empty feed while disconnected is
 * a different fact from an empty feed while listening.
 */
export function LiveEvents({ runId, limit = 30 }: { runId?: string; limit?: number }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const url = `/api/v1/events/stream${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
    const source = new EventSource(url);
    source.onopen = () => setState("live");
    source.onerror = () => setState("reconnecting");
    source.addEventListener("run-event", (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as RunEvent;
      if (seen.current.has(e.eventId)) return;
      seen.current.add(e.eventId);
      setEvents((prev) => [e, ...prev].slice(0, limit));
    });
    return () => source.close();
  }, [runId, limit]);

  const dot = state === "live" ? "SUCCESS" : state === "reconnecting" ? "WARNING" : "INFO";
  return (
    <>
      <div className="statLine" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
        <span><span className={`eventDot ${dot}`} style={{ display: "inline-block", marginRight: 8, boxShadow: "none" }} />{state === "live" ? "Live — streaming from the event log" : state === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
        <strong className="mono">{events.length}</strong>
      </div>
      {events.length
        ? <RunTimeline events={events} />
        : <div className="empty">{state === "live" ? "No events yet. Agent actions appear here as they happen." : "Waiting for the stream."}</div>}
    </>
  );
}
