import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getStore } from "@/lib/store/provider";
import { baseSepoliaObserver, payX402 } from "@/lib/payments/x402-gateway";

/**
 * The x402 gateway (PRD §12.1, sprint item 4): fetch a paid resource through Mitra,
 * paying from a reservation (`lib/payments/x402-gateway.ts`).
 *
 * Two refusals before anything else, because this route makes the SERVER fetch a
 * URL and the API has no caller identity:
 * - the URL's origin must be in `MITRA_X402_ALLOWED_ORIGINS` (comma-separated), so
 *   the route cannot be used to reach arbitrary hosts from inside the deployment;
 * - the payer key (`MITRA_EVM_SETTLEMENT_KEY_FILE`) and `BASE_RPC_URL` must be set,
 *   or it answers 503 rather than inventing a payment.
 *
 * Even then, a caller can only make a reservation pay the payee and ceiling that
 * policy already approved for it (the digest binds `x402:<payTo>`).
 */
const schema = z.object({
  reservationId: z.string().min(1),
  url: z.string().url(),
  method: z.enum(["GET", "POST"]).default("GET"),
  body: z.string().optional(),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  const body = parsed.data;

  const allowed = (process.env.MITRA_X402_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(new URL(body.url).origin)) {
    return NextResponse.json({ error: "X402_ORIGIN_NOT_ALLOWED", origin: new URL(body.url).origin }, { status: 403 });
  }
  const keyFile = process.env.MITRA_EVM_SETTLEMENT_KEY_FILE;
  const rpc = process.env.BASE_RPC_URL;
  if (!keyFile || !rpc) return NextResponse.json({ error: "X402_PAYER_NOT_CONFIGURED" }, { status: 503 });
  const signer = privateKeyToAccount(`0x${readFileSync(keyFile, "utf8").trim().replace(/^0x/, "")}`);

  const { repo, backend } = await getStore();
  const result = await payX402({
    repo, reservationId: body.reservationId, url: body.url,
    init: { method: body.method, ...(body.body !== undefined ? { body: body.body } : {}) },
    signer, now: () => new Date(), observe: baseSepoliaObserver(http(rpc)),
  });

  if (result.refusal) {
    return NextResponse.json({ error: result.refusal, settlement: result.settlement, backend }, { status: 409 });
  }
  const resource = result.response
    ? { status: result.response.status, contentType: result.response.headers.get("content-type"), body: await result.response.text() }
    : null;
  return NextResponse.json({ data: { resource, settlement: result.settlement }, backend }, { status: result.response ? 200 : 502 });
}
