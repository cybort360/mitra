/**
 * The EVM standards layer: ERC-8183, ERC-8004, x402/MPP, ERC-4337.
 *
 * EIP-712 and ERC-1271 are covered in `evm-standards.test.ts`.
 *
 * Each standard is tested for the property that would hurt most if it were
 * wrong, and three of those properties are about *refusing* rather than
 * accepting — which is the direction these integrations fail. A payment protocol
 * that accepts an over-ceiling charge, a job projection that emits an unfunded
 * escrow, and a reputation score that raises a limit are all "working" code.
 */
import { describe, expect, it } from "vitest";
import type { Agent, Agreement, Deliverable, Reservation } from "@/lib/domain/types";
import {
  AGREEMENT_TO_JOB_STATE,
  evaluateJobSubmission,
  fromErc8183State,
  toErc8183Job,
} from "@/lib/evm/erc8183";
import {
  applyReputation,
  rankForDiscovery,
  recordExternalRef,
  toErc8004Registration,
} from "@/lib/evm/erc8004";
import {
  chargeSession,
  closeSession,
  openSession,
  tempoPaymentMetadata,
  tempoReceiptMapping,
  withDecimals,
  x402ChallengeValid,
  type BoundedSession,
} from "@/lib/evm/payment";
import {
  ENTRY_POINT_V07,
  batchForBundler,
  packUserOperation,
  userOperationHash,
  validateUserOperation,
  type UserOperation,
} from "@/lib/evm/erc4337";

const NOW = new Date("2026-10-02T12:00:00Z");

function agreement(over: Partial<Agreement> = {}): Agreement {
  return {
    agreementId: "ag_1", spaceId: "sp_1", runId: "r", intentId: "i",
    client: "buyer", provider: "prov", evaluator: "ev",
    externalJobRefs: [], price: { asset: "USDC", amount: 10 },
    deadline: "2026-10-10T00:00:00Z", acceptanceCriteria: ["c1"],
    failurePolicy: "refund", status: "FUNDED", version: 1, ...over,
  } as Agreement;
}
function reservation(over: Partial<Reservation> = {}): Reservation {
  return {
    reservationId: "res_1", agreementId: "ag_1", amount: 10,
    status: "RESERVED", ...over,
  } as Reservation;
}

describe("ERC-8183 — the projection is total and refuses unbacked escrow", () => {
  it("maps every agreement status", () => {
    for (const s of Object.keys(AGREEMENT_TO_JOB_STATE)) {
      expect(fromErc8183State(AGREEMENT_TO_JOB_STATE[s as Agreement["status"]]), s).toBe(s);
    }
  });

  it("projects a backed job", () => {
    const r = toErc8183Job(agreement(), reservation());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.job.state).toBe("Funded");
    expect(r.job.escrowReservationId).toBe("res_1");
    expect(r.job.evaluator).toBe("ev");
  });

  it("REFUSES a job with no escrow behind it", () => {
    // An ERC-8183 consumer reads escrow as held funds. A job with no reservation
    // would present an unfunded commitment as funded.
    expect(toErc8183Job(agreement(), null)).toEqual({ ok: false, reason: "ERC8183_ESCROW_UNBACKED" });
  });

  it("REFUSES escrow for a DIFFERENT agreement", () => {
    expect(toErc8183Job(agreement(), reservation({ agreementId: "other" })))
      .toEqual({ ok: false, reason: "ERC8183_ESCROW_AGREEMENT_MISMATCH" });
  });

  it("REFUSES underfunded escrow", () => {
    expect(toErc8183Job(agreement(), reservation({ amount: 1 })))
      .toEqual({ ok: false, reason: "ERC8183_ESCROW_UNDERFUNDED" });
  });

  it("REFUSES a job with no evaluator", () => {
    const a = agreement({ evaluator: undefined });
    expect(toErc8183Job(a, reservation()).ok).toBe(false);
  });

  it("submission and acceptance stay separate", () => {
    const job = toErc8183Job(agreement({ status: "SUBMITTED" }), reservation());
    if (!job.ok) throw new Error("fixture");
    const d: Deliverable = { deliverableId: "d", agreementId: "ag_1", provider: "prov",
      artifactRefs: ["ipfs://x"], contentHash: "h", evidenceRefs: [], submittedAt: "", accepted: false, version: 1 } as Deliverable;
    expect(evaluateJobSubmission(job.job, d, true).ok).toBe(true);
    // Accepting with no artifact is refused.
    expect(evaluateJobSubmission(job.job, { ...d, artifactRefs: [] }, true))
      .toEqual({ ok: false, reason: "ACCEPTED_WITHOUT_ARTIFACT" });
  });

  it("a job that is not SUBMITTED cannot be evaluated", () => {
    const job = toErc8183Job(agreement({ status: "FUNDED" }), reservation());
    if (!job.ok) throw new Error("fixture");
    const d = { agreementId: "ag_1", artifactRefs: ["x"], contentHash: "h" } as Deliverable;
    expect(evaluateJobSubmission(job.job, d, true)).toEqual({ ok: false, reason: "JOB_NOT_SUBMITTED" });
  });
});

