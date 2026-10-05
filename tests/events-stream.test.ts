/**
 * Sprint item 5: the event log, the routes that write to it, and the live stream.
 *
 * The SSE route is read as a real byte stream: events appended AFTER the stream
 * opened must arrive, ids must be log positions, and a reconnect with
 * `Last-Event-ID` must resume exactly — nothing skipped, nothing repeated.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store/provider";
import { bindTestParties, prepareStore, signedTransition } from "./fixtures";
import { recordEvent } from "@/lib/store/events";
import { GET as eventsGET } from "@/app/api/v1/events/route";
import { GET as streamGET } from "@/app/api/v1/events/stream/route";
import { POST as agreementsPOST } from "@/app/api/v1/agreements/route";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";

beforeEach(async () => { await prepareStore(); await bindTestParties(); });

const post = (h: (r: Request) => Promise<Response>, body: unknown) =>
  h(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));

/** Reads SSE messages from a route response until `count` run-events arrive or time runs out. */
async function readEvents(res: Response, count: number, ms = 4000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Array<{ id: number; data: { eventId: string; runId: string; title: string } }> = [];
  const deadline = Date.now() + ms;
  while (out.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((ok) => setTimeout(() => ok({ done: true }), deadline - Date.now()))]);
    if (chunk.done || !chunk.value) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const id = /^id: (\d+)$/m.exec(block); const ev = /^event: (.+)$/m.exec(block); const data = /^data: (.+)$/m.exec(block);
      if (id && ev?.[1] === "run-event" && data) out.push({ id: Number(id[1]), data: JSON.parse(data[1]) });
    }
  }
  return out;
}

describe("the event log", () => {
  it("is append-only and readable from any position", async () => {
    const { repo } = await getStore();
    for (const n of [1, 2, 3]) await recordEvent(repo, { runId: `run_${n % 2}`, kind: "SYSTEM", title: `e${n}`, description: "", status: "INFO" });
    const all = await repo.listEventsSince(0);
    expect(all.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect((await repo.listEventsSince(2)).map((x) => x.event.title)).toEqual(["e3"]);
    expect((await repo.listEvents("run_1")).map((e) => e.title)).toEqual(["e1", "e3"]);
  });
});

describe("routes write what happened, including refusals", () => {
  it("opening an agreement, and a refused op on it, both land in the log", async () => {
    const draft = {
      agreementId: "ag_ev", runId: "run_ev", intentId: "i", client: "agent_buyer_07", provider: "mech-research-backup-04",
      evaluator: "agent_eval_02", price: { asset: "USDC", amount: 5 }, deadline: "2027-01-01T00:00:00Z",
    };
    expect((await post(agreementsPOST, { op: "open", spaceId: "space_research_1", draft, proposal: { capability: "research", amount: { asset: "USDC", amount: 5 } } })).status).toBe(201);
    // Signed by a party allowed to accept, so the KERNEL is what refuses it (the agreement is only OPEN).
    expect((await post(agreementsPOST, await signedTransition("agent_eval_02", "OPEN", { op: "acceptDeliverable", agreementId: "ag_ev" }))).status).toBe(400);
    const body = await (await eventsGET(new Request("http://localhost/api/v1/events?runId=run_ev"))).json();
    expect(body.data.map((e: { title: string; status: string }) => [e.title, e.status])).toEqual([
      ["Agreement opened", "SUCCESS"],
      ["Agreement acceptDeliverable refused", "WARNING"],
    ]);
  });

  it("a policy denial is recorded, and so is a reservation that succeeded", async () => {
    const base = { mandateId: "mandate_research_public_v7", vaultId: "vault_sol_primary", asset: "USDC", chain: "solana", capability: "market_research", intentId: "i", runId: "run_res", now: "2026-10-01T12:00:00.000Z" };
    await post(reservationsPOST, { ...base, amount: 5, counterparty: "nobody:at-all" });
    await post(reservationsPOST, { ...base, amount: 5, counterparty: "virtuals:research-agent-18" });
    const body = await (await eventsGET(new Request("http://localhost/api/v1/events?runId=run_res"))).json();
    expect(body.data.map((e: { kind: string; title: string }) => `${e.kind}:${e.title}`)).toEqual([
      "AUTHORITY:Reservation denied by policy",
      "VAULT:Capital reserved",
    ]);
  });
});

describe("GET /api/v1/events/stream", () => {
  it("streams events appended after it opened, with log positions as ids", async () => {
    const { repo } = await getStore();
    await recordEvent(repo, { runId: "run_s", kind: "SYSTEM", title: "before", description: "", status: "INFO" });
    const ctl = new AbortController();
    const res = await streamGET(new Request("http://localhost/api/v1/events/stream?pollMs=200", { signal: ctl.signal }));
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    setTimeout(() => void recordEvent(repo, { runId: "run_s", kind: "SYSTEM", title: "after", description: "", status: "INFO" }), 300);
    const got = await readEvents(res, 2);
    ctl.abort();
    expect(got.map((g) => [g.id, g.data.title])).toEqual([[1, "before"], [2, "after"]]);
  });

  it("resumes from Last-Event-ID: nothing repeated, nothing skipped", async () => {
    const { repo } = await getStore();
    for (const t of ["a", "b", "c"]) await recordEvent(repo, { runId: "run_r", kind: "SYSTEM", title: t, description: "", status: "INFO" });
    const ctl = new AbortController();
    const res = await streamGET(new Request("http://localhost/api/v1/events/stream?pollMs=200", { headers: { "last-event-id": "1" }, signal: ctl.signal }));
    const got = await readEvents(res, 2);
    ctl.abort();
    expect(got.map((g) => [g.id, g.data.title])).toEqual([[2, "b"], [3, "c"]]);
  });

  it("filters to one run, keeping global positions as ids", async () => {
    const { repo } = await getStore();
    await recordEvent(repo, { runId: "run_x", kind: "SYSTEM", title: "x1", description: "", status: "INFO" });
    await recordEvent(repo, { runId: "run_y", kind: "SYSTEM", title: "y1", description: "", status: "INFO" });
    await recordEvent(repo, { runId: "run_x", kind: "SYSTEM", title: "x2", description: "", status: "INFO" });
    const ctl = new AbortController();
    const res = await streamGET(new Request("http://localhost/api/v1/events/stream?runId=run_x&pollMs=200", { signal: ctl.signal }));
    const got = await readEvents(res, 2);
    ctl.abort();
    expect(got.map((g) => [g.id, g.data.title])).toEqual([[1, "x1"], [3, "x2"]]);
  });
});
