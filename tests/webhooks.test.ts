/**
 * PP-3: outbound webhooks. Signing, retry and dead-lettering, the outbox drain,
 * the operator-only routes, the SSRF guard, and one end-to-end run where real
 * agreement transitions reach a real HTTP receiver over a socket, signed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listWebhooks, POST as createWebhook } from "@/app/api/v1/webhooks/route";
import { POST as postAgreement } from "@/app/api/v1/agreements/route";
import { getStore } from "@/lib/store/provider";
import { recordEvent } from "@/lib/store/events";
import type { RunEvent } from "@/lib/domain/types";
import { DEFAULT_RETRY, deliver, drain, type DispatchDeps } from "@/lib/webhooks/dispatcher";
import { envelopeFor, isEventPattern, matchesAny, webhookEventType } from "@/lib/webhooks/events";
import { MAX_SKEW_SECONDS, signWebhook, verifyWebhookSignature } from "@/lib/webhooks/signing";
import { __resetWebhookStoreForTests, getWebhookStore, type WebhookSubscription } from "@/lib/webhooks/store";
import { checkWebhookUrl, isForbiddenAddress, safeTransport, type WebhookTransport } from "@/lib/webhooks/transport";
import { bindTestParties, prepareStore, signedTransition } from "./fixtures";

const TOKEN = "op_".padEnd(40, "x");
const SECRET = "whsec_test_vector_secret_0123456789abcdef";
const T0 = Date.parse("2026-10-06T12:00:00Z");

beforeEach(async () => {
  await prepareStore();
  await __resetWebhookStoreForTests();
  process.env.MITRA_OPERATOR_TOKEN = TOKEN;
  delete process.env.MITRA_WEBHOOKS_ALLOW_PRIVATE;
});
afterEach(() => { delete process.env.MITRA_OPERATOR_TOKEN; });

const event = (over: Partial<RunEvent> = {}): RunEvent => ({
  eventId: "evt_1", runId: "run_1", at: "2026-10-06T12:00:00Z", kind: "COMMERCE", title: "Agreement OPEN → FUNDED",
  description: "fund applied.", status: "SUCCESS", metadata: { op: "fund", from: "OPEN", to: "FUNDED" }, ...over,
});
const sub = (over: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  webhookId: "wh_test", url: "https://hooks.example.com/mitra", events: ["*"], secret: SECRET, status: "ACTIVE",
  createdAt: "2026-10-06T00:00:00Z", cursor: 0, ...over,
});

/** A transport that answers from a script and records every call. */
function scripted(answers: Array<number | Error>) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const sleeps: number[] = [];
  let clock = T0;
  const transport: WebhookTransport = async (url, body, headers) => {
    calls.push({ url, body, headers });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { status: a };
  };
  const deps: DispatchDeps = { transport, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock };
  return { calls, sleeps, deps };
}

