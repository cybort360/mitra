/**
 * Phase 10 — accounting and reconciliation.
 *
 * Exit condition: "A pilot organization can operate the system without reading
 * protocol logs."
 *
 * The load-bearing property is that a **disagreement between the three views
 * produces a finding**. An accounting view that only ever agrees with itself is
 * decoration: it would look identical whether or not anything were wrong. Every
 * test below either proves the reports balance or proves a specific corruption is
 * surfaced rather than absorbed.
 *
 * The test that matters most is the corrupted vault: if the accounting path
 * trusted its input rather than re-deriving, a broken position would be presented
 * to an operator as a healthy one, and the one artifact meant to prevent that
 * would be the thing hiding it.
 */
import { describe, expect, it } from "vitest";
import type { AssetSymbol, Obligation, Settlement, Vault } from "@/lib/domain/types";
import { buildAccountingReport } from "@/lib/kernel/accounting";

const A = "USDC" as AssetSymbol;

let n = 0;
function vault(over: Partial<Vault> = {}): Vault {
  n += 1;
  return {
    vaultId: `vlt_${n}`, name: "v", principal: "p", controllerRef: "c",
    chain: "solana", asset: A, address: "addr",
    total: 0, available: 0, reserved: 0, escrowed: 0, encumbered: 0, settling: 0, frozen: 0,
    emergencyFreeze: false, version: 1,
    ...over,
  } as Vault;
}
function ob(debtor: string, creditor: string, amount: number, asset: AssetSymbol = A): Obligation {
  n += 1;
  return {
    obligationId: `ob_${n}`, runId: "r", debtor, creditor,
    amount: { asset, amount }, sourceEvent: "e", dueAt: "2026-10-01", priority: 0,
    status: "DUE", nonce: 0, version: 1,
  };
}
function st(from: string, to: string, amount: number, status: Settlement["status"] = "CONFIRMED", asset: AssetSymbol = A): Settlement {
  n += 1;
  return {
    settlementId: `set_${n}`, chain: "solana", asset, amount, from, to,
    receiptId: `rc_${n}`, status, submittedAt: "2026-10-01",
    evidenceLevel: "LOCAL_PASS", obligationIds: [],
  } as Settlement;
}
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("a healthy book produces NO findings", () => {
  it("balanced vaults and reciprocal obligations reconcile", () => {
    const r = buildAccountingReport({
      vaults: [vault({ total: 100, available: 100 })],
      obligations: [ob("A", "B", 40), ob("B", "A", 15), ob("C", "D", 25)],
      settlements: [],
      asOf: "2026-10-02",
    });
    expect(r.findings).toEqual([]);
    expect(r.grossObligations[A]).toBe(80);
    expect(r.reconciliationDelta[A]).toBe(80);
  });

  it("net positions sum to zero", () => {
    const r = buildAccountingReport({
      vaults: [], obligations: [ob("A", "B", 40), ob("B", "C", 25)],
      settlements: [], asOf: "x",
    });
    const sum = r.netPositions.reduce((s, p) => s + p.netAmount, 0);
    expect(Number(sum.toFixed(8))).toBe(0);
    // A->B 40 and B->C 25 gives THREE distinct parties, not two: A -40, B +15,
    // C +25. An earlier assertion said 2 and was simply wrong about the graph.
    expect(r.netPositions.length).toBe(3);
    expect(r.netPositions.map((p) => [p.party, p.netAmount])).toEqual([
      ["A", -40], ["B", 15], ["C", 25],
    ]);
  });

  it("capital buckets sum to the total", () => {
    const r = buildAccountingReport({
      vaults: [vault({ total: 500, available: 300, reserved: 100, escrowed: 60, encumbered: 20, settling: 10, frozen: 10 })],
      obligations: [], settlements: [], asOf: "x",
    });
    expect(r.capital[A].total).toBe(500);
    expect(r.findings).toEqual([]);
  });
});

