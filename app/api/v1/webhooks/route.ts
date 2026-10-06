import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOperator, operatorRefusal } from "@/lib/admin/operator-auth";
import { getStore } from "@/lib/store/provider";
import { isEventPattern } from "@/lib/webhooks/events";
import { logHead } from "@/lib/webhooks/dispatcher";
import { getWebhookStore, type WebhookSubscription } from "@/lib/webhooks/store";
import { checkWebhookUrl } from "@/lib/webhooks/transport";
export const dynamic = "force-dynamic";

/**
 * Outbound webhooks (PP-3, PRD Phase 10): pilot organisations receive Mitra's
 * events without polling.
 *
 * Operator-only (lib/admin/operator-auth): a subscription makes the server send
 * requests to a URL of the caller's choosing. Delivery itself is done by the
 * worker (`scripts/webhook-worker.ts`), never inside this request.
 */
const createBody = z.object({
  url: z.string().min(1).max(2048),
  events: z.array(z.string()).min(1).max(32),
  /** Optional. Mitra generates one when omitted; a supplied secret must be at least 32 characters. */
  secret: z.string().min(32).max(256).optional(),
  description: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const auth = checkOperator(req);
  if (!auth.ok) return operatorRefusal(auth);
  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_WEBHOOK", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  const bad = b.events.filter((e) => !isEventPattern(e));
  if (bad.length) return NextResponse.json({ error: "INVALID_WEBHOOK", reason: "UNKNOWN_EVENT_PATTERN", patterns: bad }, { status: 400 });
  const url = checkWebhookUrl(b.url);
  if (!url.ok) return NextResponse.json({ error: "WEBHOOK_URL_REFUSED", reason: url.reason }, { status: 400 });

  const { repo } = await getStore();
  const sub: WebhookSubscription = {
    webhookId: `wh_${randomBytes(8).toString("hex")}`,
    url: url.value.toString(),
    events: [...new Set(b.events)],
    secret: b.secret ?? `whsec_${randomBytes(32).toString("hex")}`,
    ...(b.description ? { description: b.description } : {}),
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
    // From now on: a new subscriber is not sent the log's history.
    cursor: await logHead(repo),
  };
  await (await getWebhookStore()).createSubscription(sub);
  // The only response that ever carries the secret.
  return NextResponse.json({ data: sub }, { status: 201 });
}

export async function GET(req: Request) {
  const auth = checkOperator(req);
  if (!auth.ok) return operatorRefusal(auth);
  const store = await getWebhookStore();
  const withDeadLetters = new URL(req.url).searchParams.get("deadLetters") === "1";
  const subs = await store.listSubscriptions();
  const data = await Promise.all(subs.map(async ({ secret: _secret, ...s }) => {
    const deliveries = await store.listDeliveries({ webhookId: s.webhookId });
    const dead = deliveries.filter((d) => d.outcome === "DEAD_LETTERED");
    const last = deliveries.at(-1);
    return {
      ...s,
      health: {
        delivered: deliveries.length - dead.length,
        deadLettered: dead.length,
        ...(last ? { lastDelivery: { seq: last.seq, type: last.type, outcome: last.outcome, attempts: last.attempts, at: last.at,
          ...(last.lastStatus !== undefined ? { status: last.lastStatus } : {}), ...(last.lastError ? { error: last.lastError } : {}) } } : {}),
      },
      ...(withDeadLetters ? { deadLetters: dead } : {}),
    };
  }));
  return NextResponse.json({ data });
}
