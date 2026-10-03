/**
 * Sprint item 2: `getEvidence()` on Base, Tempo and Solana, and the receipts the
 * evidence names.
 *
 * Every rail's adapter is the real one; only the transport's `observe` is faked,
 * here, to return what a chain WOULD report. So these tests check the adapters'
 * logic — that a bundle is built only when the observation matches the record on
 * every field, and that each mismatch is named — not that any chain was observed.
 * The live check is the `BASE_LIVE=1` test in tests/settlement-caller.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Receipt, Settlement } from "@/lib/domain/types";
import type { ChainObservation } from "@/lib/adapters/types";
import { BaseSettlementAdapter, BASE_ASSETS, settlementCommitment, type BaseTransport } from "@/lib/adapters/base";
import { TempoSettlementAdapter, TEMPO_TOKENS, tempoCommitment, type TempoTransport } from "@/lib/adapters/tempo";
import { SolanaSettlementAdapter, solanaCommitment, type SolanaTransport } from "@/lib/adapters/solana";
import { bundleFromJson, bundleToJson, verifyEvidenceBundle, type EvidenceBundle } from "@/lib/evm/evidence";
import { linkReceipt, receiptHash, settlementReceipt, verifyReceiptChain } from "@/lib/kernel/receipts";
import { InMemoryRepository } from "@/lib/store/provider";
import { CapitalLedger } from "@/lib/store/ledger";

const OBSERVED_AT = "2026-10-01T12:05:00.000Z";
const EVM_FROM = "0x3333333333333333333333333333333333333333";
const EVM_TO = "0x1111111111111111111111111111111111111111";
const SOL_FROM = "8J8dPqRr4Xo1g7Vf2Z3mQxN6AqB1sY7kP9LdE4Mitra";
const SOL_TO = "Rec1J2qZt9GmN5FkV1xY8P3A4QcW7DeR2uL6T1Recv";

type Rail = {
  name: string;
  settlement: Settlement;
  /** The observation a faithful chain would return for `settlement`. */
  truth: ChainObservation;
  adapter: (observe: (tx: string) => Promise<ChainObservation | null>) =>
    { getEvidence: BaseSettlementAdapter["getEvidence"] };
  network: string;
  caseInsensitive: boolean;
};

const base = (over: Partial<Settlement>): Settlement => ({
  settlementId: "set_ag_1", runId: "run_1", agreementId: "ag_1", obligationIds: [],
  chain: "base", asset: "USDC", amount: 15, from: EVM_FROM, to: EVM_TO, txHash: `0x${"ab".repeat(32)}`,
  receiptId: "rcpt_set_ag_1", status: "CONFIRMED", submittedAt: OBSERVED_AT, evidenceLevel: "TESTNET_PASS", ...over,
});

const baseSettlement = base({});
const baseCommit = settlementCommitment({ settlementId: "set_ag_1", from: EVM_FROM, to: EVM_TO, amount: 15, asset: "USDC", chainId: 84532 });
const tempoSettlement = base({ chain: "tempo", asset: "PathUSD" });
const tempoCommit = tempoCommitment({ settlementId: "set_ag_1", from: EVM_FROM, to: EVM_TO, amount: { asset: "PathUSD", amount: 15 }, network: "moderato" });
const solSettlement = base({ chain: "solana", asset: "SOL", amount: 0.000003, from: SOL_FROM, to: SOL_TO, txHash: "5".repeat(88) });
const solCommit = solanaCommitment({ settlementId: "set_ag_1", from: SOL_FROM, to: SOL_TO, amount: { asset: "SOL", amount: 0.000003 } });

