import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards against building from half the governing specification (F22).
 *
 * `AGENTS.md` names two documents:
 *
 * > The full specification is `docs/product/MITRA_PRD.md` (normative) and
 * > `docs/product/MITRA_0_1_FULL_PRODUCT_SPEC.md`.
 *
 * Ten days of work went into this repository reading only the first. The defining
 * sentence of the product — *"Payments let machines move money..."* — appears in
 * the spec and **nowhere in the PRD**, so nothing in the build could have
 * reminded me it was missing. That is the specific failure: not a disagreement
 * between documents, but a document that was never opened.
 *
 * These assertions cannot stop a reader from skipping a file. What they do is
 * make the spec's *content* a checked artifact, so anyone who greps for the
 * product definition finds it asserted here rather than concluding the PRD is the
 * whole of it.
 */
const SPEC = readFileSync(
  path.join(process.cwd(), "docs/product/MITRA_0_1_FULL_PRODUCT_SPEC.md"), "utf8",
);
const PRD = readFileSync(
  path.join(process.cwd(), "docs/product/MITRA_PRD.md"), "utf8",
);

describe("specification parity (F22)", () => {
  it("the spec states the product thesis, and the PRD does not", () => {
    // Asserted *because* it appears only in the spec. If a future edit adds it to
    // the PRD, this fails and asks whether the two documents now disagree or
    // merely restate — the question that would need answering anyway.
    expect(SPEC).toMatch(
      /Payments let machines move money\. Mitra gives autonomous economic actors the financial coordination layer/,
    );
    expect(PRD).not.toMatch(/Payments let machines move money/);
  });

  it("both documents name one product category", () => {
    // The wordings differ — "autonomous" in the spec, "agentic" in the PRD — but
    // they name the same category. Pinned so a rewrite of either is deliberate.
    expect(SPEC).toContain("Financial coordination infrastructure for autonomous commerce");
    expect(PRD).toContain("Financial coordination infrastructure for agentic commerce");
  });

  it("the spec names the four primitives", () => {
    // §1.1. They form a *lifecycle* — Authority → Commerce → Clearing → Recovery
    // — which is why a phase cannot be assessed as an independent item.
    for (const primitive of ["Authority:", "Commerce:", "Clearing:", "Recovery:"]) {
      expect(SPEC).toMatch(new RegExp(`\\*\\*${primitive}`));
    }
  });

  it("the spec's exclusions are the product's positioning", () => {
    // §3.2 "What Mitra is not". Building any of these would be a category error,
    // so the list is pinned rather than summarised.
    for (const excluded of [
      "an agent framework", "an LLM", "a payment protocol", "a blockchain",
      "a stablecoin", "a bridge", "a custodial wallet provider",
    ]) {
      expect(SPEC).toContain(excluded);
    }
    // And the marketplace distinction, which is the one most likely to erode.
    expect(SPEC).toMatch(/marketplace-interoperable\*\*, not primarily a marketplace/);
  });

  it("clearing and settlement stay distinct (spec §4.6)", () => {
    // The distinction I had conflated before reading the spec: clearing
    // determines the economic obligation; settlement moves the asset.
    expect(SPEC).toMatch(/Clearing determines the economic obligation/);
    expect(SPEC).toMatch(/Settlement moves the asset/);
  });

  it("the spec forbids the exact overclaims this repo has guarded against", () => {
    // Pinned because these sentences are the evidence ladder's justification. If
    // they are removed, the standard they justify goes with them.
    for (const rule of [
      /A mocked marketplace response must not be described as a live marketplace integration/,
      /A local clearing result must not be described as decentralized clearing/,
      /A testnet settlement must not be described as production settlement/,
      /Mitra must not claim that it invented deferred agent payment/,
    ]) {
      expect(SPEC).toMatch(rule);
    }
  });

  it("AGENTS.md names both documents as the specification", () => {
    const agents = readFileSync(path.join(process.cwd(), "AGENTS.md"), "utf8");
    expect(agents).toMatch(/MITRA_PRD\.md/);
    expect(agents).toMatch(/MITRA_0_1_FULL_PRODUCT_SPEC\.md/);
  });
});
