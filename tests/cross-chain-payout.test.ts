import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  CAIP2_MAINNET, CAIP2_TESTNET, EXTERNAL_CHAIN_IDS, LiFiPayoutRelayer, MAX_FEE_USD,
  MAX_SLIPPAGE_BPS, SimulatedPayoutRelayer, buildCrossChainReceipt, crossChainReceiptHash,
  isExternalChain, maxFeeFor, planCrossChainPayout, resolveExternalChain,
  validatePayoutRecipient,
  type BridgePayoutInput, type BridgePayoutResult, type BridgeQuote, type BridgeQuoteInput, type CrossChainPayoutRelayer,
} from "@/lib/adapters/cross-chain-payout";
import type { Money } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import { agreementPaymentDigest } from "@/lib/kernel/settlement";

const USDC = (amount: number): Money => ({ asset: "USDC", amount });
/** A real, correctly checksummed address — `getAddress` on a known-lowercase input. */
const RECIPIENT = getAddress("0x8ba1f109551bd432803012645Ac136ddd64dba72");
const BAD_CHECKSUM = "0x8BA1F109551BD432803012645Ac136ddd64DBA72";

/**
 * 0.5% of a $10 payout. The ceiling for $10 is 1% = $0.10, so this is inside it — the
 * earlier `USDC(0.5)` fixture was only valid while `maxFeeFor` was 100x too small, which
 * is a good illustration of a fixture quietly depending on a bug.
 */
const quote = (over: Partial<BridgeQuote> = {}): BridgeQuote => ({
  bridgeFee: USDC(0.05), slippageBps: 10, ...over,
});
const input = (over: Partial<Parameters<typeof planCrossChainPayout>[0]> = {}) => ({
  sourceChain: "base" as const,
  targetChain: "bnb",
  recipient: RECIPIENT,
  amount: USDC(10),
  quote: quote(),
  remainingHeadroom: USDC(100),
  ...over,
});

// ── identity ────────────────────────────────────────────────────────────────────

