import { beforeEach, describe, expect, it } from "vitest";
import { POST as createReservation } from "@/app/api/v1/reservations/route";
import { POST as execute } from "@/app/api/v1/reservations/execute/route";
import { __resetLedgerForTests, getLedger } from "@/lib/store/ledger";
import { NOW, goodProposal, json, prepareStore, req } from "./fixtures";

/**
 * The execution guard is the phase's real subject: an ALLOW is not permission,
 * and these tests are what make that demonstrable rather than aspirational.
 */
beforeEach(async () => { await prepareStore(); });

const hold = async () => {
  const created = await createReservation(req({ ...goodProposal, ttlMinutes: 60 }));
  return (await json(created)).data;
};

describe("POST /api/v1/reservations/execute", () => {
  it("executes a matching instruction", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    expect(res.status).toBe(200);
    expect((await json(res)).data.status).toBe("COMMITTED");
  });

  it("refuses an expired reservation", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest,
      now: new Date(new Date(r.expiresAt).getTime() + 1000).toISOString(),
    }));
    expect(res.status).toBe(409);
    expect((await json(res)).reason).toBe("RESERVATION_EXPIRED");
  });

  it("refuses a tampered action digest", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: "sha256:tampered", now: NOW,
    }));
    expect((await json(res)).reason).toBe("ACTION_DIGEST_MISMATCH");
  });

  it("refuses a mismatched chain", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: "base", actionDigest: r.actionDigest, now: NOW,
    }));
    expect((await json(res)).reason).toBe("CHAIN_MISMATCH");
  });

  it("refuses a mismatched asset", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: "USDT",
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    expect((await json(res)).reason).toBe("ASSET_MISMATCH");
  });

  it("refuses an amount larger than the reservation", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount + 1, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    expect((await json(res)).reason).toBe("AMOUNT_EXCEEDS_RESERVATION");
  });

  it("refuses a replayed nonce on the second attempt", async () => {
    const r = await hold();
    const payload = {
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    };
    expect((await execute(req(payload))).status).toBe(200);
    const second = await execute(req(payload));
    expect(second.status).toBe(409);
    expect((await json(second)).reason).toBe("NONCE_ALREADY_CONSUMED");
  });

  it("404s an unknown reservation", async () => {
    const res = await execute(req({
      reservationId: "res_nope", amount: 1, asset: "USDC", chain: "solana", actionDigest: "x", now: NOW,
    }));
    expect(res.status).toBe(404);
  });

  it("ignores a caller-supplied consumed-nonce list", async () => {
    // The nonce set comes from the ledger. If the caller could clear it, the
    // idempotency boundary would be self-asserted.
    const r = await hold();
    const first = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW, consumedNonces: [],
    }));
    expect(first.status).toBe(200);
    const replay = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW, consumedNonces: [],
    }));
    expect(replay.status).toBe(409);
  });

  it("labels the result as a local simulation with no value movement", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    const body = await json(res);
    expect(body.evidenceLevel).toBe("LOCAL_PASS");
    expect(body.note).toMatch(/no chain transaction/i);
  });

  it("gives each reservation on a vault a distinct nonce", async () => {
    // Regression: nonces were hardcoded to 1, so after one reservation was
    // spent every later execution on that vault was refused as a replay even
    // though it was a distinct instruction.
    const a = await hold();
    await execute(req({
      reservationId: a.reservationId, amount: a.amount, asset: a.asset,
      chain: a.chain, actionDigest: a.actionDigest, now: NOW,
    }));
    const b = await hold();
    expect(b.nonce).not.toBe(a.nonce);
    // And the second, independent instruction must still be executable.
    const res = await execute(req({
      reservationId: b.reservationId, amount: b.amount, asset: b.asset,
      chain: b.chain, actionDigest: b.actionDigest, now: NOW,
    }));
    expect(res.status).toBe(200);
  });

  it("reports the digest mismatch rather than masking it as a replay", async () => {
    // Guards the ordering of checks: a tampered digest must surface as such,
    // not be shadowed by a nonce collision from an earlier execution.
    const a = await hold();
    await execute(req({
      reservationId: a.reservationId, amount: a.amount, asset: a.asset,
      chain: a.chain, actionDigest: a.actionDigest, now: NOW,
    }));
    const b = await hold();
    const res = await execute(req({
      reservationId: b.reservationId, amount: b.amount, asset: b.asset,
      chain: b.chain, actionDigest: "sha256:tampered", now: NOW,
    }));
    expect((await json(res)).reason).toBe("ACTION_DIGEST_MISMATCH");
  });

  it("the ledger refuses a replay independently of the kernel guard", async () => {
    // Defence in depth. The kernel's NONCE_ALREADY_CONSUMED check and the
    // ledger's atomic consumeNonce are separate layers; a mutation test showed
    // that removing only the kernel check leaves this one as the sole
    // protection. This asserts the ledger half directly so neither layer can be
    // removed silently.
    const r = await hold();
    const ledger = getLedger();
    expect(ledger.consumeNonce(r.vaultId, r.nonce)).toBe(true);
    expect(ledger.consumeNonce(r.vaultId, r.nonce)).toBe(false);
  });
});
