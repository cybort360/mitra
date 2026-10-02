import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";

/**
 * List obligations — the input to netting and clearing.
 *
 * Previously imported `obligations` from `seed.ts` and served fixtures. With
 * `DATABASE_URL` unset that looked correct; with it set the Postgres backend had
 * never been given any rows and returned an empty world. The suite was green in
 * the default configuration and broken in the configured one, and nothing
 * detected it (F36).
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const obligations = await repo.listObligations();
  return NextResponse.json({
    data: obligations,
    count: obligations.length,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