describe("corruption is surfaced, not absorbed", () => {
  it("a vault that does not reconcile is BLOCKING", () => {
    const r = buildAccountingReport({
      vaults: [vault({ total: 100, available: 60 })], // 40 missing
      obligations: [], settlements: [], asOf: "x",
    });
    expect(codes(r)).toContain("VAULT_DOES_NOT_RECONCILE");
    expect(r.findings.find((f) => f.code === "VAULT_DOES_NOT_RECONCILE")!.severity).toBe("BLOCKING");
  });

  it("money settled with no obligation behind it is BLOCKING", () => {
    const r = buildAccountingReport({
      vaults: [], obligations: [], settlements: [st("A", "B", 100)], asOf: "x",
    });
    expect(codes(r)).toContain("SETTLED_WITHOUT_OBLIGATION");
    // And it still reports the settled figure — hiding it would be worse.
    expect(r.settled[A]).toBe(100);
  });

  it("a non-CONFIRMED settlement is NOT counted as settled", () => {
    // The load-bearing detail: `SettlementStatus` has no SETTLED member, so an
    // earlier draft cast one past the compiler and `settled` was permanently zero.
    // Accounting that always reports zero settled looks like a quiet quarter.
    for (const status of ["PENDING", "SUBMITTED", "FAILED", "REVERSED"] as Settlement["status"][]) {
      const r = buildAccountingReport({
        vaults: [], obligations: [ob("A", "B", 100)], settlements: [st("A", "B", 100, status)], asOf: "x",
      });
      expect(r.settled[A], status).toBeUndefined();
    }
    const ok = buildAccountingReport({
      vaults: [], obligations: [ob("A", "B", 100)], settlements: [st("A", "B", 100, "CONFIRMED")], asOf: "x",
    });
    expect(ok.settled[A]).toBe(100);
    expect(ok.reconciliationDelta[A]).toBe(0);
  });

  it("a REVERSED settlement does not reduce the residual owed", () => {
    const r = buildAccountingReport({
      vaults: [], obligations: [ob("A", "B", 100)], settlements: [st("A", "B", 100, "REVERSED")], asOf: "x",
    });
    expect(r.reconciliationDelta[A]).toBe(100);
  });
});

describe("the report is what an operator would actually read", () => {
  it("carries the record counts behind each position", () => {
    // Without these, a total is indistinguishable from a complete one.
    const r = buildAccountingReport({
      vaults: [], obligations: [ob("A", "B", 40), ob("A", "B", 20)], settlements: [], asOf: "x",
    });
    const a = r.netPositions.find((p) => p.party === "A")!;
    expect(a.netAmount).toBe(-60);
    expect(a.obligationCount).toBe(2);
  });

  it("positions are sorted by party so a diff between runs is readable", () => {
    const r = buildAccountingReport({
      vaults: [], obligations: [ob("Z", "A", 1), ob("B", "C", 1), ob("Y", "B", 1)],
      settlements: [], asOf: "x",
    });
    expect(r.netPositions.map((p) => p.party)).toEqual([...r.netPositions.map((p) => p.party)].sort());
  });

  it("assets are kept apart — USDC and ETH never merge", () => {
    const r = buildAccountingReport({
      vaults: [vault({ asset: A, total: 10, available: 10 })],
      obligations: [ob("A", "B", 5, A), ob("A", "B", 5, "ETH" as AssetSymbol)],
      settlements: [], asOf: "x",
    });
    expect(r.grossObligations[A]).toBe(5);
    expect(r.grossObligations["ETH"]).toBe(5);
    expect(r.capital["ETH"]).toBeUndefined();
  });

  it("reconciliation delta is gross minus settled, per asset", () => {
    const r = buildAccountingReport({
      vaults: [], obligations: [ob("A", "B", 100), ob("C", "D", 50)],
      settlements: [st("A", "B", 30)], asOf: "x",
    });
    expect(r.grossObligations[A]).toBe(150);
    expect(r.settled[A]).toBe(30);
    expect(r.reconciliationDelta[A]).toBe(120);
  });

  it("an empty book produces an empty, finding-free report", () => {
    const r = buildAccountingReport({ vaults: [], obligations: [], settlements: [], asOf: "x" });
    expect(r.findings).toEqual([]);
    expect(r.netPositions).toEqual([]);
    expect(r.asOf).toBe("x");
  });
});
