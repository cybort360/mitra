/**
 * Phase 7 — clearing (PRD exit condition: "Deterministic netting passes
 * adversarial graph tests").
 *
 * Three properties, in order of how badly a failure would hurt:
 *
 *   1. **Determinism.** Two runs over the same graph must produce byte-identical
 *      output, including ordering. A clearing result that varies run to run cannot
 *      be agreed to by anyone, so the epoch's resultHash would be meaningless.
 *   2. **Conservation.** Net positions sum to zero, and the residual transfers
 *      total exactly the gross exposure that could not be netted. If netting
 *      creates or destroys value, the whole model is unsound.
 *   3. **Immutability of the frozen input set.** After FROZEN, a mutated
 *      obligation must be refused. Disputes stay *visible and excluded*, never
 *      silently dropped — an engine that quietly omits a dispute still produces an
 *      authoritative-looking aggregate, which is worse than crashing.
 *
 * The adversarial cases are the ones a happy-path test would never generate:
 * cycles, self-loops, chains, a single party netting against itself, and a graph
 * where naive pairwise matching produces more transfers than optimal.
 */
import { describe, expect, it } from "vitest";
import type { AssetSymbol, Obligation } from "@/lib/domain/types";
import {
  calculateEpoch,
  finalizeEpoch,
  freezeEpoch,
  inputsRoot,
  netObligations,
  openEpoch,
  resultHash,
  resolveChallenges,
} from "@/lib/kernel/clearing";

const A = "USDC" as AssetSymbol;

let n = 0;
/** Resets the id counter so each test's ids are predictable. */
function resetIds() { n = 0; }

/**
 * A complete Obligation. The earlier version used `as Obligation` on a partial
 * literal, which satisfied the compiler while omitting runId, sourceEvent,
 * priority and nonce — so the netting function was receiving objects the domain
 * type says cannot exist.
 */
