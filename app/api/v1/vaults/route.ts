import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { reconcileVault } from "@/lib/kernel/vault";

/**
 * List vaults, with the reconciliation invariant recomputed on read.
 *
 * **This route used to import the seed array directly.** It returned fixtures
 * with a live reconciliation attached, which over HTTP was indistinguishable
 * from real state — the one thing `docs/API.md` and the store's own header comment
 * warn against ("imports one cannot be told apart from a demo"). The store owned
 * the vaults; it simply could not enumerate them, so the route reached around it.
 * `EconomicRepository.listVaults` now exists and the route goes through it, so
 * selecting the Postgres backend changes the data source with no route change.
 *
 * Reconciliation is recomputed here rather than trusted from the row: it is
 * derived state, and serving a stale "reconciled" flag would hide the exact
 * corruption the field exists to surface.
 */
export async function GET() {
  const { repo, backend } = await getStore();
  const vaults = await repo.listVaults();
  return NextResponse.json({
    data: vaults.map((v) => ({ ...v, reconciliation: reconcileVault(v) })),
    count: vaults.length,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
