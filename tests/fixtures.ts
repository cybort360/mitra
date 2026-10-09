import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Chain, Reservation } from "@/lib/domain/types";
import { mitraRequestTypedData, requestBodyHash } from "@/lib/identity/signed-request";
import { __resetLedgerForTests } from "@/lib/store/ledger";
import { __resetStoreForTests } from "@/lib/store/provider";

/** Shared fixtures for the API wiring tests. Before mandate expiry, inside the window. */
import type { EvmEscrowRail, EscrowRail } from "@/lib/commerce/onchain-escrow";
import { normalizeJobRow } from "@/lib/adapters/erc8183-transport";

export const NOW = "2026-10-01T12:00:00.000Z";

export const goodProposal = {
  // F48: the PUBLIC twin. This fixture previously named the confidential
  // `mandate_research_v7`, so every authorization test asserted a public decision
  // against a confidential mandate — the suite encoded the defect it should have caught.
  mandateId: "mandate_research_public_v7",
  vaultId: "vault_sol_primary",
  amount: 5, asset: "USDC", chain: "solana",
  counterparty: "virtuals:research-agent-18",
  capability: "market_research",
  intentId: "intent_t1", runId: "run_t1",
  now: NOW,
};

export const json = (res: Response) => res.json();
export const req = (body: unknown) =>
  new Request("http://localhost/api/v1/x", { method: "POST", body: JSON.stringify(body) });

/**
 * Prepare whichever store the routes will actually use.
 *
 * The API suites drive real route handlers, so their outcome depends on the
 * backend: with no `DATABASE_URL` the routes are served by the in-memory ledger,
 * which is seeded at construction; with one set they are served by Postgres,
 * which starts empty and therefore 404s on every request.
 *
 * Previously each suite called `__resetLedgerForTests()` alone, which reset the
 * ledger but left the provider holding a reference to the discarded instance —
 * so state leaked between tests, and the Postgres path had no fixtures at all.
 * One helper, used by every suite that drives a route, removes both problems.
 */
/**
 * Give a seeded agent a wallet whose key the test holds, so the test can sign as
 * that agent (F55). Test setup only: no route can attach a wallet to an existing
 * agent, and the seed carries no known keys.
 */
export async function bindTestWallet(agentId: string, address: `0x${string}`, chain: Chain = "base"): Promise<void> {
  const { getStore, __putAgentForTests } = await import("@/lib/store/provider");
  const { repo, backend } = await getStore();
  const agent = await repo.getAgent(agentId);
  if (!agent) throw new Error(`bindTestWallet: no agent ${agentId}`);
  const bound = { ...agent, wallets: [...agent.wallets, { chain, address }] };
  // Follow the store the routes use: some suites install their own memory repo
  // even when DATABASE_URL is set.
  if (backend === "memory") {
    await __putAgentForTests(bound);
    return;
  }
  const { createPool } = await import("@/lib/store/db");
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await pool.query("UPDATE mitra.agents SET document = $2::jsonb WHERE agent_id = $1", [agentId, JSON.stringify(bound)]);
  } finally {
    await pool.end();
  }
}

/**
 * Test-only signing keys for seeded agents (F55). Bound by `bindTestParties`
 * at test setup; the seed itself carries no known keys.
 */
export const TEST_PARTIES = {
  agent_buyer_07: privateKeyToAccount(`0x${"a1".repeat(32)}`),
  agent_data_03: privateKeyToAccount(`0x${"b2".repeat(32)}`),
  agent_eval_02: privateKeyToAccount(`0x${"c3".repeat(32)}`),
} as const;
export type TestParty = keyof typeof TEST_PARTIES;

export async function bindTestParties(): Promise<void> {
  for (const [agentId, account] of Object.entries(TEST_PARTIES)) await bindTestWallet(agentId, account.address);
}

/**
 * A transition body as a real client sends it: signed by `account` acting as
 * `actor`, against the agreement's current `fromStatus`.
 */