const rails: Rail[] = [
  {
    name: "base", network: "base-sepolia", caseInsensitive: true,
    settlement: { ...baseSettlement, commitment: baseCommit },
    truth: { txHash: baseSettlement.txHash!, block: 47646830, carriedCommitment: baseCommit, from: EVM_FROM, to: EVM_TO, amountAtomic: 15_000_000n, asset: BASE_ASSETS[84532].USDC.address.toLowerCase() },
    adapter: (observe) => new BaseSettlementAdapter({ chainId: 84532, transport: { send: async () => ({ txHash: "0x" }), verify: async () => ({ confirmed: true }), observe } as BaseTransport }),
  },
  {
    name: "tempo", network: "tempo-moderato", caseInsensitive: true,
    settlement: { ...tempoSettlement, commitment: tempoCommit },
    truth: { txHash: tempoSettlement.txHash!, block: 1234, carriedCommitment: tempoCommit, from: EVM_FROM, to: EVM_TO, amountAtomic: 15_000_000n, asset: TEMPO_TOKENS.PathUSD.mint.toLowerCase() },
    adapter: (observe) => new TempoSettlementAdapter({ network: "moderato", transport: { send: async () => ({ txHash: "0x" }), verify: async () => ({ confirmed: true }), observe } as TempoTransport }, tempoCommitment),
  },
  {
    name: "solana", network: "solana-devnet", caseInsensitive: false,
    settlement: { ...solSettlement, commitment: solCommit },
    truth: { txHash: solSettlement.txHash!, block: 507057927, carriedCommitment: solCommit, from: SOL_FROM, to: SOL_TO, amountAtomic: 3000n, asset: null },
    adapter: (observe) => new SolanaSettlementAdapter({ transport: { send: async () => ({ txHash: "x" }), verify: async () => ({ confirmed: true }), observe } as SolanaTransport }),
  },
];

for (const rail of rails) {
  describe(`getEvidence — ${rail.name}`, () => {
    const evidence = (obs: ChainObservation | null, settlement = rail.settlement) =>
      rail.adapter(async () => obs).getEvidence({ settlement, observedAt: OBSERVED_AT });

    it("builds a bundle from a matching observation, and the verifier accepts it at the TESTNET level", async () => {
      const b = await evidence(rail.truth);
      expect(b).not.toBeNull();
      expect(b!.chain).toBe(rail.network);
      expect(b!.commitment.toLowerCase()).toBe(rail.truth.carriedCommitment.toLowerCase());
      expect(b!.confirmation).toEqual({ txHash: rail.truth.txHash, blockNumber: rail.truth.block, observedAt: OBSERVED_AT });
      expect(b!.receiptId).toBe(rail.settlement.receiptId);
      // The overclaim this guards against: `observedLevel("base")` is Base MAINNET.
      expect(verifyEvidenceBundle(b!), "a testnet observation is never LIVE_PUBLIC_PASS").toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    });

    it("survives a JSON round trip and still verifies", async () => {
      const b = await evidence(rail.truth);
      const back = bundleFromJson(JSON.parse(JSON.stringify(bundleToJson(b!))));
      expect(verifyEvidenceBundle(back)).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    });

    it("a bundle altered after it was built is refused (COMMITMENT_MISMATCH)", async () => {
      const b = (await evidence(rail.truth))!;
      const altered = { ...b, typed: { ...b.typed, amountAtomic: b.typed.amountAtomic + 1n } } as EvidenceBundle;
      expect(verifyEvidenceBundle(altered)).toEqual({ ok: false, reason: "COMMITMENT_MISMATCH" });
    });

    it("nothing observed → null: no tx hash, not found, or no block reported", async () => {
      expect(await evidence(rail.truth, { ...rail.settlement, txHash: undefined })).toBeNull();
      expect(await evidence(null)).toBeNull();
      expect(await evidence({ ...rail.truth, block: 0 })).toBeNull();
    });

    const flip = (v: string) => v.slice(0, -1) + (v.endsWith("1") ? "2" : "1");
    const contradictions: Array<[string, Partial<ChainObservation>]> = [
      ["commitment", { carriedCommitment: `0x${"cd".repeat(32)}` }],
      ["from", { from: flip(rail.truth.from) }],
      ["to", { to: flip(rail.truth.to) }],
      ["amount", { amountAtomic: rail.truth.amountAtomic + 1n }],
      ["asset", { asset: rail.truth.asset === null ? "SomeMint111111111111111111111111111111111" : `0x${"99".repeat(20)}` }],
    ];
    for (const [field, change] of contradictions) {
      it(`an observation with a different ${field} is a contradiction, not a null`, async () => {
        await expect(evidence({ ...rail.truth, ...change })).rejects.toThrow(`EVIDENCE_CONTRADICTED:${field}`);
      });
    }

    if (!rail.caseInsensitive) {
      it("base58 addresses are compared exactly: a case change is a different address", async () => {
        await expect(evidence({ ...rail.truth, to: rail.truth.to.toLowerCase() })).rejects.toThrow("EVIDENCE_CONTRADICTED:to");
      });
    }

    it("a record whose stored commitment does not re-derive from its own terms is inconsistent", async () => {
      await expect(evidence(rail.truth, { ...rail.settlement, commitment: `0x${"00".repeat(32)}` })).rejects.toThrow("EVIDENCE_RECORD_INCONSISTENT");
    });

    it("a record with no receipt cannot be evidenced", async () => {
      await expect(evidence(rail.truth, { ...rail.settlement, receiptId: undefined })).rejects.toThrow("EVIDENCE_WITHOUT_RECEIPT");
    });

    it("a settlement from another rail is refused", async () => {
      const other = rails.find((r) => r.name !== rail.name)!;
      await expect(evidence(rail.truth, other.settlement)).rejects.toThrow("EVIDENCE_WRONG_RAIL");
    });
  });
}