describe("ERC-8004 — projected outward, never authoritative inward", () => {
  const agent = { agentId: "agt_1", capabilities: ["research", "analysis"] } as unknown as Agent;

  it("projects an agent with sorted services", () => {
    const r = toErc8004Registration(agent, { chain: "base", address: "0x1", tokenId: "7" });
    expect(r.ok && r.registration.services).toEqual(["analysis", "research"]);
  });

  it("REFUSES an agent advertising nothing", () => {
    const empty = { agentId: "a", capabilities: [] } as unknown as Agent;
    expect(toErc8004Registration(empty, { chain: "base", address: "0x1", tokenId: "7" }))
      .toEqual({ ok: false, reason: "AGENT_HAS_NO_SERVICES" });
  });

  it("records an external ref without treating it as identity", () => {
    const r = toErc8004Registration(agent, { chain: "base", address: "0xabc", tokenId: "9" });
    if (!r.ok) throw new Error("fixture");
    const ref = recordExternalRef("agt_1", r.registration);
    expect(ref.system).toBe("erc8004:base");
    expect(ref.id).toBe("9");
  });

  it("reputation is a CLAIM, and ranking is the only thing it may influence", () => {
    const claims = applyReputation([], { agentId: "a", registryAddress: "0xR", score: 10, observedAt: "t" });
    expect(claims).toHaveLength(1);
    // Re-claiming from the same registry replaces rather than accumulates, so a
    // registry cannot inflate a score by writing twice.
    const two = applyReputation(claims, { agentId: "a", registryAddress: "0xR", score: 99, observedAt: "t" });
    expect(two).toHaveLength(1);
    expect(two[0].score).toBe(99);
    expect(() => applyReputation([], { agentId: "a", registryAddress: "0xR", score: -1, observedAt: "t" })).toThrow();
  });

  it("discovery ranking is stable for equal scores", () => {
    const mk = (id: string) => ({ registration: { agentId: id } as never, claimedReputation: 5 });
    const out = rankForDiscovery([mk("b"), mk("a"), mk("c")]);
    expect(out.map((r) => r.agentId)).toEqual(["b", "a", "c"]);
  });
});

