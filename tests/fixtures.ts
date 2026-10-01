import type { Reservation } from "@/lib/domain/types";

/** Shared fixtures for the API wiring tests. Before mandate expiry, inside the window. */
export const NOW = "2026-10-01T12:00:00.000Z";

export const goodProposal = {
  mandateId: "mandate_research_v7",
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