export async function signAs(
  account: PrivateKeyAccount,
  actor: string,
  fromStatus: string,
  body: { op: string; agreementId: string } & Record<string, unknown>,
) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const request = { op: body.op, agreementId: body.agreementId, fromStatus, actor, bodyHash: requestBodyHash(body), expiresAt };
  const signature = await account.signTypedData(mitraRequestTypedData(request, 84532));
  return { ...body, auth: { actor, signer: account.address, chainId: 84532, signature, expiresAt } };
}

/** `signAs` with the party's own test key. */
export const signedTransition = (
  actor: TestParty,
  fromStatus: string,
  body: { op: string; agreementId: string } & Record<string, unknown>,
) => signAs(TEST_PARTIES[actor], actor, fromStatus, body);

export async function prepareStore(): Promise<void> {
  __resetLedgerForTests();
  __resetStoreForTests();
  if (!process.env.DATABASE_URL) return;
  const { createPool } = await import("@/lib/store/db");
  const { MIGRATIONS } = await import("@/lib/store/schema");
  const { PostgresRepository } = await import("@/lib/store/postgres");
  const pool = createPool(process.env.DATABASE_URL);
  try {
    for (const sql of MIGRATIONS) await pool.query(sql);
    const repo = new PostgresRepository(pool);
    // Truncate first: a previous suite's reservations would otherwise make the
    // velocity window non-empty and deny proposals these tests expect to pass.
    //
    // The commerce tables are truncated too. They were not, so sagas from earlier
    // suites leaked into tests/sagas-api.test.ts ("expected 8 to be 0" on Postgres),
    // and once agreement writes actually persisted (sprint item 1), an agreement
    // opened by one run collided with the same id on the next.
    await pool.query(`TRUNCATE mitra.reservations, mitra.consumed_nonces, mitra.authorizations, mitra.event_log,
      mitra.mandates, mitra.vaults, mitra.sagas, mitra.settlements, mitra.agreement_spaces, mitra.agreements,
      mitra.spaces, mitra.receipts, mitra.clearing_epochs, mitra.agents RESTART IDENTITY CASCADE`);
    await repo.seedReferenceData();
  } finally {
    await pool.end();
  }
}

/**
 * A recording fake EVM escrow rail.
 *
 * LP-6's guarantees are mostly about what did NOT happen — a replay must not broadcast, a
 * mismatch must not overwrite — so a fake that cannot show an absence cannot test them.
 * Every call is appended to `calls`, and `job` is the chain's answer to `getJob`.
 */
export function fakeEvmEscrowRail(over: {
  job?: Awaited<ReturnType<EvmEscrowRail["getJob"]>>;  // a JobRow, or undefined for "never funded"
  txPrefix?: string;
} = {}) {
  const calls: string[] = [];
  let job = over.job;
  const rail = {
    calls,
    address: "0x00000000000000000000000000000000000000ea" as const,
    async depositToEscrow() { calls.push("depositToEscrow"); job = over.job; return `0x${over.txPrefix ?? "ab".repeat(32)}`; },
    async completeJob() { calls.push("completeJob"); return `0x${over.txPrefix ?? "cd".repeat(32)}`; },
    async refundJob() { calls.push("refundJob"); return `0x${over.txPrefix ?? "ef".repeat(32)}`; },
    // Resolves to `undefined` to mean "never funded". `normalizeJobRow` is applied so
    // the fake answers with the SAME named shape the real transport now does — the F82
    // lesson, encoded in the fixture so a future shape change breaks here too.
    async getJob() { calls.push("getJob"); return job === undefined ? undefined : normalizeJobRow(job); },
  } satisfies EvmEscrowRail & { calls: string[] };
  return Object.assign(rail, {
    setJob(j: typeof job) { job = j; },
    /** Counts how many times a mutating call was made — the idempotency assertion. */
    count(call: string) { return calls.filter((c) => c === call).length; },
  });
}

/** The rail object shape `resolveEscrowRail` must return. */
export const asEvmRail = (evm: EvmEscrowRail) =>
  ({ chain: "evm", network: "baseSepolia", evm }) satisfies EscrowRail;
