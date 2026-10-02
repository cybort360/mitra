/**
 * Accounting and reconciliation (PRD Phase 10).
 *
 * Exit condition: *"A pilot organization can operate the system without reading
 * protocol logs."*
 *
 * That is a precise demand. Logs are unstructured, event-shaped and require
 * someone who understands the internals to read them. An operator needs one
 * number per question they will actually be asked, derivable from state rather
 * than from event replay.
 *
 * ## The question this exists to answer
 *
 * Not "what happened" — the event log has that. **"Where is the money now, and
 * does it add up?"** Three positions must reconcile against each other at all
 * times:
 *
 *   ledger      — what the vault records (the six PRD §4.12 positions)
 *   obligations — what is owed, before netting
 *   settlements — what has actually moved
 *
 * A gap between any two is a finding, and the gap is the output. An accounting
 * view that only ever agrees with itself is decoration.
 *
 * Every figure is derived from the same immutable inputs and carries the count of
 * records behind it, so a total can never be mistaken for a complete one: an
 * operator seeing `settled: 0 obligations` is told why.
 */

import type { AssetSymbol, Obligation, Settlement, Vault } from "@/lib/domain/types";

export interface AccountingInput {
  vaults: Vault[];
  obligations: Obligation[];
  settlements: Settlement[];
  asOf: string;
}

/** One party's position, with the records behind it. */
export interface PartyPosition {
  party: string;
  asset: AssetSymbol;
  /** Positive = owed to the party; negative = the party owes. */
  netAmount: number;
  obligationCount: number;
  settlementCount: number;
}

export interface ReconciliationFinding {
  code: string;
  detail: string;
  severity: "BLOCKING" | "WARNING";
}

export interface AccountingReport {
  asOf: string;
  /**
   * Capital as the vault records it, per asset — ALL SIX PRD §4.12 positions.
   *
   * The first version folded `escrowed + encumbered` into a single `committed`
   * and dropped `settling` and `frozen`, so the buckets summed to 20 less than the
   * total for a healthy vault. The code then correctly reported
   * CAPITAL_BUCKETS_DO_NOT_SUM — and I nearly fixed the test instead of the code.
   * A reconciliation view that cannot represent two of the six positions cannot
   * reconcile them either.
   */
  capital: Record<string, {
    available: number; reserved: number; escrowed: number;
    encumbered: number; settling: number; frozen: number; total: number;
  }>;
  /** Positions before netting. */
  grossObligations: Record<string, number>;
  /** Positions after netting, per party. */
  netPositions: PartyPosition[];
  /** What has actually moved, per asset. */
  settled: Record<string, number>;
  /** Every position must sum to zero or one of these fires. */
  findings: ReconciliationFinding[];
  /** The single number an operator opens the dashboard to see. */
  reconciliationDelta: Record<string, number>;
}

const r8 = (n: number) => Number(n.toFixed(8));