describe("x402 / MPP — the ceiling is the point", () => {
  function session(): BoundedSession {
    const r = openSession({
      sessionId: "s1", reservationId: "res_1",
      ceiling: { asset: "USDC", amount: 10, expiresAt: "2026-10-03T00:00:00Z" },
    });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  }

  it("a session REQUIRES a reservation", () => {
    expect(openSession({ sessionId: "s", reservationId: "", ceiling: { asset: "USDC", amount: 1, expiresAt: "2026-10-03T00:00:00Z" } }))
      .toEqual({ ok: false, reason: "SESSION_REQUIRES_RESERVATION" });
  });

  it("charges accumulate against one ceiling", () => {
    let s = session();
    for (let i = 0; i < 3; i++) {
      const r = chargeSession(s, 3, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.value.session;
    }
    expect(s.spent).toBe(9);
    expect(s.charges).toBe(3);
  });

  it("REFUSES a charge past the ceiling", () => {
    // The failure mode this prevents: a session charged past its allowance is a
    // wallet with no limit, and it surfaces as an oversized bill.
    let s = session();
    const r1 = chargeSession(s, 9, NOW);
    if (!r1.ok) throw new Error("fixture");
    s = r1.value.session;
    expect(chargeSession(s, 2, NOW)).toEqual({ ok: false, reason: "SESSION_CEILING_EXCEEDED" });
    expect(chargeSession(s, 1, NOW).ok).toBe(true); // exactly reaching it is fine
  });

  it("REFUSES a charge after expiry", () => {
    const s = session();
    expect(chargeSession(s, 1, new Date("2026-10-04T00:00:00Z")))
      .toEqual({ ok: false, reason: "SESSION_EXPIRED" });
  });

  it("a closed session accepts nothing", () => {
    const closed = closeSession(session(), NOW);
    expect(closed.status).toBe("CLOSED");
    expect(chargeSession(closed, 1, NOW)).toEqual({ ok: false, reason: "SESSION_NOT_OPEN" });
  });

  it("a charge returns a REFERENCE, never a transfer", () => {
    const r = chargeSession(session(), 1, NOW);
    expect(r.ok && r.value.paymentRef).toMatch(/^pay:s1:1$/);
    expect(r.ok && r.value.evidenceLevel).toBe("LOCAL_PASS");
  });

  it("an x402 challenge without a reservation is refused", () => {
    expect(x402ChallengeValid({ resource: "r", asset: "USDC", amount: 1, recipient: "0x1" }, NOW))
      .toEqual({ ok: false, reason: "CHALLENGE_REQUIRES_RESERVATION" });
    expect(x402ChallengeValid({ resource: "r", asset: "USDC", amount: 1, recipient: "0x1", reservationId: "res_1" }, NOW))
      .toEqual({ ok: true, value: true });
  });
});

describe("Tempo payment metadata and receipt mapping (PRD Phase 9)", () => {
  it("metadata requires a mint address and a network", () => {
    expect(tempoPaymentMetadata("moderato", "nothex", "USDC").ok).toBe(false);
    expect(tempoPaymentMetadata("", "0xabc", "USDC").ok).toBe(false);
  });

  it("REFUSES to map a receipt while decimals are UNRESOLVED", () => {
    // Converting without a scale is off by a power of ten. A receipt whose
    // amountAtomic is wrong by 10^6 is worse than one never produced.
    const m = tempoPaymentMetadata("moderato", "0xabc", "USDC");
    if (!m.ok) throw new Error("fixture");
    const r = tempoReceiptMapping(m.value, { receiptId: "rc", settlementId: "st", amount: 12 });
    expect(r).toEqual({ ok: false, reason: "RECEIPT_MAPPING_REQUIRES_RESOLVED_DECIMALS" });
  });

  it("maps correctly once decimals are resolved", () => {
    const m = tempoPaymentMetadata("moderato", "0xabc", "USDC");
    if (!m.ok) throw new Error("fixture");
    const r = tempoReceiptMapping(withDecimals(m.value, 6), { receiptId: "rc", settlementId: "st", amount: 12 });
    expect(r.ok && r.value.amountAtomic).toBe("12000000");
  });

  it("refuses nonsense decimals", () => {
    const m = tempoPaymentMetadata("moderato", "0xabc", "USDC");
    if (!m.ok) throw new Error("fixture");
    for (const d of [-2, 1.5, 40]) {
      expect(() => withDecimals(m.value, d), String(d)).toThrow();
    }
  });
});

describe("ERC-4337 — envelope only, and it says so", () => {
  const op: UserOperation = {
    sender: "0x5555555555555555555555555555555555555555",
    callData: "0xdeadbeef", signatureDeadline: 0n, nonce: 1n,
    paymasterAndData: "0x",
    accountGasLimits: { verificationGasLimit: 100000n, callGasLimit: 100000n },
  };

  it("validates a well-formed operation", () => {
    expect(validateUserOperation(op, ENTRY_POINT_V07, 0n)).toEqual({ ok: true, mode: "contract" });
  });

  it("REFUSES an unsupported entry point", () => {
    expect(validateUserOperation(op, "0x1111111111111111111111111111111111111111", 0n))
      .toEqual({ ok: false, reason: "UNSUPPORTED_ENTRY_POINT" });
  });

  it("REFUSES an expired signature deadline", () => {
    // A bundler will relay an expired op; it is still a validly-shaped replay.
    const stale = { ...op, signatureDeadline: 100n };
    expect(validateUserOperation(stale, ENTRY_POINT_V07, 200n))
      .toEqual({ ok: false, reason: "SIGNATURE_DEADLINE_PASSED" });
    expect(validateUserOperation(stale, ENTRY_POINT_V07, 50n).ok).toBe(true);
  });

  it("REFUSES an empty call and zero gas", () => {
    expect(validateUserOperation({ ...op, callData: "0x" }, ENTRY_POINT_V07, 0n))
      .toEqual({ ok: false, reason: "EMPTY_CALL_DATA" });
    expect(validateUserOperation({ ...op, accountGasLimits: { verificationGasLimit: 1n, callGasLimit: 0n } }, ENTRY_POINT_V07, 0n))
      .toEqual({ ok: false, reason: "ZERO_CALL_GAS_LIMIT" });
  });

  it("the hash changes with every field a bundler would act on", () => {
    const a = packUserOperation(op);
    const base = userOperationHash(a);
    expect(userOperationHash({ ...a, nonce: 2n })).not.toBe(base);
    expect(userOperationHash({ ...a, callData: "0xfeed" })).not.toBe(base);
    expect(userOperationHash({ ...a, sender: "0x6666666666666666666666666666666666666666" })).not.toBe(base);
    expect(userOperationHash(a)).toBe(base);
  });

  it("batches are grouped BY SENDER, which is what a bundler requires", () => {
    // A mixed-sender batch is rejected by the EntryPoint. Flattening it would
    // build something that cannot happen on chain.
    const other: UserOperation = { ...op, sender: "0x7777777777777777777777777777777777777777", nonce: 9n };
    const b = batchForBundler([op, other, { ...op, nonce: 2n }]);
    expect(b.size).toBe(2);
    const aKey = "0x5555555555555555555555555555555555555555";
    expect(b.get(aKey)).toHaveLength(2);
  });
});
