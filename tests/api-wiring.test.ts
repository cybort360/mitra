import { beforeEach, describe, expect, it } from "vitest";
import { POST as authorize } from "@/app/api/v1/authorizations/route";
import { POST as createReservation, GET as listReservations } from "@/app/api/v1/reservations/route";
import { __resetLedgerForTests } from "@/lib/store/ledger";

import { NOW, goodProposal, json, req } from "./fixtures";

beforeEach(() => { __resetLedgerForTests(); });

describe("POST /api/v1/authorizations", () => {
  it("returns ALLOW with a digest for a well-formed proposal", async () => {
    const res = await authorize(req(goodProposal));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.decision).toBe("ALLOW");
    expect(body.data.actionDigest).toMatch(/^sha256:/);
  });

  it("returns DENY with reason codes when the counterparty is not allowed", async () => {
    const res = await authorize(req({ ...goodProposal, counterparty: "evil:provider" }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.data.decision).toBe("DENY");
    expect(body.data.reasonCodes).toContain("COUNTERPARTY_NOT_ALLOWED");
  });

  it("rejects a negative amount at the schema boundary", async () => {
    // The schema refuses it before policy sees it, so INVALID_AMOUNT is never
    // reached over HTTP. The kernel still guards it; the boundary guards it first.
    const res = await authorize(req({ ...goodProposal, amount: -100 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive amount at the schema boundary", async () => {
    const res = await authorize(req({ ...goodProposal, amount: 0 }));
    expect(res.status).toBe(400);
  });

  it("denies once the mandate has expired", async () => {
    const res = await authorize(req({ ...goodProposal, now: "2026-10-03T00:00:00.000Z" }));
    expect((await json(res)).data.reasonCodes).toContain("MANDATE_EXPIRED");
  });

  it("404s an unknown mandate", async () => {
    const res = await authorize(req({ ...goodProposal, mandateId: "mandate_nope" }));
    expect(res.status).toBe(404);
  });

  it("refuses a vault the mandate does not cover", async () => {
    const res = await authorize(req({ ...goodProposal, vaultId: "vault_tempo_settle" }));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("MANDATE_VAULT_MISMATCH");
  });

  it("denies a capability outside the mandate", async () => {
    const res = await authorize(req({ ...goodProposal, capability: "arbitrary_transfer" }));
    expect((await json(res)).data.reasonCodes).toContain("CAPABILITY_NOT_ALLOWED");
  });

  it("states that ALLOW is not permission to move value", async () => {
    const body = await json(await authorize(req(goodProposal)));
    expect(body.note).toMatch(/not permission/i);
  });
});

describe("POST /api/v1/reservations", () => {
  const listUrl = new Request("http://localhost/api/v1/reservations");

  it("reserves capital after an ALLOW", async () => {
    const before = await json(await listReservations(listUrl));
    const res = await createReservation(req({ ...goodProposal, ttlMinutes: 30 }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.status).toBe("RESERVED");
    const after = await json(await listReservations(listUrl));
    expect(after.count).toBe(before.count + 1);
  });

  it("reserves nothing when policy denies", async () => {
    const before = (await json(await listReservations(listUrl))).count;
    const res = await createReservation(req({ ...goodProposal, counterparty: "evil:provider" }));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("POLICY_DENIED");
    // A DENY must not leave a partial reservation behind.
    expect((await json(await listReservations(listUrl))).count).toBe(before);
  });

  it("moves capital out of available and into reserved", async () => {
    const res = await createReservation(req(goodProposal));
    const { vault, data } = await json(res);
    expect(vault.reserved).toBeGreaterThan(0);
    expect(data.amount).toBeGreaterThan(0);
    expect(vault.reserved).toBeGreaterThanOrEqual(data.amount);
  });

  it("rejects a negative amount at the schema boundary", async () => {
    const res = await createReservation(req({ ...goodProposal, amount: -5 }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown vault", async () => {
    const res = await createReservation(req({ ...goodProposal, vaultId: "vault_nope" }));
    expect(res.status).toBe(404);
  });
});