describe("LP-7 — a payout address is validated before anything else", () => {
  it("accepts a correctly checksummed address", () => {
    const r = validatePayoutRecipient(RECIPIENT);
    expect(r.ok).toBe(true);
  });

  it("REFUSES an address that does not carry a valid EIP-55 checksum", () => {
    // Not a pedantic check: an address that does not checksum was not verified by a human
    // or a tool before real money was sent to it, and a mistyped-but-plausible address is
    // exactly what EIP-55 exists to catch.
    expect(validatePayoutRecipient(BAD_CHECKSUM)).toMatchObject({ ok: false, reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS" });
    expect(validatePayoutRecipient(RECIPIENT.toLowerCase())).toMatchObject({ ok: false, reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS" });
  });

  it("REFUSES the zero address even though it is a valid checksummed address", () => {
    // It passes the checksum test, and it would burn the payout.
    const zero = getAddress("0x0000000000000000000000000000000000000000");
    expect(validatePayoutRecipient(zero)).toMatchObject({ ok: false, reason: "ZERO_ADDRESS_PAYOUT_REFUSED" });
  });

  it("REFUSES anything that is not an address at all", () => {
    for (const bad of ["", "0x", "not-an-address", RECIPIENT.slice(0, -1), `${RECIPIENT}00`, "0xZZ" + RECIPIENT.slice(4)]) {
      expect(validatePayoutRecipient(bad).ok, `${bad} must be refused`).toBe(false);
    }
  });

  it("resolves only the chains in the registry, and never guesses a chain id", () => {
    expect(resolveExternalChain("bnb")).toMatchObject({ ok: true, value: "bnb" });
    expect(resolveExternalChain("xlayer")).toMatchObject({ ok: true, value: "xlayer" });
    for (const unknown of ["ethereum", "arbitrum", "polygon", "BNB", "", "base"]) {
      expect(resolveExternalChain(unknown).ok, `${unknown} must not be a payout destination`).toBe(false);
    }
    const unknown = resolveExternalChain("matic");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("UNSUPPORTED_PAYOUT_CHAIN");
  });

  it("pairs each chain with its mainnet and testnet ids", () => {
    expect(EXTERNAL_CHAIN_IDS.bnb).toMatchObject({ mainnet: 56, testnet: 97 });
    expect(EXTERNAL_CHAIN_IDS.xlayer).toMatchObject({ mainnet: 196, testnet: 195 });
    expect(CAIP2_MAINNET).toEqual({ bnb: "eip155:56", xlayer: "eip155:196" });
    expect(CAIP2_TESTNET).toEqual({ bnb: "eip155:97", xlayer: "eip155:195" });
  });

  it("distinguishes external chains from canonical ones", () => {
    expect(isExternalChain("bnb")).toBe(true);
    expect(isExternalChain("base")).toBe(false);
  });
});

// ── fee & slippage ──────────────────────────────────────────────────────────────

describe("LP-7 — the fee ceiling is min(1%, $2)", () => {
  it("scales with the amount below the cap", () => {
    expect(maxFeeFor(USDC(10))).toBeCloseTo(0.1, 6);   // 1% of 10
    expect(maxFeeFor(USDC(100))).toBeCloseTo(1, 6);   // 1% of 100
  });

  it("stops at the absolute cap for large payouts", () => {
    // 1% of 1000 would be $10; the cap is $2, so a large payout is not charged a tenth of
    // itself to be bridged.
    expect(maxFeeFor(USDC(1000))).toBeCloseTo(MAX_FEE_USD, 6);
    expect(maxFeeFor(USDC(100000))).toBeCloseTo(MAX_FEE_USD, 6);
  });

  it("never charges most of a small payout", () => {
    // min(1% of 3, $2) = $0.03, so a $3 transfer is not eaten by a $2 fee.
    expect(maxFeeFor(USDC(3))).toBeCloseTo(0.03, 6);
  });

  it("REFUSES a quote above the ceiling", () => {
    expect(planCrossChainPayout(input({ quote: quote({ bridgeFee: USDC(0.11) }) })))
      .toMatchObject({ ok: false, reason: "EXCEEDS_BRIDGE_FEE_LIMIT" });
  });

  it("accepts a quote exactly at the ceiling", () => {
    // Boundary: the guard is `<=`-shaped, and an off-by-one here either blocks every
    // legitimate max-fee route or lets one over the line through.
    const atCap = maxFeeFor(USDC(10));
    expect(planCrossChainPayout(input({ quote: quote({ bridgeFee: USDC(atCap) }) })).ok).toBe(true);
  });

  it("REFUSES a negative or non-finite fee rather than treating it as free", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = planCrossChainPayout(input({ quote: quote({ bridgeFee: USDC(bad) }) }));
      expect(r.ok, `fee ${bad} must be refused`).toBe(false);
    }
  });

  it("REFUSES a fee in a different asset than the payout", () => {
    const r = planCrossChainPayout(input({ quote: quote({ bridgeFee: { asset: "USDT", amount: 0.5 } }) }));
    expect(r).toMatchObject({ ok: false, reason: "BRIDGE_FEE_ASSET_MISMATCH" });
  });

  it("REFUSES a quote requiring more than 50 bps of slippage", () => {
    expect(planCrossChainPayout(input({ quote: quote({ slippageBps: Number(MAX_SLIPPAGE_BPS) + 1 }) })))
      .toMatchObject({ ok: false, reason: "EXCEEDS_SLIPPAGE_LIMIT" });
    expect(planCrossChainPayout(input({ quote: quote({ slippageBps: Number(MAX_SLIPPAGE_BPS) }) })).ok).toBe(true);
  });
});

// ── headroom ────────────────────────────────────────────────────────────────────

describe("LP-7 — the fee is charged against the payer's headroom too", () => {
  it("REFUSES when amount alone fits but amount + fee does not", () => {
    // THE reason the fee is in the guard at all: amount 10 ≤ headroom 10 looks payable,
    // and the fee is what makes it not.
    expect(planCrossChainPayout(input({ amount: USDC(10), remainingHeadroom: USDC(10), quote: quote({ bridgeFee: USDC(0.05) }) })))
      .toMatchObject({ ok: false, reason: "PAYOUT_EXCEEDS_HEADROOM" });
  });

  it("accepts when amount + fee fits exactly", () => {
    const r = planCrossChainPayout(input({ amount: USDC(10), remainingHeadroom: USDC(10.05), quote: quote({ bridgeFee: USDC(0.05) }) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.totalDebit.amount).toBeCloseTo(10.05, 6);
  });

  it("reports the total debit, so the caller records what was actually spent", () => {
    const r = planCrossChainPayout(input({ amount: USDC(10), quote: quote({ bridgeFee: USDC(0.02) }) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.totalDebit.amount).toBeCloseTo(10.02, 6);
  });
});

// ── ordering of refusals ────────────────────────────────────────────────────────

describe("LP-7 — refusals name the FIRST thing that is wrong", () => {
  it("reports a bad chain before a bad address", () => {
    expect(planCrossChainPayout(input({ targetChain: "polygon", recipient: BAD_CHECKSUM })))
      .toMatchObject({ ok: false, reason: "UNSUPPORTED_PAYOUT_CHAIN" });
  });

  it("reports a bad address before a bad price", () => {
    // Someone debugging a refused payout should be told the first thing actually wrong,
    // not the most expensive thing wrong.
    expect(planCrossChainPayout(input({ recipient: BAD_CHECKSUM, quote: quote({ bridgeFee: USDC(99) }) })))
      .toMatchObject({ ok: false, reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS" });
  });

  it("reports a bad price before an exhausted headroom", () => {
    expect(planCrossChainPayout(input({ remainingHeadroom: USDC(1), quote: quote({ bridgeFee: USDC(99) }) })))
      .toMatchObject({ ok: false, reason: "EXCEEDS_BRIDGE_FEE_LIMIT" });
  });
});

// ── the simulator ───────────────────────────────────────────────────────────────

describe("LP-7 — the simulator announces itself and mints nothing", () => {
  const q: BridgeQuoteInput = { sourceChain: "base", targetChain: "bnb", recipient: RECIPIENT, amount: USDC(10) };

  it("tags every result as simulated, at LOCAL_PASS", async () => {
    const relayer = new SimulatedPayoutRelayer();
    const result = await relayer.executeBridgePayout({ ...q, quote: await relayer.quoteBridge(q), sourceTxHash: "0xabc" });
    expect(result.isSimulated).toBe(true);
    expect(result.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("NEVER returns a transaction hash, however it is asked", async () => {
    // The dangerous version of this bug is not a crash — it is a fake hash reaching a
    // settlement record and being the only thing in it that looks like evidence.
    const relayer = new SimulatedPayoutRelayer();
    const result = await relayer.executeBridgePayout({ ...q, quote: await relayer.quoteBridge(q), sourceTxHash: "0xabc" });
    expect(result).not.toHaveProperty("bridgeTxHash");
    expect(JSON.stringify(result)).not.toMatch(/0x[0-9a-f]{64}/);
  });

  it("quotes in the payout's asset, so a cross-asset fee cannot slip through", async () => {
    const relayer = new SimulatedPayoutRelayer({ fee: USDC(0.05) });
    const quoted = await relayer.quoteBridge({ ...q, amount: { asset: "USDT", amount: 10 } });
    expect(quoted.bridgeFee.asset).toBe("USDT");
  });
});

// ── the live relayer fails closed ───────────────────────────────────────────────

describe("LP-7 — the live relayer fails closed when unconfigured", () => {
  it("REFUSES to construct without an API key", () => {
    // Degrading to "no fee, just send it" when misconfigured would be indistinguishable
    // from a real cheap route in the settlement record.
    expect(() => new LiFiPayoutRelayer({ apiKey: undefined, integrator: RECIPIENT, testnet: true }))
      .toThrow(/UNCONFIGURED_RELAYER/);
  });

  it("REFUSES to report a payout it could not broadcast", async () => {
    // Constructed with a key but no signer: it can quote, but reporting a settlement it
    // never broadcast is the same lie as a simulated hash, with more authority.
    const relayer = new LiFiPayoutRelayer({
      apiKey: "k", integrator: RECIPIENT, testnet: true,
      fetchImpl: async () => new Response(JSON.stringify({ transaction: { data: "0x", to: RECIPIENT, value: "0" } }), { status: 200 }),
    });
    const result = await relayer.executeBridgePayout({
      sourceChain: "base", targetChain: "bnb", recipient: RECIPIENT, amount: USDC(10),
      quote: quote(), sourceTxHash: "0xabc",
    }).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/UNCONFIGURED_RELAYER/);
  });

  it("surfaces a provider error rather than quoting a zero fee", async () => {
    const relayer = new LiFiPayoutRelayer({
      apiKey: "k", integrator: RECIPIENT, testnet: true,
      fetchImpl: async () => new Response("upstream 503", { status: 503 }),
    });
    await expect(relayer.quoteBridge({ sourceChain: "base", targetChain: "bnb", recipient: RECIPIENT, amount: USDC(10) }))
      .rejects.toThrow(/LIFI_503/);
  });
});

// ── the receipt ─────────────────────────────────────────────────────────────────

describe("LP-7 — the canonical receipt is evidence, not a label", () => {
  const base = {
    agreementId: "ag_1", sourceChain: "base" as const, targetChain: "bnb" as const, testnet: true,
    recipient: RECIPIENT, amount: USDC(10), bridgeFee: USDC(0.05), sourceTxHash: "0xSOURCE",
    result: { recipient: RECIPIENT, amount: USDC(10), bridgeFee: USDC(0.05), isSimulated: false, evidenceLevel: "TESTNET_PASS" as const, bridgeTxHash: "0xBRIDGE" },
  };

  it("pins the destination chain id from the registry, not from the provider", () => {
    expect(buildCrossChainReceipt(base).targetChainId).toBe(97);
    expect(buildCrossChainReceipt({ ...base, testnet: false }).targetChainId).toBe(56);
  });

  it("carries both transaction hashes and the external status", () => {
    const r = buildCrossChainReceipt(base);
    expect(r.status).toBe("SETTLED_EXTERNALLY");
    expect(r.sourceTxHash).toBe("0xSOURCE");
    expect(r.bridgeTxHash).toBe("0xBRIDGE");
  });

  it("changes its hash when the agreement changes, so a receipt cannot be lifted onto another", () => {
    const a = buildCrossChainReceipt(base);
    const b = buildCrossChainReceipt({ ...base, agreementId: "ag_2" });
    expect(a.receiptHash).not.toBe(b.receiptHash);
  });

  it("changes its hash when the recipient changes", () => {
    const a = buildCrossChainReceipt(base);
    const b = buildCrossChainReceipt({ ...base, recipient: getAddress("0x000000000000000000000000000000000000dEaD") });
    expect(a.receiptHash).not.toBe(b.receiptHash);
  });

  it("changes its hash when the amount or the fee changes", () => {
    const a = buildCrossChainReceipt(base);
    expect(buildCrossChainReceipt({ ...base, amount: USDC(10.01) }).receiptHash).not.toBe(a.receiptHash);
    expect(buildCrossChainReceipt({ ...base, bridgeFee: USDC(0.06) }).receiptHash).not.toBe(a.receiptHash);
  });

  it("changes its hash when the destination chain changes", () => {
    const a = buildCrossChainReceipt(base);
    expect(buildCrossChainReceipt({ ...base, targetChain: "xlayer" }).receiptHash).not.toBe(a.receiptHash);
  });

  it("omits the bridge hash for a simulated run rather than emitting an empty one", () => {
    const r = buildCrossChainReceipt({
      ...base,
      result: { recipient: RECIPIENT, amount: USDC(10), bridgeFee: USDC(0.05), isSimulated: true, evidenceLevel: "LOCAL_PASS" },
    });
    expect(r).not.toHaveProperty("bridgeTxHash");
    expect(r.isSimulated).toBe(true);
    expect(r.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("is domain-separated, so a receipt hash cannot collide with another kind of hash", () => {
    const r = buildCrossChainReceipt(base);
    expect(r.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Case-insensitive address input hashes identically — EIP-55 is presentation, not identity.
    const lower = crossChainReceiptHash({ ...(({ receiptId: r.receiptId } as unknown) as Omit<typeof r, "receiptHash">), ...r, recipient: r.recipient.toLowerCase() as typeof r.recipient, receiptHash: undefined as never } as never);
    expect(lower).toBe(r.receiptHash);
  });

  it("produces a stable hash for identical input", () => {
    expect(buildCrossChainReceipt(base).receiptHash).toBe(buildCrossChainReceipt(base).receiptHash);
  });
});

/**
 * The cross-chain settlement path end to end (LP-7).
 *
 * The policy tests above prove the guards individually. These prove the thing that is
 * actually at stake: **the order of operations**. A guard that is never consulted because
 * the code took a different path is not a guard, and the ordering claims live in
 * `settleCrossChainAgreement`, not in the policy module.
 */
describe("LP-7 — the settlement path takes the bridge legs in order", () => {
  /** Records the order of the two legs, which is the property under test. */
  function recordingRelayer(log: string[], behaviour: { bridgeFails?: boolean } = {}) {
    return new (class implements CrossChainPayoutRelayer {
      readonly name = "recording";
      async quoteBridge(i: BridgeQuoteInput) {
        log.push("quote");
        return { bridgeFee: { ...i.amount, amount: 0.05 }, slippageBps: 10 };
      }
      async executeBridgePayout(i: BridgePayoutInput): Promise<BridgePayoutResult> {
        log.push("bridge");
        if (behaviour.bridgeFails) throw new Error("relayer 503");
        return {
          bridgeTxHash: "0xBRIDGE", recipient: i.recipient, amount: i.amount,
          bridgeFee: i.quote.bridgeFee, isSimulated: false, evidenceLevel: "TESTNET_PASS",
        };
      }
    })();
  }

  const settle = async (relayer: CrossChainPayoutRelayer, relayerAddress = RECIPIENT) => {
    const { settleCrossChainAgreement } = await import("@/lib/settlement/settle-agreement");
    return settleCrossChainAgreement(
      // A store that cannot hold the agreement is the one guard `settleCrossChainAgreement`
      // checks before anything else, so a real store is required here.
      fullStore({ getReservation: async () => null }) as unknown as EconomicRepository,
      {} as never,
      { agreementId: "ag_x", reservationId: "res_x", now: new Date("2026-10-01T00:00:00Z"), relayer, relayerAddress, testnet: true },
    );
  };

  it("REFUSES before touching the chain when the reservation is missing", async () => {
    // Cheap checks first: a missing reservation is a 404 and must not cost a quote.
    const log: string[] = [];
    const r = await settle(recordingRelayer(log));
    expect(r).toMatchObject({ ok: false, reason: "RESERVATION_NOT_FOUND" });
    expect(log, "no quote was requested").toEqual([]);
  });

  it("REFUSES a canonical payee rather than bridging it", async () => {
    // Bridging a Base payee would cost a relayer fee for nothing, and would move the
    // settlement off the proven path.
    const { settleCrossChainAgreement } = await import("@/lib/settlement/settle-agreement");
    const r = await settleCrossChainAgreement(
      fullStore({ getAgreement: async () => agreementWithExternalPayTo({ chain: "base" }) }) as unknown as EconomicRepository,
      {} as never,
      { agreementId: "ag_x", reservationId: "res_x", now: new Date(), relayer: recordingRelayer([]), relayerAddress: RECIPIENT, testnet: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "NOT_A_CROSS_CHAIN_PAYOUT" });
  });

  it("REFUSES a payee address that is not a strict checksum, before any quote", async () => {
    const log: string[] = [];
    const { settleCrossChainAgreement } = await import("@/lib/settlement/settle-agreement");
    const r = await settleCrossChainAgreement(
      fullStore({ getAgreement: async () => agreementWithExternalPayTo({ address: BAD_CHECKSUM }) }) as unknown as EconomicRepository,
      {} as never,
      { agreementId: "ag_x", reservationId: "res_x", now: new Date(), relayer: recordingRelayer(log), relayerAddress: RECIPIENT, testnet: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "INVALID_CHECKSUM_PAYOUT_ADDRESS" });
    expect(log).toEqual([]);
  });

  it("REFUSES when the VAULT cannot cover amount + fee, before the canonical leg", async () => {
    // The end-to-end version of the guard that exists because the fee is an extra debit.
    // The policy test proves the arithmetic; this proves the settlement path actually
    // consults the vault's headroom rather than something more convenient.
    const log: string[] = [];
    const { settleCrossChainAgreement } = await import("@/lib/settlement/settle-agreement");
    const r = await settleCrossChainAgreement(
      fullStore({ getVault: async () => ({ vaultId: "v_x", chain: "base", available: 10, emergencyFreeze: false, address: "0xvault" }) as never }) as unknown as EconomicRepository,
      {} as never,
      { agreementId: "ag_x", reservationId: "res_x", now: new Date("2026-10-01T00:00:00Z"), relayer: recordingRelayer(log), relayerAddress: RECIPIENT, testnet: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "PAYOUT_EXCEEDS_HEADROOM" });
    expect(log, "quoted, then refused on headroom — and never bridged").toEqual(["quote"]);
  });

  it("quotes BEFORE the canonical debit, so an unacceptable quote never moves money", async () => {
    // A quote that fails the fee or slippage guard must be discovered while the funds are
    // still in the vault. Discovering it after the canonical leg would mean the vault paid
    // a relayer for a bridge that then did not happen.
    const log: string[] = [];
    const relayer = new (class implements CrossChainPayoutRelayer {
      readonly name = "greedy";
      async quoteBridge(i: BridgeQuoteInput): Promise<BridgeQuote> {
        log.push("quote");
        return { bridgeFee: { ...i.amount, amount: 99 }, slippageBps: 10 };
      }
      async executeBridgePayout(): Promise<BridgePayoutResult> {
        log.push("bridge");
        throw new Error("must not be reached");
      }
    })();
    const { settleCrossChainAgreement } = await import("@/lib/settlement/settle-agreement");
    const r = await settleCrossChainAgreement(
      fullStore() as unknown as EconomicRepository,
      {} as never,
      { agreementId: "ag_x", reservationId: "res_x", now: new Date("2026-10-01T00:00:00Z"), relayer, relayerAddress: RECIPIENT, testnet: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "EXCEEDS_BRIDGE_FEE_LIMIT" });
    expect(log, "quoted, then refused — and never bridged").toEqual(["quote"]);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────────

function agreementWithExternalPayTo(payTo: { chain?: string; address?: string } = {}) {
  return {
    agreementId: "ag_x", spaceIds: ["s"], runId: "run_x", intentId: "i_x",
    client: "client_x", provider: "provider_x", externalJobRefs: [],
    price: { asset: "USDC", amount: 10 }, deadline: "2030-01-01T00:00:00Z",
    acceptanceCriteria: [], failurePolicy: "refund", status: "ACCEPTED", version: 1,
    payTo: { chain: payTo.chain ?? "bnb", address: payTo.address ?? RECIPIENT },
  } as never;
}

/** A repository that satisfies the persistence pre-check and refuses everything else. */
function noopStore(): Partial<EconomicRepository> {
  return {
    updateAgreement: async () => {},
    getSpace: async () => null,
    updateSpace: async () => {},
    listEvents: async () => [],
    appendEvent: async () => ({}) as never,
    listReservations: async () => [],
    getAgreement: async () => null,
    getReservation: async () => null,
    getMandate: async () => null,
    getVault: async () => null,
    claimSettlement: async () => true,
  };
}

/** A store where the happy path is far enough to reach the bridge legs. */
function fullStore(over: Partial<EconomicRepository> = {}): Partial<EconomicRepository> {
  return {
    ...noopStore(),
    getAgreement: async () => agreementWithExternalPayTo(),
    getReservation: async () => ({
      reservationId: "res_x", mandateId: "m_x", mandateVersion: 1, vaultId: "v_x", agreementId: "ag_x",
      amount: 10, asset: "USDC", chain: "base", nonce: 1, status: "RESERVED",
      // The REAL digest, not a placeholder: the reservation is bound to one exact action,
      // and a fixture with `actionDigest: "d"` is refused by ACTION_DIGEST_MISMATCH before
      // reaching the bridge guards — correct, and useless for testing them.
      actionDigest: agreementPaymentDigest(agreementWithExternalPayTo(), { vaultId: "v_x", mandateId: "m_x", mandateVersion: 1 }, "base"),
      expiresAt: "2030-01-01T00:00:00Z",
    }) as never,
    getMandate: async () => ({
      mandateId: "m_x", agentId: "client_x", vaultId: "v_x",
      status: "ACTIVE", expiresAt: "2030-01-01T00:00:00Z",
    }) as never,
    getVault: async () => ({
      vaultId: "v_x", chain: "base", available: 100, emergencyFreeze: false, address: "0xvault",
    }) as never,
    ...over,
  };
}