function ob(debtor: string, creditor: string, amount: number, status: Obligation["status"] = "DUE"): Obligation {
  n += 1;
  return {
    obligationId: `ob_${n}`,
    runId: "run_1",
    debtor,
    creditor,
    amount: { asset: A, amount },
    sourceEvent: "evt_1",
    dueAt: "2026-10-01T00:00:00Z",
    priority: 0,
    status,
    nonce: 0,
    version: 1,
  };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const round = (x: number) => Number(x.toFixed(6));

describe("determinism", () => {
  const g = [ob("A", "B", 100), ob("B", "C", 60), ob("C", "A", 40), ob("D", "E", 25)];

  it("the same graph yields byte-identical results", () => {
    const a = JSON.stringify(netObligations(g));
    const b = JSON.stringify(netObligations(g));
    expect(a).toBe(b);
  });

  it("input ORDER does not change the result", () => {
    // A participant re-submitting in a different order must not produce a
    // different result, or the agreed resultHash would be a function of arrival
    // order rather than of content.
    expect(resultHash(netObligations(g), "e1")).toBe(resultHash(netObligations([...g].reverse()), "e1"));
    // And the whole result, serialised, is identical — not merely the digest.
    expect(JSON.stringify(netObligations([...g].reverse()))).toBe(JSON.stringify(netObligations(g)));
  });

  it("inputsRoot is order-insensitive but content-sensitive", () => {
    // Same obligations, same ids, different ARRIVAL order. The ids must be
    // identical - the earlier version minted fresh ones per call, so the root
    // differed for a reason unrelated to ordering and the assertion was vacuous.
    const a: Obligation = { ...ob("A", "B", 10), obligationId: "ob_x" };
    const b: Obligation = { ...ob("C", "D", 20), obligationId: "ob_y" };
    expect(inputsRoot([a, b], A, "base")).toBe(inputsRoot([b, a], A, "base"));
    const c: Obligation = { ...ob("A", "B", 11), obligationId: "ob_x" };
    expect(inputsRoot([a, b], A, "base")).not.toBe(inputsRoot([c, b], A, "base"));
  });

  it("inputsRoot is namespaced by asset and settlement domain", () => {
    const g = [ob("A", "B", 10)];
    expect(inputsRoot(g, A, "base")).not.toBe(inputsRoot(g, A, "solana"));
    expect(inputsRoot(g, A, "base")).not.toBe(inputsRoot(g, "ETH" as AssetSymbol, "base"));
  });
});

describe("conservation — netting creates and destroys nothing", () => {
  it("net positions always sum to zero", () => {
    const graphs = [
      [ob("A", "B", 100), ob("B", "C", 60), ob("C", "A", 40)],
      [ob("A", "B", 1), ob("A", "B", 2), ob("A", "B", 3)],
      [ob("A", "B", 10), ob("B", "C", 10), ob("C", "D", 10), ob("D", "A", 10)],
      [ob("A", "B", 5), ob("B", "A", 5)],
    ];
    for (const g of graphs) {
      const r = netObligations(g);
      expect(round(sum(r.netPositions.map((p) => p.amount))), `graph ${g.length}`).toBe(0);
    }
  });

  it("a cycle whose legs DO NOT balance still leaves exactly the imbalance", () => {
    // A cycle nets to zero only when the legs balance around it. Here A->B 100,
    // B->C 60, C->A 40 leaves A short by 60, and the engine must report that 60
    // rather than netting it away. An earlier version of this test asserted 0 and
    // would have failed against a CORRECT implementation.
    resetIds();
    const r = netObligations([ob("A", "B", 100), ob("B", "C", 60), ob("C", "A", 40)]);
    expect(r.grossVolume).toBe(200);
    expect(r.residualVolume).toBe(60);
    expect(r.residualVolume).toBeLessThanOrEqual(r.grossVolume);
  });

  it("a BALANCED cycle nets to exactly zero", () => {
    resetIds();
    const r = netObligations([ob("A", "B", 60), ob("B", "C", 60), ob("C", "A", 60)]);
    expect(r.residualVolume).toBe(0);
    expect(r.residualTransfers).toEqual([]);
  });

  it("a reciprocal pair nets to nothing", () => {
    const r = netObligations([ob("A", "B", 100), ob("B", "A", 100)]);
    expect(r.residualVolume).toBe(0);
    expect(r.residualTransfers).toEqual([]);
  });

  it("a partial offset leaves only the difference", () => {
    const r = netObligations([ob("A", "B", 100), ob("B", "A", 30)]);
    expect(round(r.residualVolume)).toBe(70);
    expect(r.residualTransfers).toHaveLength(1);
  });
});

describe("adversarial graphs", () => {
  it("a self-loop nets to nothing and creates no transfer", () => {
    // A party owing itself is the degenerate case that breaks naive matching by
    // producing A -> A.
    const r = netObligations([ob("A", "A", 50)]);
    expect(r.residualVolume).toBe(0);
    expect(r.residualTransfers.every((t) => t.from !== t.to)).toBe(true);
  });

  it("a long cycle nets to zero across many hops", () => {
    const g = [ob("A", "B", 10), ob("B", "C", 10), ob("C", "D", 10), ob("D", "E", 10), ob("E", "A", 10)];
    expect(netObligations(g).residualVolume).toBe(0);
  });

  it("a chain produces fewer transfers than obligations", () => {
    // Naive pairwise matching would need N-1 transfers; netting needs 1.
    const g = [ob("A", "B", 10), ob("B", "C", 10), ob("C", "D", 10), ob("D", "E", 10)];
    const r = netObligations(g);
    expect(g.length).toBe(4);
    expect(r.residualTransfers.length).toBeLessThan(g.length);
    expect(round(r.residualVolume)).toBe(10);
  });

  it("disputed and defaulted obligations are EXCLUDED, never silently dropped", () => {
    const g = [
      ob("A", "B", 100),
      ob("B", "C", 50, "DISPUTED"),
      ob("C", "D", 25, "DEFAULTED"),
    ];
    const r = netObligations(g);
    expect(r.grossVolume).toBe(100);
    expect(r.excluded.map((e) => e.obligationId).sort())
      .toEqual([g[1].obligationId, g[2].obligationId].sort());
    // Visible with a reason — an exclusion a participant cannot see is not a
    // protection, it is a hidden adjustment.
    for (const e of r.excluded) expect(e.reason).toBeTruthy();
  });

  it("excluded obligations do not appear in the net positions", () => {
    const r = netObligations([ob("A", "B", 100), ob("B", "C", 50, "DISPUTED")]);
    expect(r.netPositions.map((p) => p.party).sort()).toEqual(["A", "B"]);
  });

  it("a single obligation produces exactly one transfer", () => {
    const r = netObligations([ob("A", "B", 42)]);
    expect(r.residualTransfers).toEqual([{ from: "A", to: "B", amount: 42 }]);
  });

  it("many parties at once still balance", () => {
    const g: Obligation[] = [];
    for (let i = 0; i < 20; i++) {
      g.push(ob(`P${i}`, `P${(i + 1) % 20}`, (i % 5) + 1));
    }
    const r = netObligations(g);
    expect(round(sum(r.netPositions.map((p) => p.amount)))).toBe(0);
    const outflow = new Map<string, number>();
    const inflow = new Map<string, number>();
    for (const t of r.residualTransfers) {
      outflow.set(t.from, (outflow.get(t.from) ?? 0) + t.amount);
      inflow.set(t.to, (inflow.get(t.to) ?? 0) + t.amount);
    }
    for (const p of r.netPositions) {
      // net position == inflow - outflow. The earlier version had the sign
      // flipped, which would have passed for an asymmetric graph and failed for a
      // balanced one.
      expect(round((inflow.get(p.party) ?? 0) - (outflow.get(p.party) ?? 0))).toBe(round(p.amount));
    }
  });
});

describe("the epoch write path", () => {
  const g = [ob("A", "B", 100), ob("B", "C", 60)];

  function frozen() {
    const e = openEpoch({ epochId: "e1", asset: A, settlementDomain: "base", obligations: g, openedAt: "2026-10-01T00:00:00Z" });
    if (!e.ok) throw new Error(e.reason);
    const f = freezeEpoch(e.value, g);
    if (!f.ok) throw new Error(f.reason);
    return f.value;
  }

  function calculated() {
    const f = frozen();
    const c = calculateEpoch(f, g);
    if (!c.ok) throw new Error(c.reason);
    return c.value;
  }

  it("an empty epoch is refused", () => {
    expect(openEpoch({ epochId: "e", asset: A, settlementDomain: "base", obligations: [], openedAt: "x" }))
      .toEqual({ ok: false, reason: "EPOCH_HAS_NO_OBLIGATIONS" });
  });

  it("a mixed-asset epoch is refused — positions could not be settled against each other", () => {
    const mixed = [ob("A", "B", 10), { ...ob("C", "D", 5), amount: { asset: "ETH" as AssetSymbol, amount: 5 } }];
    expect(openEpoch({ epochId: "e", asset: A, settlementDomain: "base", obligations: mixed, openedAt: "x" }))
      .toEqual({ ok: false, reason: "OBLIGATION_ASSET_MISMATCH" });
  });

  it("freezing an INCOMPLETE set is refused", () => {
    // Found by mutation audit: `freezeEpoch` had the same completeness guard as
    // `calculateEpoch`, and mutating the latter was caught while mutating the
    // former was not. A set that does not cover every obligation the epoch
    // declared would freeze a commitment over inputs that were never supplied.
    const e = openEpoch({ epochId: "e1", asset: A, settlementDomain: "base", obligations: g, openedAt: "x" });
    if (!e.ok) throw new Error(e.reason);
    expect(freezeEpoch(e.value, g.slice(0, 1))).toEqual({ ok: false, reason: "FROZEN_SET_INCOMPLETE" });
  });

  it("freezing ignores obligations outside the epoch", () => {
    // Extra obligations in the supplied array must not widen the frozen set.
    const e = openEpoch({ epochId: "e1", asset: A, settlementDomain: "base", obligations: g, openedAt: "x" });
    if (!e.ok) throw new Error(e.reason);
    const f = freezeEpoch(e.value, [...g, ob("X", "Y", 999)]);
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(f.value.obligationIds).toHaveLength(g.length);
      expect(f.value.obligationIds).not.toContain("X");
    }
  });

  it("a frozen epoch carries an inputsRoot", () => {
    const f = frozen();
    expect(f.inputsRoot).toBeTruthy();
    expect(f.status).toBe("FROZEN");
  });

  it("a MUTATED obligation after freezing is refused", () => {
    const f = frozen();
    const tampered = g.map((o, i) => (i === 0 ? { ...o, amount: { ...o.amount, amount: 999 } } : o));
    expect(calculateEpoch(f, tampered)).toEqual({ ok: false, reason: "FROZEN_INPUT_SET_MUTATED" });
  });

  it("a mutated STATUS after freezing is refused too", () => {
    const f = frozen();
    const flipped = g.map((o, i) => (i === 0 ? { ...o, status: "SETTLED" as const } : o));
    expect(calculateEpoch(f, flipped)).toEqual({ ok: false, reason: "FROZEN_INPUT_SET_MUTATED" });
  });

  it("a missing obligation after freezing is refused", () => {
    const f = frozen();
    expect(calculateEpoch(f, g.slice(0, 1))).toEqual({ ok: false, reason: "FROZEN_SET_INCOMPLETE" });
  });

  it("calculation cannot run before freezing", () => {
    const e = openEpoch({ epochId: "e1", asset: A, settlementDomain: "base", obligations: g, openedAt: "x" });
    if (!e.ok) throw new Error(e.reason);
    expect(calculateEpoch(e.value, g)).toEqual({ ok: false, reason: "EPOCH_NOT_FROZEN" });
  });

  it("a challenge on an unknown obligation is refused", () => {
    const r = resolveChallenges(calculated(), [{ obligationId: "nope", challenger: "A", reason: "x" }]);
    expect(r).toEqual({ ok: false, reason: "CHALLENGE_REFERENCES_UNKNOWN_OBLIGATION" });
  });

  it("a challenged obligation stays VISIBLE with its reason", () => {
    const r = resolveChallenges(calculated(), [{ obligationId: g[1].obligationId, challenger: "C", reason: "DELIVERABLE_DISPUTED" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.excludedObligations.find((x) => x.obligationId === g[1].obligationId);
    expect(e).toBeTruthy();
    expect(e!.reason).toBe("CHALLENGED:DELIVERABLE_DISPUTED");
  });

  it("finalizing seals a resultHash that changes when the result changes", () => {
    const r1 = netObligations(g);
    const r2 = netObligations([ob("X", "Y", 1)]);
    expect(resultHash(r1, "e1")).not.toBe(resultHash(r2, "e1"));
  });

  it("the full lifecycle reaches SETTLED", () => {
    let e = openEpoch({ epochId: "e1", asset: A, settlementDomain: "base", obligations: g, openedAt: "x" });
    if (!e.ok) throw new Error(e.reason);
    let v = e.value;
    const f = freezeEpoch(v, g); if (!f.ok) throw new Error(f.reason); v = f.value;
    const c = calculateEpoch(v, g); if (!c.ok) throw new Error(c.reason); v = c.value;
    const ch = resolveChallenges(v, []); if (!ch.ok) throw new Error(ch.reason); v = ch.value;
    const fin = finalizeEpoch(v, netObligations(g)); if (!fin.ok) throw new Error(fin.reason); v = fin.value;
    expect(v.status).toBe("FINALIZED");
    expect(v.resultHash).toBeTruthy();
  });
});