describe("receipts (PRD §17.3)", () => {
  const confirmed = (id: string): Settlement => base({ settlementId: id, receiptId: undefined, txHash: `0x${id.length.toString(16).padStart(64, "0")}` });

  it("a SettlementReceipt names the network and transaction, and is marked unsigned", () => {
    const r = settlementReceipt(confirmed("set_a"), "base-sepolia", new Date(OBSERVED_AT));
    expect(r.chainEvidence).toEqual([`base-sepolia:tx:${confirmed("set_a").txHash}`]);
    expect(r.signer.startsWith("unsigned:"), "no signature exists, so the signer field must not read like one").toBe(true);
    expect(() => settlementReceipt({ ...confirmed("set_b"), status: "SUBMITTED" }, "base-sepolia", new Date())).toThrow();
  });

  it("chains per run, and altering any earlier receipt breaks the next link", async () => {
    const repo = new InMemoryRepository(new CapitalLedger([], []));
    const r1 = await repo.appendReceipt(settlementReceipt(confirmed("set_1"), "base-sepolia", new Date(OBSERVED_AT)));
    const r2 = await repo.appendReceipt(settlementReceipt(confirmed("set_22"), "base-sepolia", new Date(OBSERVED_AT)));
    expect(r1.previousReceiptHash).toBeUndefined();
    expect(r2.previousReceiptHash).toBe(receiptHash(r1));
    const chain = await repo.listReceipts("run_1");
    expect(verifyReceiptChain(chain)).toEqual({ ok: true });

    const tampered: Receipt[] = [{ ...chain[0], payloadHash: "sha256:forged" }, chain[1]];
    expect(verifyReceiptChain(tampered)).toEqual({ ok: false, brokenAt: r2.receiptId, reason: "PREVIOUS_HASH_MISMATCH" });
  });

  it("appending the same receipt id again returns the original rather than minting a second", async () => {
    const repo = new InMemoryRepository(new CapitalLedger([], []));
    const draft = settlementReceipt(confirmed("set_1"), "base-sepolia", new Date(OBSERVED_AT));
    const a = await repo.appendReceipt(draft);
    const b = await repo.appendReceipt({ ...draft, createdAt: "2027-01-01T00:00:00.000Z" });
    expect(b).toEqual(a);
    expect(await repo.listReceipts("run_1")).toHaveLength(1);
  });

  it("linkReceipt gives the first receipt in a run no predecessor", () => {
    expect(linkReceipt(settlementReceipt(confirmed("set_1"), "x", new Date()), null).previousReceiptHash).toBeUndefined();
  });
});
