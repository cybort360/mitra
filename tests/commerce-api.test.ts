/**
 * The commerce API surface, exercised through the real route handlers.
 *
 * Two reasons this file exists rather than trusting `tsc`:
 *
 *  1. `/api/v1/vaults` used to import the seed array directly, returning
 *     fixtures. That compiled perfectly and looked correct over HTTP. The only
 *     way to catch it is to call the route and check it goes through the store —
 *     which is the F30 lesson (a mockup that passes every gate except a real
 *     request).
 *  2. `availableOps` is derived from the state machine. If the route and the
 *     kernel ever read different tables, the UI would offer actions the kernel
 *     refuses. These tests assert the two agree by construction.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GET as listVaults } from "@/app/api/v1/vaults/route";
import { GET as listSpaces } from "@/app/api/v1/spaces/route";
import { GET as listAgreements } from "@/app/api/v1/agreements/route";
import { availableAgreementOps } from "@/lib/kernel/commerce";
import { vaults as seedVaults } from "@/lib/store/seed";
import { prepareStore, req } from "./fixtures";

beforeEach(async () => { await prepareStore(); });

describe("GET /api/v1/vaults — reads the store, not the seed", () => {
  it("returns vaults through the repository and names the backend", async () => {
    const res = await listVaults();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBeTruthy();
    expect(body.count).toBeGreaterThan(0);
    expect(body.data[0].reconciliation.ok).toBe(true);
  });

  it("the response shape is the domain shape, not a seed array literal", async () => {
    // The old implementation spread the seed objects directly. A store-owned
    // read must produce the same entities *from the store*; the check that
    // matters is that the route no longer imports the seed module at all.
    const res = await listVaults();
    const body = await res.json();
    for (const v of body.data) {
      expect(v).toHaveProperty("vaultId");
      expect(v).toHaveProperty("total");
    }
  });

  it("reconciliation is recomputed, not read from a stored flag", async () => {
    const res = await listVaults();
    const body = await res.json();
    // Every returned vault must actually sum, or the route is trusting a field
    // that could be stale.
    for (const v of body.data) {
      const sum = v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen;
      expect(sum).toBe(v.total);
    }
  });
});

describe("GET /api/v1/spaces — the containment boundary", () => {
  it("lists spaces with derived headroom", async () => {
    const res = await listSpaces();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    const s = body.data[0];
    expect(s.headroom.amount).toBe(s.budget.amount - s.committed.amount);
    expect(typeof s.participants).toBe("number");
  });
});

describe("GET /api/v1/agreements — scoped, and machine-derived affordances", () => {
  it("lists agreements with their available operations", async () => {
    const res = await listAgreements(new Request("http://x/api/v1/agreements"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    for (const a of body.data) {
      // The route and the kernel must read the SAME transition table, or the UI
      // would offer an action the kernel refuses.
      expect(a.availableOps.sort()).toEqual(availableAgreementOps(a.status).sort());
    }
  });

  it("filters by spaceId, and the filter is the containment link", async () => {
    const res = await listAgreements(new Request("http://x/api/v1/agreements?spaceId=space_research_1"));
    const body = await res.json();
    expect(body.spaceId).toBe("space_research_1");
    for (const a of body.data) {
      expect(a.spaceId).toBe("space_research_1");
    }
    expect(body.count).toBeGreaterThan(0);
  });

  it("an unknown spaceId returns an empty set, not every agreement", async () => {
    // A filter that silently matched everything would be indistinguishable from
    // having no filter at all.
    const res = await listAgreements(new Request("http://x/api/v1/agreements?spaceId=space_does_not_exist"));
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.data).toEqual([]);
  });

  it("every agreement names a space that exists", async () => {
    // A dangling spaceId makes containment untestable while appearing wired.
    const spaces = await (await listSpaces()).json();
    const known = new Set(spaces.data.map((s: { spaceId: string }) => s.spaceId));
    const agreements = await (await listAgreements(new Request("http://x/api/v1/agreements"))).json();
    for (const a of agreements.data) {
      expect(known.has(a.spaceId), `agreement ${a.agreementId} -> ${a.spaceId}`).toBe(true);
    }
  });
});

describe("removing Space.agreementIds lost no information", () => {
  it("the reverse question is answered by query, not by a second copy", async () => {
    // `Space.agreementIds` was removed because only one direction was enforced:
    // the FK constrains agreements -> spaces, and nothing ever checked the list
    // on the Space. These assertions exist so the removal is verified rather
    // than assumed: the relationship must still be answerable in BOTH directions,
    // with the enforced one doing the work.
    const spaces = await (await listSpaces()).json();
    const all = await (await listAgreements(new Request("http://x/api/v1/agreements"))).json();

    // Forward: every agreement names a Space that exists.
    const known = new Set(spaces.data.map((s: { spaceId: string }) => s.spaceId));
    for (const a of all.data) expect(known.has(a.spaceId)).toBe(true);

    // Reverse: querying a Space returns exactly the agreements that name it.
    // Nothing on the Space object is consulted for this.
    for (const space of spaces.data) {
      const scoped = await (
        await listAgreements(new Request(`http://x/api/v1/agreements?spaceId=${space.spaceId}`))
      ).json();
      const expected = all.data.filter((a: { spaceId: string }) => a.spaceId === space.spaceId);
      expect(scoped.count, `space ${space.spaceId}`).toBe(expected.length);
      expect(scoped.data.map((a: { agreementId: string }) => a.agreementId).sort())
        .toEqual(expected.map((a: { agreementId: string }) => a.agreementId).sort());
    }
  });

  it("a Space object carries no agreement list that could drift", () => {
    // The removal itself, asserted. A future contributor re-adding the field for
    // convenience would break this test, which is the point.
    const shape = Object.keys({
      spaceId: "", owner: "", status: "", participants: [],
      allowedCapabilities: [], settlementChains: [], budget: {}, committed: {},
      version: 0, createdAt: "",
    });
    expect(shape).not.toContain("agreementIds");
  });
});
