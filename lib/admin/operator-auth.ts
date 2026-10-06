/**
 * Operator authentication for the routes that act on the deployment itself:
 * webhook subscriptions (PP-3) and incident controls (PP-4).
 *
 * The rest of the API carries no caller auth today; agreement transitions carry
 * the agent's own signature instead (F55). These routes are different: one makes
 * the server send requests to URLs a caller chose, the other halts value
 * movement for everyone. Both belong to whoever runs the deployment, so they take
 * a bearer token from `MITRA_OPERATOR_TOKEN`.
 *
 * Fail closed: with no token configured (or one too short to be a secret) the
 * routes answer 503 `OPERATOR_AUTH_NOT_CONFIGURED`, never open access.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const OPERATOR_TOKEN_MIN_LENGTH = 32;

export type OperatorVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: "OPERATOR_AUTH_NOT_CONFIGURED" | "OPERATOR_TOKEN_REQUIRED" | "OPERATOR_TOKEN_INVALID" };

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkOperator(req: Request, token: string | undefined = process.env.MITRA_OPERATOR_TOKEN): OperatorVerdict {
  if (!token || token.length < OPERATOR_TOKEN_MIN_LENGTH) return { ok: false, status: 503, error: "OPERATOR_AUTH_NOT_CONFIGURED" };
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return { ok: false, status: 401, error: "OPERATOR_TOKEN_REQUIRED" };
  // Compared as fixed-length digests, so neither length nor content leaks through timing.
  return timingSafeEqual(digest(m[1]), digest(token)) ? { ok: true } : { ok: false, status: 401, error: "OPERATOR_TOKEN_INVALID" };
}

/** The route's refusal for a failed check. */
export function operatorRefusal(v: Extract<OperatorVerdict, { ok: false }>): NextResponse {
  return NextResponse.json({ error: v.error }, { status: v.status });
}