describe("signing", () => {
  it("matches an HMAC-SHA256 computed independently (openssl dgst -sha256 -hmac)", () => {
    expect(signWebhook(SECRET, 1700000000, '{"hello":"mitra"}'))
      .toBe("sha256=278c465578f564749c766d5d275767c4c9315cba0d05dac72aa1a586cac92471");
  });

  const ok = { secret: SECRET, timestamp: "1700000000", body: '{"hello":"mitra"}', signature: signWebhook(SECRET, 1700000000, '{"hello":"mitra"}'), now: 1700000000 };
  it("verifies its own signature, and refuses any change to secret, body, timestamp or signature", () => {
    expect(verifyWebhookSignature(ok)).toEqual({ ok: true });
    expect(verifyWebhookSignature({ ...ok, secret: `${SECRET}x` }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...ok, body: '{"hello":"mitra" }' })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
    expect(verifyWebhookSignature({ ...ok, timestamp: "1700000001", now: 1700000001 })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
    expect(verifyWebhookSignature({ ...ok, signature: ok.signature.replace(/.$/, "0") }).ok).toBe(false);
  });

  it(`refuses a timestamp more than ${MAX_SKEW_SECONDS}s from now, either way`, () => {
    expect(verifyWebhookSignature({ ...ok, now: 1700000000 + 300 }).ok).toBe(true);
    expect(verifyWebhookSignature({ ...ok, now: 1700000000 + 301 })).toEqual({ ok: false, reason: "TIMESTAMP_OUT_OF_RANGE" });
    expect(verifyWebhookSignature({ ...ok, now: 1700000000 - 301 })).toEqual({ ok: false, reason: "TIMESTAMP_OUT_OF_RANGE" });
  });

  it.each([
    [{ timestamp: null }, "TIMESTAMP_INVALID"], [{ timestamp: "17e8" }, "TIMESTAMP_INVALID"], [{ timestamp: "-1" }, "TIMESTAMP_INVALID"],
    [{ signature: null }, "SIGNATURE_MALFORMED"], [{ signature: "deadbeef" }, "SIGNATURE_MALFORMED"],
    [{ signature: `sha1=${"a".repeat(64)}` }, "SIGNATURE_MALFORMED"],
  ])("%j → %s", (over, reason) => expect(verifyWebhookSignature({ ...ok, ...over } as typeof ok)).toEqual({ ok: false, reason }));
});

describe("event types and subscriptions", () => {
  it("names state changes by their target state, and everything else by status", () => {
    expect(webhookEventType(event())).toBe("agreement.funded");
    expect(webhookEventType(event({ metadata: { op: "fund", reason: "SPACE_BUDGET_EXCEEDED" }, status: "WARNING" }))).toBe("agreement.warning");
    expect(webhookEventType(event({ kind: "RECOVERY", status: "FAILURE", metadata: {} }))).toBe("saga.failure");
    expect(webhookEventType(event({ kind: "CLEARING", status: "SUCCESS", metadata: {} }))).toBe("clearing.success");
  });
  it("matches exact types, a topic wildcard and *, and nothing else", () => {
    expect(matchesAny(["agreement.*"], "agreement.funded")).toBe(true);
    expect(matchesAny(["agreement.funded"], "agreement.funded")).toBe(true);
    expect(matchesAny(["*"], "saga.failure")).toBe(true);
    expect(matchesAny(["agreement.*"], "agreements.funded")).toBe(false);
    expect(matchesAny(["agreement.accepted"], "agreement.funded")).toBe(false);
    expect(matchesAny(["saga.*", "clearing.*"], "agreement.funded")).toBe(false);
  });
  it.each(["*", "agreement.*", "saga.failure", "clearing.success"])("accepts the pattern %s", (p) => expect(isEventPattern(p)).toBe(true));
  it.each(["", "agreement", "agreement.", "*.funded", "nonsense.*", "agreement.**", "AGREEMENT.*"])("refuses the pattern %j", (p) => expect(isEventPattern(p)).toBe(false));
});

describe("delivery: retries with backoff, then dead-letters", () => {
  const env = envelopeFor(7, event());

  it("delivers first time on a 2xx, signed so the receiver can verify it", async () => {
    const { calls, sleeps, deps } = scripted([204]);
    const d = await deliver(sub(), env, deps);
    expect(d).toMatchObject({ outcome: "DELIVERED", attempts: 1, lastStatus: 204, seq: 7, type: "agreement.funded", eventId: "evt_1" });
    expect(sleeps).toEqual([]);
    const h = calls[0].headers;
    expect(h["x-mitra-event-id"]).toBe("evt_1");
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: h["x-mitra-timestamp"], body: calls[0].body, signature: h["x-mitra-signature"], now: T0 / 1000 })).toEqual({ ok: true });
    expect(JSON.parse(calls[0].body)).toMatchObject({ id: "evt_1", seq: 7, type: "agreement.funded", data: { runId: "run_1" } });
  });

  it("retries 5xx after 1s then 5s, and succeeds on the third attempt with a freshly signed timestamp", async () => {
    const { calls, sleeps, deps } = scripted([503, 500, 200]);
    const d = await deliver(sub(), env, deps);
    expect(d).toMatchObject({ outcome: "DELIVERED", attempts: 3, lastStatus: 200 });
    expect(sleeps).toEqual([1000, 5000]);
    expect(calls.map((c) => Number(c.headers["x-mitra-timestamp"]))).toEqual([T0 / 1000, T0 / 1000 + 1, T0 / 1000 + 6]);
    for (const c of calls) {
      expect(verifyWebhookSignature({ secret: SECRET, timestamp: c.headers["x-mitra-timestamp"], body: c.body, signature: c.headers["x-mitra-signature"], now: Number(c.headers["x-mitra-timestamp"]) }).ok).toBe(true);
    }
  });

  it(`dead-letters after ${DEFAULT_RETRY.maxAttempts} failed attempts, keeping the last status`, async () => {
    const { calls, sleeps, deps } = scripted([500]);
    expect(await deliver(sub(), env, deps)).toMatchObject({ outcome: "DEAD_LETTERED", attempts: 3, lastStatus: 500, lastError: "HTTP_500" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 5000]);
  });

  it.each([[429], [408]])("retries %i", async (status) => {
    const { calls, deps } = scripted([status, 200]);
    expect((await deliver(sub(), env, deps)).outcome).toBe("DELIVERED");
    expect(calls).toHaveLength(2);
  });

  it("retries a network failure or timeout", async () => {
    const { calls, deps } = scripted([new Error("ECONNRESET"), new Error("WEBHOOK_TIMEOUT"), 200]);
    expect(await deliver(sub(), env, deps)).toMatchObject({ outcome: "DELIVERED", attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it.each([[400], [401], [404], [410]])("dead-letters a %i at once: the receiver refused it", async (status) => {
    const { calls, sleeps, deps } = scripted([status, 200]);
    expect(await deliver(sub(), env, deps)).toMatchObject({ outcome: "DEAD_LETTERED", attempts: 1, lastStatus: status });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never follows a redirect", async () => {
    const { calls, deps } = scripted([302, 200]);
    expect(await deliver(sub(), env, deps)).toMatchObject({ outcome: "DEAD_LETTERED", lastError: "REDIRECT_NOT_FOLLOWED" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a target the SSRF guard refused", async () => {
    const { calls, deps } = scripted([new Error("WEBHOOK_TARGET_FORBIDDEN: x resolves to 10.0.0.1")]);
    expect(await deliver(sub(), env, deps)).toMatchObject({ outcome: "DEAD_LETTERED", attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe("drain: an outbox over the event log", () => {
  it("delivers each matching event once, per subscription, from its own cursor; a dead subscriber holds back no one", async () => {
    const { repo } = await getStore();
    const store = await getWebhookStore();
    await recordEvent(repo, { runId: "run_w", kind: "COMMERCE", title: "Agreement OPEN → FUNDED", description: "", status: "SUCCESS", metadata: { to: "FUNDED" } });
    await recordEvent(repo, { runId: "run_w", kind: "RECOVERY", title: "Saga armed", description: "", status: "INFO" });
    await recordEvent(repo, { runId: "run_w", kind: "COMMERCE", title: "Agreement FUNDED → EXECUTING", description: "", status: "SUCCESS", metadata: { to: "EXECUTING" } });
    const head = (await repo.listEventsSince(0, 10_000)).at(-3)!.seq - 1;
    await store.createSubscription(sub({ webhookId: "wh_agreements", url: "https://a.example.com", events: ["agreement.*"], cursor: head }));
    await store.createSubscription(sub({ webhookId: "wh_down", url: "https://down.example.com", events: ["*"], cursor: head }));

    const byUrl: Record<string, string[]> = {};
    const deps: DispatchDeps = {
      transport: async (url, body) => { (byUrl[url] ??= []).push(JSON.parse(body).type); return { status: url.includes("down") ? 503 : 200 }; },
      sleep: async () => {}, now: () => T0,
    };
    const first = await drain(repo, store, deps);
    expect(byUrl["https://a.example.com"]).toEqual(["agreement.funded", "agreement.executing"]);
    expect(first).toMatchObject({ delivered: 2, deadLettered: 3 });
    expect(await store.listDeliveries({ webhookId: "wh_down", outcome: "DEAD_LETTERED" })).toHaveLength(3);

    // Cursors moved: a second pass delivers nothing new.
    const again = await drain(repo, store, deps);
    expect(again).toEqual({ scanned: 0, delivered: 0, deadLettered: 0 });

    await recordEvent(repo, { runId: "run_w", kind: "COMMERCE", title: "Agreement EXECUTING → SUBMITTED", description: "", status: "SUCCESS", metadata: { to: "SUBMITTED" } });
    await drain(repo, store, deps);
    expect(byUrl["https://a.example.com"]).toEqual(["agreement.funded", "agreement.executing", "agreement.submitted"]);
  });

  it("a resend after a crash (recorded, cursor not advanced) replaces the record rather than wedging the drain", async () => {
    const { repo } = await getStore();
    const store = await getWebhookStore();
    await recordEvent(repo, { runId: "run_c", kind: "COMMERCE", title: "t", description: "", status: "SUCCESS", metadata: { to: "FUNDED" } });
    const last = (await repo.listEventsSince(0, 10_000)).at(-1)!.seq;
    await store.createSubscription(sub({ webhookId: "wh_crash", cursor: last - 1 }));
    const deps: DispatchDeps = { transport: async () => ({ status: 500 }), sleep: async () => {}, now: () => T0 };
    // Simulate: a first worker recorded the outcome and died before advancing.
    await store.recordDelivery({ deliveryId: `dlv_wh_crash_${last}`, webhookId: "wh_crash", eventId: "e", seq: last, type: "agreement.funded", outcome: "DEAD_LETTERED", attempts: 1, at: "x" });
    const r = await drain(repo, store, { ...deps, transport: async () => ({ status: 200 }) });
    expect(r.delivered).toBe(1);
    const recs = await store.listDeliveries({ webhookId: "wh_crash" });
    expect(recs).toHaveLength(1);
    expect(recs[0].outcome).toBe("DELIVERED");
  });
});

describe("the routes are operator-only", () => {
  const call = (handler: (r: Request) => Promise<Response>, init: { method?: string; body?: unknown; token?: string | null; query?: string } = {}) =>
    handler(new Request(`http://localhost/api/v1/webhooks${init.query ?? ""}`, {
      method: init.method ?? "GET",
      headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }), "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }));
  const good = { url: "https://hooks.example.com/mitra", events: ["agreement.*", "saga.*", "clearing.*"] };

  it("fails closed with no operator token configured, or one too short to be a secret", async () => {
    delete process.env.MITRA_OPERATOR_TOKEN;
    expect((await call(listWebhooks)).status).toBe(503);
    expect((await call(createWebhook, { method: "POST", body: good })).status).toBe(503);
    process.env.MITRA_OPERATOR_TOKEN = "short";
    expect((await (await call(listWebhooks, { token: "short" })).json()).error).toBe("OPERATOR_AUTH_NOT_CONFIGURED");
  });

  it("refuses a missing or wrong token", async () => {
    expect((await (await call(createWebhook, { method: "POST", body: good, token: null })).json()).error).toBe("OPERATOR_TOKEN_REQUIRED");
    const wrong = await call(createWebhook, { method: "POST", body: good, token: `${TOKEN}y` });
    expect(wrong.status).toBe(401);
    expect((await call(listWebhooks, { token: "x".repeat(40) })).status).toBe(401);
    expect(await (await getWebhookStore()).listSubscriptions()).toEqual([]);
  });

  it("registers: returns the secret once, starts at the log head, and never shows the secret again", async () => {
    const { repo } = await getStore();
    await recordEvent(repo, { runId: "run_h", kind: "COMMERCE", title: "old", description: "", status: "SUCCESS", metadata: { to: "FUNDED" } });
    const res = await call(createWebhook, { method: "POST", body: { ...good, description: "pilot org A" } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(data.cursor).toBe((await repo.listEventsSince(0, 10_000)).at(-1)!.seq);

    const listed = (await (await call(listWebhooks)).json()).data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ webhookId: data.webhookId, url: good.url, events: good.events, health: { delivered: 0, deadLettered: 0 } });
    expect(JSON.stringify(listed)).not.toContain(data.secret);
    expect(listed[0].secret).toBeUndefined();
  });

  it("accepts a caller's secret only if it is at least 32 characters", async () => {
    expect((await call(createWebhook, { method: "POST", body: { ...good, secret: "too-short" } })).status).toBe(400);
    const r = await call(createWebhook, { method: "POST", body: { ...good, secret: SECRET } });
    expect((await r.json()).data.secret).toBe(SECRET);
  });

  it.each([
    ["http://hooks.example.com/x", "URL_SCHEME_NOT_HTTPS"],
    ["https://user:pw@hooks.example.com/x", "URL_HAS_CREDENTIALS"],
    ["https://127.0.0.1/x", "URL_TARGET_FORBIDDEN"],
    ["https://169.254.169.254/latest/meta-data", "URL_TARGET_FORBIDDEN"],
    ["https://[::1]/x", "URL_TARGET_FORBIDDEN"],
    ["https://[::ffff:10.0.0.1]/x", "URL_TARGET_FORBIDDEN"],
    ["https://localhost/x", "URL_TARGET_FORBIDDEN"],
    ["https://metadata.google.internal/x", "URL_TARGET_FORBIDDEN"],
    ["ftp://hooks.example.com", "URL_SCHEME_NOT_HTTPS"],
    ["not a url", "URL_INVALID"],
  ])("refuses the URL %s (%s)", async (url, reason) => {
    const r = await call(createWebhook, { method: "POST", body: { ...good, url } });
    expect(r.status).toBe(400);
    expect((await r.json()).reason).toBe(reason);
  });

  it("refuses unknown event patterns", async () => {
    const r = await call(createWebhook, { method: "POST", body: { ...good, events: ["agreement.*", "payroll.*"] } });
    expect(await r.json()).toMatchObject({ reason: "UNKNOWN_EVENT_PATTERN", patterns: ["payroll.*"] });
  });

  it("GET ?deadLetters=1 lists what could not be delivered", async () => {
    const { repo } = await getStore();
    const store = await getWebhookStore();
    const { data } = await (await call(createWebhook, { method: "POST", body: good })).json();
    await recordEvent(repo, { runId: "run_d", kind: "COMMERCE", title: "t", description: "", status: "SUCCESS", metadata: { to: "FUNDED" } });
    await drain(repo, store, { transport: async () => ({ status: 410 }), sleep: async () => {}, now: () => T0 });
    const listed = (await (await call(listWebhooks, { query: "?deadLetters=1" })).json()).data[0];
    expect(listed.webhookId).toBe(data.webhookId);
    expect(listed.health).toMatchObject({ delivered: 0, deadLettered: 1, lastDelivery: { outcome: "DEAD_LETTERED", status: 410, type: "agreement.funded" } });
    expect(listed.deadLetters).toEqual([expect.objectContaining({ type: "agreement.funded", lastStatus: 410 })]);
  });
});

describe("the SSRF guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "not-an-ip",
  ])("forbids %s", (ip) => expect(isForbiddenAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isForbiddenAddress(ip)).toBe(false));

  let receiver: Server | undefined;
  afterEach(async () => { if (receiver) await new Promise((ok) => receiver!.close(ok)); receiver = undefined; });
  async function listen(handler: Parameters<typeof createServer>[1]) {
    receiver = createServer(handler);
    await new Promise<void>((ok) => receiver!.listen(0, "127.0.0.1", ok));
    return (receiver.address() as AddressInfo).port;
  }

  it("refuses at connect time a name that resolves to loopback, so DNS rebinding cannot reach the host", async () => {
    let hit = false;
    const port = await listen((_q, s) => { hit = true; s.end(); });
    // "localhost." (trailing dot) passes the registration-time name check; only the
    // connect-time lookup can see that it resolves to loopback. It resolves via the
    // OS, with no network needed.
    const transport = safeTransport({ allowPrivate: false });
    await expect(transport(`https://localhost.:${port}/x`, "{}", {}, 2000)).rejects.toThrow(/^WEBHOOK_TARGET_FORBIDDEN: localhost\. resolves to/);
    await expect(transport(`https://127.0.0.1:${port}/x`, "{}", {}, 2000)).rejects.toThrow(/FORBIDDEN/);
    expect(hit).toBe(false);
  });

  it("times out a receiver that never answers", async () => {
    const port = await listen(() => { /* never respond */ });
    await expect(safeTransport({ allowPrivate: true })(`http://127.0.0.1:${port}/slow`, "{}", {}, 300)).rejects.toThrow("WEBHOOK_TIMEOUT");
  });
});

describe("end to end: real agreement transitions reach a real receiver, signed", () => {
  let receiver: Server | undefined;
  afterEach(async () => { if (receiver) await new Promise((ok) => receiver!.close(ok)); receiver = undefined; });

  it("a pilot receiver gets agreement.funded and agreement.executing, verifies each signature, and sees each event once", async () => {
    await bindTestParties();
    process.env.MITRA_WEBHOOKS_ALLOW_PRIVATE = "1"; // the receiver is on loopback in this test only
    const received: Array<{ type: string; verified: boolean; eventId: string | undefined }> = [];
    let secret = "";
    receiver = createServer((q, s) => {
      let body = "";
      q.on("data", (c) => { body += c; });
      q.on("end", () => {
        const v = verifyWebhookSignature({ secret, timestamp: q.headers["x-mitra-timestamp"] as string, body,
          signature: q.headers["x-mitra-signature"] as string, now: Math.floor(Date.now() / 1000) });
        received.push({ type: JSON.parse(body).type, verified: v.ok, eventId: q.headers["x-mitra-event-id"] as string });
        s.writeHead(200).end();
      });
    });
    await new Promise<void>((ok) => receiver!.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/mitra`;

    const reg = await createWebhook(new Request("http://localhost/api/v1/webhooks", { method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ url, events: ["agreement.*"] }) }));
    expect(reg.status, await reg.clone().text()).toBe(201);
    secret = (await reg.json()).data.secret;

    const post = (b: unknown) => postAgreement(new Request("http://localhost/api/v1/agreements", { method: "POST", body: JSON.stringify(b) }));
    expect((await post({ op: "open", spaceId: "space_research_1",
      draft: { agreementId: "ag_wh", runId: "run_wh", intentId: "intent_wh", client: "agent_buyer_07", provider: "agent_data_03",
        evaluator: "agent_eval_02", price: { asset: "USDC", amount: 2 }, deadline: "2027-01-01T00:00:00Z" },
      proposal: { capability: "research", amount: { asset: "USDC", amount: 2 } } })).status).toBe(201);
    expect((await post(await signedTransition("agent_buyer_07", "OPEN", { op: "fund", agreementId: "ag_wh" }))).status).toBe(200);
    expect((await post(await signedTransition("agent_data_03", "FUNDED", { op: "startExecution", agreementId: "ag_wh" }))).status).toBe(200);

    const { repo } = await getStore();
    const deps = { transport: safeTransport(), sleep: async () => {}, now: () => Date.now() };
    const r = await drain(repo, await getWebhookStore(), deps);
    expect(r.deadLettered).toBe(0);
    expect(received.map((x) => x.type)).toEqual(expect.arrayContaining(["agreement.funded", "agreement.executing"]));
    expect(received.every((x) => x.verified), JSON.stringify(received)).toBe(true);
    expect(new Set(received.map((x) => x.eventId)).size).toBe(received.length);

    await drain(repo, await getWebhookStore(), deps);
    expect(received.length, "nothing is delivered twice").toBe(r.delivered);
  });
});
