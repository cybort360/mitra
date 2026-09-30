import type { Obligation } from "@/lib/domain/types";

export interface NettingResult {
  grossVolume: number;
  netPositions: { party: string; amount: number }[];
  residualTransfers: { from: string; to: string; amount: number }[];
  excluded: { obligationId: string; reason: string }[];
  residualVolume: number;
}

export function netObligations(obligations: Obligation[]): NettingResult {
  const included = obligations.filter((o) => !["DISPUTED", "DEFAULTED", "SETTLED"].includes(o.status));
  const excluded = obligations.filter((o) => ["DISPUTED", "DEFAULTED"].includes(o.status)).map((o) => ({ obligationId: o.obligationId, reason: o.status }));
  const positions = new Map<string, number>();
  let grossVolume = 0;
  for (const o of included) {
    grossVolume += o.amount.amount;
    positions.set(o.debtor, (positions.get(o.debtor) ?? 0) - o.amount.amount);
    positions.set(o.creditor, (positions.get(o.creditor) ?? 0) + o.amount.amount);
  }
  const debtors = [...positions].filter(([,v]) => v < -1e-9).map(([party,v]) => ({ party, amount: -v })).sort((a,b)=>b.amount-a.amount);
  const creditors = [...positions].filter(([,v]) => v > 1e-9).map(([party,v]) => ({ party, amount: v })).sort((a,b)=>b.amount-a.amount);
  const residualTransfers: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 1e-9) residualTransfers.push({ from: debtors[i].party, to: creditors[j].party, amount: Number(amount.toFixed(8)) });
    debtors[i].amount -= amount; creditors[j].amount -= amount;
    if (debtors[i].amount <= 1e-9) i++;
    if (creditors[j].amount <= 1e-9) j++;
  }
  return {
    grossVolume: Number(grossVolume.toFixed(8)),
    netPositions: [...positions].map(([party,amount]) => ({ party, amount: Number(amount.toFixed(8)) })).sort((a,b)=>a.party.localeCompare(b.party)),
    residualTransfers,
    excluded,
    residualVolume: Number(residualTransfers.reduce((s,t)=>s+t.amount,0).toFixed(8)),
  };
}
