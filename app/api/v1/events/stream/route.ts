import { getStore } from "@/lib/store/provider";

/**
 * Live event stream (sprint item 5): Server-Sent Events over the store's
 * append-only log, so operators watch agent actions without refreshing.
 *
 * - Each message's `id` is the event's log position, and a reconnect resumes from
 *   `Last-Event-ID` (or `?after=`): nothing is skipped, nothing repeated. With
 *   `?runId=` only that run's events are sent, but ids stay global positions so
 *   resumption is still exact.
 * - It polls the log (`listEventsSince`) rather than relying on in-process pub/sub,
 *   so it sees writes from other processes on Postgres too. `?pollMs=` (200–10000).
 * - A comment line every ~15s keeps proxies from closing an idle stream.
 */
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const start = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const pollMs = Math.min(10_000, Math.max(200, Number(url.searchParams.get("pollMs") ?? 1000) || 1000));
  const { repo, backend } = await getStore();
  const enc = new TextEncoder();

  let cursor = start;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => { if (!closed) { controller.enqueue(enc.encode(s)); lastWrite = Date.now(); } };
      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", stop);

      write(`retry: 3000\n: mitra events (backend ${backend}) after ${cursor}\n\n`);
      const tick = async () => {
        if (closed) return;
        try {
          for (const { seq, event } of await repo.listEventsSince(cursor)) {
            cursor = seq;
            if (runId && event.runId !== runId) continue;
            write(`id: ${seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`);
          }
          if (Date.now() - lastWrite >= KEEPALIVE_MS) write(`: keepalive ${cursor}\n\n`);
        } catch (e) {
          write(`event: stream-error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`);
        }
        if (!closed) timer = setTimeout(tick, pollMs);
      };
      void tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
