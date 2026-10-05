import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
export const dynamic = "force-dynamic";

/**
 * Prometheus text exposition (format 0.0.4).
 *
 * Deliberately NOT a `/metrics` route at the app root: Next reserves paths that
 * collide with build output, and this repo's routes are all namespaced under
 * /api/v1. Scrape target is therefore `/api/v1/metrics`.
 *
 * Every value is read from the live store — none is hardcoded. A gauge that
 * reported a constant would look healthy in a dashboard while the thing it
 * measures was broken, which is the same failure mode as a verifier that passes
 * against stale evidence.
 */
function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function gauge(lines: string[], name: string, help: string, value: number, labels = "") {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name}${labels} ${value}`);
}

function counter(lines: string[], name: string, help: string, value: number, labels = "") {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  lines.push(`${name}${labels} ${value}`);
}

export async function GET() {
  const { repo, backend } = await getStore();
  const settlements = await repo.listSettlements();
  const vaults = await repo.listVaults();
  const sagas = await repo.listSagas();

  const lines: string[] = [];
  lines.push(`# Mitra economic coordination layer — backend=${backend}`);

  counter(lines, "mitra_settlements_total", "Settlements recorded in the store.", settlements.length);
  counter(lines, "mitra_sag_total", "Sagas recorded in the store.", sagas.length);

  let available = 0;
  let reserved = 0;
  for (const v of vaults) {
    available += num(v.available);
    reserved += num(v.reserved);
  }
  gauge(lines, "mitra_vault_available_units", "Unencumbered capital available across vaults.", available);
  gauge(lines, "mitra_vault_reserved_units", "Capital reserved against outstanding commitments.", reserved);

  // "Active" means not terminal: a saga sitting in RECOVERED is done, and counting
  // it as active would make this gauge ratchet upward forever.
  const active = sagas.filter((s) => !["RECOVERED", "COMPLETED", "FAILED", "CANCELLED"].includes(s.status)).length;
  gauge(lines, "mitra_sagas_active_count", "Sagas that have not reached a terminal state.", active);

  const body = `${lines.join("\n")}\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
