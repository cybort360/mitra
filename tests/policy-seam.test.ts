/**
 * F48 — the policy seam existed and was bypassed.
 *
 * `PolicyEvaluator`, `evaluateWithFallback`, `bind` and `EnclaveUnavailableError` were
 * all written, exported and tested. `app/api/v1/authorizations/route.ts` imported
 * `evaluateProposal` **directly** and never touched them.
 *
 * PRD §11.11 requires a confidential mandate to fail closed when the enclave is
 * unavailable, and forbids any component silently downgrading it to public evaluation.
 * Nothing on the only route that issues authorizations consulted
 * `mandate.confidentialPolicy` — `mandate_research_v7` sets it `true`, and before this
 * change it would have been evaluated publicly and issued a normal `Authorization`
 * stamped `policy-engine:local`.
 *
 * These drive the REAL route handler, not the evaluator in isolation, because the
 * defect was precisely that the route did not call the thing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { POST as authorize } from "@/app/api/v1/authorizations/route";
import { __resetLedgerForTests } from "@/lib/store/ledger";
import { getStore } from "@/lib/store/provider";
import { json, prepareStore, req } from "./fixtures";

// mandate_yield_v2 belongs to vault_base_ops. Pairing it with vault_sol_primary
// returned 409 VAULT_NOT_FOUND, which reads exactly like a policy refusal.
const PUBLIC_MANDATE = "mandate_yield_v2";
const CONFIDENTIAL_MANDATE = "mandate_research_v7";
const VAULT_FOR = "vault_base_ops";

// Terms the PUBLIC mandate actually admits. The first version used
// `market_research` / `virtuals:*` / `solana`, which are mandate_research_v7's
// terms — yield_v2 admits `yield_route_evaluation` / `erc8183:provider:*` / `base`.
// The mismatch returned 403 POLICY_DENIED, which is a correct refusal and an
// entirely wrong test.
const base = {
  runId: "run_1", intentId: "intent_1",
  vaultId: VAULT_FOR,
  amount: 10, asset: "USDC", chain: "base",
  counterparty: "erc8183:provider:1", capability: "yield_route_evaluation",
};

/** The confidential mandate's own admitted terms. */
const confidentialBase = {
  ...base,
  vaultId: "vault_sol_primary",
  chain: "solana",
  counterparty: "virtuals:approved:1",
  capability: "market_research",
};

describe("F48 — the authorization route goes through the PolicyEvaluator seam", () => {
  beforeEach(async () => {
    await prepareStore();
    __resetLedgerForTests();
  });

  it("a PUBLIC mandate is evaluated and issues an authorization", async () => {
    // Mandates are read through the REPOSITORY, not the ledger: `CapitalLedger.vaults`
    // is private and it has no `mandates` map at all. Reaching into the ledger for
    // them is what produced "Cannot read properties of undefined" in the first run.
    const { repo } = await getStore();
    const mandate = await repo.getMandate(PUBLIC_MANDATE);
    if (!mandate) throw new Error("fixture mandate missing");

    const res = await authorize(req({ ...base, mandateId: mandate.mandateId }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.evaluator).toBe("public");
    expect(body.data.signer).toBe("policy-engine:public");
  });

  it("a CONFIDENTIAL mandate FAILS CLOSED when no enclave is registered", async () => {
    // THE regression test. Before F48 this returned 201 with a public decision.
    const { repo } = await getStore();
    const confidential = await repo.getMandate("mandate_research_v7");
    expect(confidential?.confidentialPolicy, "the seed must contain a confidential mandate for this test to mean anything").toBe(true);

    // mandate_research_v7 lives in vault_sol_primary, not vault_base_ops.
    const res = await authorize(req({ ...confidentialBase, mandateId: CONFIDENTIAL_MANDATE }));
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error).toBe("CONFIDENTIAL_ENCLAVE_UNAVAILABLE");
    expect(body.mandateId).toBe("mandate_research_v7");
  });

  it("failing closed issues NO authorization at all", async () => {
    const { repo } = await getStore();
    // There is no `listAuthorizations` on the repository — only `recordAuthorization`.
    // The first version called it and failed with "is not a function", which says
    // nothing about whether a refusal issues anything.
    const { getLedger } = await import("@/lib/store/ledger");
    const before = getLedger().listAuthorizations().length;
    await authorize(req({ ...confidentialBase, mandateId: CONFIDENTIAL_MANDATE }));
    expect(getLedger().listAuthorizations().length, "a refused request must issue nothing").toBe(before);
  });

  it("the response carries all six PRD §11 binding fields", async () => {
    const { repo } = await getStore();
    const mandate = await repo.getMandate(PUBLIC_MANDATE);
    if (!mandate) throw new Error("fixture mandate missing");
    const res = await authorize(req({ ...base, mandateId: mandate.mandateId }));
    const body = await json(res);
    for (const f of ["policyVersion", "actionDigest", "vaultId", "mandateId", "decisionExpiresAt", "executionGuardToken"]) {
      expect(body.binding, `missing binding field ${f}`).toHaveProperty(f);
    }
    expect(body.binding.executionGuardToken).toBe(`guard:${body.data.actionDigest}`);
  });

  it("a DENY still refuses, and the reason codes survive", async () => {
    const { repo } = await getStore();
    const mandate = await repo.getMandate(PUBLIC_MANDATE);
    if (!mandate) throw new Error("fixture mandate missing");
    // Over the mandate's maxTransaction.
    const res = await authorize(req({ ...base, mandateId: PUBLIC_MANDATE, amount: mandate.maxTransaction + 1 }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.data.decision).toBe("DENY");
    expect(Array.isArray(body.data.reasonCodes)).toBe(true);
  });
});
