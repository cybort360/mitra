/**
 * Webhook signatures (PP-3).
 *
 *   X-Mitra-Timestamp: <unix seconds>
 *   X-Mitra-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   X-Mitra-Event-Id:  <the event's id; stable across retries, for receiver dedupe>
 *
 * The timestamp is inside the MAC, so a captured delivery cannot be replayed
 * outside the skew window with a fresh timestamp. Each retry is signed afresh
 * with its own timestamp, so a delivery that waited through backoff still lands
 * inside the window.
 *
 * `verifyWebhookSignature` is what a receiver runs; it is exported so pilot
 * organisations verify with the same code Mitra signs with.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-mitra-signature";
export const TIMESTAMP_HEADER = "x-mitra-timestamp";
export const EVENT_ID_HEADER = "x-mitra-event-id";
export const MAX_SKEW_SECONDS = 300;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "TIMESTAMP_INVALID" | "TIMESTAMP_OUT_OF_RANGE" | "SIGNATURE_MALFORMED" | "SIGNATURE_MISMATCH" };

export function verifyWebhookSignature(input: {
  secret: string;
  /** The X-Mitra-Timestamp header, as received. */
  timestamp: string | null;
  /** The raw request body, byte for byte: re-serialised JSON will not verify. */
  body: string;
  /** The X-Mitra-Signature header, as received. */
  signature: string | null;
  /** Unix seconds. */
  now: number;
  maxSkewSeconds?: number;
}): SignatureVerdict {
  if (!input.timestamp || !/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "TIMESTAMP_INVALID" };
  const ts = Number(input.timestamp);
  if (Math.abs(input.now - ts) > (input.maxSkewSeconds ?? MAX_SKEW_SECONDS)) return { ok: false, reason: "TIMESTAMP_OUT_OF_RANGE" };
  if (!input.signature || !/^sha256=[0-9a-f]{64}$/.test(input.signature)) return { ok: false, reason: "SIGNATURE_MALFORMED" };
  const expected = Buffer.from(signWebhook(input.secret, ts, input.body));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "SIGNATURE_MISMATCH" };
}