export function buildAccountingReport(input: AccountingInput): AccountingReport {
  const { vaults, obligations, settlements } = input;
  const findings: ReconciliationFinding[] = [];

  const capital: AccountingReport["capital"] = {};
  for (const v of vaults) {
    const c = (capital[v.asset] ??= {
      available: 0, reserved: 0, escrowed: 0, encumbered: 0, settling: 0, frozen: 0, total: 0,
    });
    c.available += v.available;
    c.reserved += v.reserved;
    c.escrowed += v.escrowed;
    c.encumbered += v.encumbered;
    c.settling += v.settling;
    c.frozen += v.frozen;
    c.total += v.total;
  }

  // PRD §4.12 invariant, re-checked here rather than trusted from the API layer.
  // The accounting view is the last place a corrupted position would be visible to
  // an operator, so it is the place that must not assume its inputs are sound.
  for (const v of vaults) {
    const sum = v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen;
    if (Math.abs(sum - v.total) > 1e-9) {
      findings.push({
        code: "VAULT_DOES_NOT_RECONCILE",
        detail: `${v.vaultId}: positions sum to ${r8(sum)} but total is ${r8(v.total)}`,
        severity: "BLOCKING",
      });
    }
  }

  const gross: AccountingReport["grossObligations"] = {};
  const position = new Map<string, number>();
  for (const o of obligations) {
    gross[o.amount.asset] = (gross[o.amount.asset] ?? 0) + o.amount.amount;
    const key = `${o.amount.asset}:${o.debtor}`;
    position.set(key, (position.get(key) ?? 0) - o.amount.amount);
    const ck = `${o.amount.asset}:${o.creditor}`;
    position.set(ck, (position.get(ck) ?? 0) + o.amount.amount);
  }

  const counts = new Map<string, { o: number; s: number }>();
  for (const o of obligations) {
    for (const p of [o.debtor, o.creditor]) {
      const k = `${o.amount.asset}:${p}`;
      counts.set(k, { o: (counts.get(k)?.o ?? 0) + 1, s: counts.get(k)?.s ?? 0 });
    }
  }
  for (const s of settlements) {
    // CONFIRMED is the terminal success state. `SettlementStatus` has no SETTLED
    // member — PENDING -> SUBMITTED -> CONFIRMED, plus FAILED and REVERSED — and a
    // first draft cast "SETTLED" past the compiler. That cast would have made
    // `settled` permanently empty: accounting that always reports zero settled
    // looks like a quiet quarter, not a bug.
    if (s.status !== "CONFIRMED") continue;
    const k = `${s.asset}:${s.to}`;
    counts.set(k, { o: counts.get(k)?.o ?? 0, s: (counts.get(k)?.s ?? 0) + 1 });
  }

  const netPositions: PartyPosition[] = [...position.entries()]
    .map(([k, amount]) => {
      const [asset, party] = k.split(":");
      const c = counts.get(k) ?? { o: 0, s: 0 };
      return { party, asset: asset as AssetSymbol, netAmount: r8(amount), obligationCount: c.o, settlementCount: c.s };
    })
    .sort((a, b) => a.party.localeCompare(b.party));

  const settled: AccountingReport["settled"] = {};
  for (const s of settlements) {
    if (s.status !== "CONFIRMED") continue;
    settled[s.asset] = (settled[s.asset] ?? 0) + s.amount;
  }

  // The three-way reconciliation: gross obligation minus what settled should equal
  // the residual still owed. A non-zero delta is a finding, not a rounding note.
  const reconciliationDelta: AccountingReport["reconciliationDelta"] = {};
  const assets = new Set([...Object.keys(gross), ...Object.keys(settled)]);
  for (const asset of assets) {
    const g = gross[asset] ?? 0;
    const s = settled[asset] ?? 0;
    const delta = r8(g - s);
    reconciliationDelta[asset] = delta;
    // Net positions must sum to zero: every obligation has a creditor and a
    // debtor. A non-zero sum means an obligation names only one side.
    const positionSum = r8([...position.entries()]
      .filter(([k]) => k.startsWith(`${asset}:`))
      .reduce((acc, [, v]) => acc + v, 0));
    if (Math.abs(positionSum) > 1e-9) {
      findings.push({
        code: "OBLIGATION_POSITIONS_DO_NOT_SUM_TO_ZERO",
        detail: `${asset}: positions sum to ${positionSum}`,
        severity: "BLOCKING",
      });
    }
    if (g === 0 && s > 0) {
      findings.push({
        code: "SETTLED_WITHOUT_OBLIGATION",
        detail: `${asset}: ${r8(s)} settled with no obligations recorded`,
        severity: "BLOCKING",
      });
    }
  }

  for (const [asset, c] of Object.entries(capital)) {
    const buckets = c.available + c.reserved + c.escrowed + c.encumbered + c.settling + c.frozen;
    if (Math.abs(c.total - buckets) > 1e-9) {
      findings.push({
        code: "CAPITAL_BUCKETS_DO_NOT_SUM",
        detail: `${asset}: total ${r8(c.total)} != sum of positions ${r8(buckets)}`,
        severity: "BLOCKING",
      });
    }
  }

  return { asOf: input.asOf, capital, grossObligations: gross, netPositions, settled, findings, reconciliationDelta };
}
