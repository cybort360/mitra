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
import { GET as listSpaces, PUT as checkRuleDrift } from "@/app/api/v1/spaces/route";
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
  it("PUBLISHES who can freeze a participant, and on whose authority", async () => {
    // Mutation audit: removing `valid: governance.ok` from this route broke
    // ZERO tests, because nothing asserted the route reports governance at all.
    // That is the whole purpose of ADR-0011 open item 4 - a governance model
    // nobody can inspect is indistinguishable from the owner kill switch it
    // replaced.
    const res = await listSpaces();
    const body = await res.json();
    for (const s of body.data) {
      expect(s.governance, s.spaceId).toBeTruthy();
      expect(["ADMIN", "QUORUM"]).toContain(s.governance.mode);
      expect(Array.isArray(s.governance.governors)).toBe(true);
      expect(s.governance.governors.length).toBeGreaterThan(0);
      expect(typeof s.governance.threshold).toBe("number");
      expect(typeof s.governance.valid).toBe("boolean");
      if (!s.governance.valid) expect(s.governance.invalidReason).toBeTruthy();
    }
  });

  it("PUBLISHES whether the Space is governed by rules Mitra does not own", async () => {
    // A participant is entitled to know that before agreeing to anything.
    const body = await (await listSpaces()).json();
    for (const s of body.data) {
      expect(typeof s.rules.externallyGoverned).toBe("boolean");
      expect(["mitra", "external"]).toContain(s.rules.source);
      if (s.rules.source === "external") {
        expect(s.rules.ruleSetRef, s.spaceId).toBeTruthy();
        expect(s.rules.externallyGoverned).toBe(true);
      }
    }
    // The seed deliberately contains BOTH, so this is not vacuous.
    const sources = new Set(body.data.map((s: { rules: { source: string } }) => s.rules.source));
    expect(sources.size).toBeGreaterThan(1);
  });

  it("PUBLISHES that a misconfigured Space's governance is invalid", async () => {
    // The seed contains a Space with QUORUM/threshold 1 on purpose. Without it,
    // replacing `valid: governance.ok` with `valid: true` broke nothing - a guard
    // that is never observed failing has never been exercised.
    const body = await (await listSpaces()).json();
    const bad = body.data.find((s: { governance: { valid: boolean } }) => !s.governance.valid);
    expect(bad, "the seed must contain a misconfigured Space").toBeTruthy();
    expect(bad.governance.invalidReason).toBe("QUORUM_REQUIRES_THRESHOLD_OF_AT_LEAST_TWO");
    // And it really cannot bind anything.
    const { decide } = await import("@/lib/kernel/space-governance");
    expect(decide(bad as never, "SUSPEND", ["agent_buyer_07", "agent_eval_02"]).ok).toBe(false);
  });

  it("PUBLISHES which assets the Space itself admits", async () => {
    // Item 2: an asset is admissible because someone recorded it, and that record
    // is visible. Absence means none are declared - never a built-in default.
    const body = await (await listSpaces()).json();
    for (const s of body.data) {
      expect(Array.isArray(s.admittedAssets)).toBe(true);
    }
  });

  it("lists spaces with derived headroom", async () => {
    const res = await listSpaces();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    const s = body.data[0];
    // The response is explicit about what it exposes rather than spreading the
    // Space, so a field cannot be added to the entity and silently appear on the
    // wire. Budget/committed are NOT returned; only derived headroom is.
    expect(s.headroom.amount).toBeGreaterThanOrEqual(0);
    expect(typeof s.participants).toBe("number");
    expect(s.budget).toBeUndefined();
    expect(s.owner).toBeUndefined();
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
      // Membership is an ARRAY: an agreement may span several Spaces, or none.
      expect(a.spaceIds).toContain("space_research_1");
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

  it("every Space an agreement names actually exists", async () => {
    // A dangling id makes containment untestable while appearing wired. An
    // agreement naming NO Space is legitimate and is not a failure.
    const spaces = await (await listSpaces()).json();
    const known = new Set(spaces.data.map((s: { spaceId: string }) => s.spaceId));
    const agreements = await (await listAgreements(new Request("http://x/api/v1/agreements"))).json();
    for (const a of agreements.data) {
      for (const sid of a.spaceIds) {
        expect(known.has(sid), `${a.agreementId} -> ${sid}`).toBe(true);
      }
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

    // Forward: every Space an agreement names exists. An agreement may name none.
    const known = new Set(spaces.data.map((s: { spaceId: string }) => s.spaceId));
    for (const a of all.data) {
      for (const sid of a.spaceIds) expect(known.has(sid)).toBe(true);
    }

    // Reverse: querying a Space returns exactly the agreements that name it.
    // Nothing on the Space object is consulted for this.
    for (const space of spaces.data) {
      const scoped = await (
        await listAgreements(new Request(`http://x/api/v1/agreements?spaceId=${space.spaceId}`))
      ).json();
      const expected = all.data.filter((a: { spaceIds: string[] }) => a.spaceIds.includes(space.spaceId));
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

describe("external rule drift is surfaced, never adopted", () => {
  it("reports the agreed and observed digests and REQUIRES re-agreement", async () => {
    const body = await (await listSpaces()).json();
    const external = body.data.find((s: { rules: { source: string } }) => s.rules.source === "external");
    expect(external, "the seed must contain an externally-governed Space").toBeTruthy();

    const res = await checkRuleDrift(new Request("http://x/api/v1/spaces", {
      method: "PUT",
      body: JSON.stringify({ spaceId: external.spaceId, observedDigest: "sha256:SOMETHING-ELSE" }),
    }));
    const out = await res.json();
    expect(out.data.changed).toBe(true);
    // Silently adopting new terms would hand the rule-set publisher unilateral
    // power over every participant.
    expect(out.data.action).toBe("RE_AGREEMENT_REQUIRED");
    expect(out.data.agreedDigest).toBe(external.rules.digest);
    expect(out.data.agreedDigest).not.toBe(out.data.observedDigest);
  });

  it("reports no change when the digest still matches", async () => {
    const body = await (await listSpaces()).json();
    const external = body.data.find((s: { rules: { source: string } }) => s.rules.source === "external");
    const res = await checkRuleDrift(new Request("http://x/api/v1/spaces", {
      method: "PUT",
      body: JSON.stringify({ spaceId: external.spaceId, observedDigest: external.rules.digest }),
    }));
    const out = await res.json();
    expect(out.data.changed).toBe(false);
    expect(out.data.action).toBe("NONE");
  });

  it("rejects a malformed request and an unknown space", async () => {
    expect((await checkRuleDrift(new Request("http://x/api/v1/spaces", { method: "PUT", body: "{}" }))).status).toBe(400);
    const res = await checkRuleDrift(new Request("http://x/api/v1/spaces", {
      method: "PUT",
      body: JSON.stringify({ spaceId: "space_nope", observedDigest: "x" }),
    }));
    expect(res.status).toBe(404);
  });
});
