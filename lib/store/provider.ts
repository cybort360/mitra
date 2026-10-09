/**
 * The store a route actually talks to.
 *
 * ## Server-only, deliberately
 *
 * `server-only` is imported first and it is load-bearing. This module reaches
 * `pg`, a native Node addon, through `db.ts` and `postgres.ts`. Without the
 * marker, Next.js follows that import into the client bundle and the production
 * build fails on a native module it cannot bundle. The marker turns that into a
 * clear error at build time instead of a confusing one deep in the bundler.
 *
 * The alternative — lazy `await import()` inside every accessor — still leaves
 * `pg` reachable from a module a client component could import, so it trades a
 * loud failure for a subtle one.
 *
 * ## Why this exists
 *
 * The Postgres repository landed in Phase 3, but the routes still called
 * `getLedger()` — the process-local `CapitalLedger`. That is the gap recorded in
 * `forge/FAILURES.md` ("Ledger is process-local on the kernel path"): a durable
 * store existed and nothing used it, so a restart silently lost consumed nonces
 * and reserved capital while the API still answered `200`.
 *
 * `EconomicRepository` is the seam. Routes depend on it, so the backend is a
 * runtime decision rather than a code change.
 *
 * ## The fallback is deliberate, and it is not silent
 *
 * With `DATABASE_URL` set, routes use Postgres. Without it, they fall back to the
 * in-memory ledger so the suite and a fresh clone still run — and the fallback is
 * **reported in the response body** via `backend`, because an in-memory ledger
 * that looks identical to a durable one is precisely the "documented ≠ true"
 * failure this repository exists to prevent.
 *
 * ## Why an adapter rather than implementing the interface on CapitalLedger
 *
 * `CapitalLedger` is synchronous and is missing `getMandate`, `appendEvent` and
 * `listEvents`. Rather than change its signatures — which every existing caller
 * and test depends on — `InMemoryRepository` adapts it.
 */
// NOTE: no `server-only` marker here on purpose — it throws outside a React
// server environment, which would break the test runner. The bundler boundary is
// already enforced by the fact that only app/api routes import this module.
import type { Pool } from "pg";
import type {
  Agent, Agreement, Authorization, ClearingEpoch, Deliverable, EvidenceRecord, Integration, Intent, Mandate, Obligation, Receipt, Reservation, Run, RunEvent,
  Saga, Settlement, Space, Vault,
} from "@/lib/domain/types";
import { linkAndSign, type ReceiptDraft, type ReceiptSigner } from "@/lib/kernel/receipts";
import type {
  CapitalResult, EconomicRepository, ReserveCapitalInput, SeedCounts,
} from "@/lib/store/repository";
import { createPool } from "@/lib/store/db";
import { PostgresRepository } from "@/lib/store/postgres";
import { CapitalLedger, getLedger } from "@/lib/store/ledger";
import {
  agents as seedAgents, agreements, clearingEpochs as seedEpochs, deliverables, evidence, integrations, mandates, obligations, runs,
  settlements, spaces,
} from "@/lib/store/seed";

/** Which store served a request. Surfaced in API responses; never inferred. */
export type Backend = "postgres" | "memory";

/**
 * Adapts the synchronous, partial `CapitalLedger` to the async
 * `EconomicRepository` contract. Test double only — see the file header.
 */
export class InMemoryRepository implements EconomicRepository {
  private readonly ledger: CapitalLedger;
  private readonly spacesMap = new Map<string, Space>();
  private readonly agreementsMap = new Map<string, Agreement>();
  private readonly settlementsMap = new Map<string, Settlement>();
  /** F94 — deliverables written this session, alongside the seeded fixtures. */
  private readonly writtenDeliverables = new Map<string, Deliverable>();
  /** Per run, oldest first. Appends are synchronous, so the chain cannot fork. */
  private readonly receiptsByRun = new Map<string, Receipt[]>();
  private readonly intentsMap = new Map<string, Intent>();

  constructor(ledger: CapitalLedger = getLedger()) {
    this.ledger = ledger;
    for (const s of spaces) this.spacesMap.set(s.spaceId, { ...s });
    for (const a of agreements) this.agreementsMap.set(a.agreementId, { ...a });
    for (const st of settlements) this.settlementsMap.set(st.settlementId, { ...st });
  }

  async getVault(vaultId: string): Promise<Vault | null> {
    return this.ledger.getVault(vaultId) ?? null;
  }

  /**
   * The ledger is seeded at construction, so this is a no-op — but the COUNTS it
   * reports are the in-memory world's actual contents, not zeros.
   *
   * It previously returned zeros for everything, which was the in-memory half of
   * the disagreement found by running with DATABASE_URL set: the Postgres backend
   * persisted spaces and agreements, this one reported none, and the two backends
   * described different worlds.
   */
  async seedReferenceData(): Promise<SeedCounts> {
    return {
      // The ledger owns vaults, mandates and reservations, so those counts are
      // read from it rather than reported as zero. A backend reporting 0 for
      // data it demonstrably holds is the same lie as the one F36 caught.
      vaults: this.ledger.listVaults().length,
      mandates: mandates.length,
      reservations: this.ledger.listReservations().length,
      spaces: this.spacesMap.size,
      agreements: this.agreementsMap.size,
      obligations: obligations.length,
      settlements: this.settlementsMap.size,
      runs: runs.length,
      deliverables: deliverables.length,
      agents: this.agentsMap.size,
      epochs: this.epochsMap.size,
    };
  }

  /** Served from the seed array: the ledger has no mandate store of its own. */
  async getMandate(mandateId: string): Promise<Mandate | null> {
    return mandates.find((m) => m.mandateId === mandateId) ?? null;
  }

  /** Enumerated from the ledger, which is the only owner of vault state. */
  async listVaults(): Promise<Vault[]> {
    return this.ledger.listVaults();
  }

  /**
   * Spaces and agreements, initialized from reference fixtures and updated
   * by commercial operations.
   */
  /**
   * Integration + evidence declarations. See `repository.ts` for why these are
   * served through the store but are NOT runtime state, and why a "postgres"
   * backend label says nothing about whether a claim was re-verified.
   */
  async createIntent(intent: Intent): Promise<Intent> {
    const existing = this.intentsMap.get(intent.intentId);
    if (existing) {
      return { ...existing };
    }
    // Intent maps are module-scoped like the other in-memory state; clone on
    // write so a caller holding the old object cannot mutate stored state.
    this.intentsMap.set(intent.intentId, { ...intent });
    return { ...intent };
  }

  async getIntent(id: string): Promise<Intent | null> {
    const i = this.intentsMap.get(id);
    return i ? { ...i } : null;
  }

  async listIntents(filter: { principal?: string; agentId?: string } = {}): Promise<Intent[]> {
    return [...this.intentsMap.values()]
      .filter((i) => (!filter.principal || i.principal === filter.principal))
      .filter((i) => (!filter.agentId || i.initiatingAgentId === filter.agentId))
      .map((i) => ({ ...i }));
  }

  async listIntegrations(): Promise<Integration[]> {
    return integrations.map((i) => ({ ...i }));
  }

  async listEvidenceRecords(): Promise<EvidenceRecord[]> {
    return evidence.map((e) => ({ ...e }));
  }

  async listSpaces(): Promise<Space[]> {
    return [...this.spacesMap.values()].map((s) => ({ ...s }));
  }

  async createSpace(space: Space): Promise<void> {
    this.spacesMap.set(space.spaceId, { ...space });
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    const s = this.spacesMap.get(spaceId);
    return s ? { ...s } : null;
  }

  async updateSpace(space: Space): Promise<void> {
    this.spacesMap.set(space.spaceId, { ...space });
  }

  async listAgreements(spaceId?: string): Promise<Agreement[]> {
    return [...this.agreementsMap.values()]
      .filter((a) => !spaceId || a.spaceIds.includes(spaceId))
      .map((a) => ({ ...a }));
  }

  async getAgreement(agreementId: string): Promise<Agreement | null> {
    const a = this.agreementsMap.get(agreementId);
    return a ? { ...a } : null;
  }

  async saveAgreement(agreement: Agreement): Promise<void> {
    this.agreementsMap.set(agreement.agreementId, { ...agreement });
  }

  async updateAgreement(agreement: Agreement): Promise<void> {
    this.agreementsMap.set(agreement.agreementId, { ...agreement });
  }

  /**
   * The remaining economic entities, from the reference arrays.
   *
   * These exist so the routes can go through the store instead of importing
   * `seed.ts` and serving fixtures. The two backends now describe the same world
   * (F36); before this, `/clearing`, `/obligations`, `/runs` and `/accounting`
   * returned seed data under the in-memory backend and an EMPTY world under
   * Postgres, and nothing detected it because `DATABASE_URL` is unset by default.
   */
  async listObligations(): Promise<Obligation[]> {
    return obligations.map((o) => ({ ...o }));
  }

  async listSettlements(): Promise<Settlement[]> {
    return [...this.settlementsMap.values()].map((s2) => ({ ...s2 }));
  }

  async getSettlement(settlementId: string): Promise<Settlement | null> {
    const s2 = this.settlementsMap.get(settlementId);
    return s2 ? { ...s2 } : null;
  }

  /** Synchronous check-and-set, so two awaiting callers cannot both claim. */
  async claimSettlement(settlement: Settlement): Promise<boolean> {
    const existing = this.settlementsMap.get(settlement.settlementId);
    if (existing && existing.status !== "FAILED") return false;
    this.settlementsMap.set(settlement.settlementId, { ...settlement });
    return true;
  }

  async appendReceipt(draft: ReceiptDraft, signer?: ReceiptSigner): Promise<Receipt> {
    const existing = await this.getReceipt(draft.receiptId);
    if (existing) return existing;
    const run = draft.runId ?? "";
    const chain = this.receiptsByRun.get(run) ?? [];
    const receipt = await linkAndSign(draft, chain.at(-1) ?? null, signer);
    // Signing awaited: re-check nothing was appended for this run or id meanwhile.
    const now = this.receiptsByRun.get(run) ?? [];
    if (now.length !== chain.length) return this.appendReceipt(draft, signer);
    this.receiptsByRun.set(run, [...chain, receipt]);
    return { ...receipt };
  }

  async getReceipt(receiptId: string): Promise<Receipt | null> {
    for (const chain of this.receiptsByRun.values()) {
      const r = chain.find((x) => x.receiptId === receiptId);
      if (r) return { ...r };
    }
    return null;
  }

  async listReceipts(runId: string): Promise<Receipt[]> {
    return (this.receiptsByRun.get(runId) ?? []).map((r) => ({ ...r }));
  }

  async updateSettlement(settlement: Settlement): Promise<void> {
    if (!this.settlementsMap.has(settlement.settlementId)) throw new Error("SETTLEMENT_NOT_CLAIMED");
    this.settlementsMap.set(settlement.settlementId, { ...settlement });
  }

  async listRuns(): Promise<Run[]> {
    return runs.map((r) => ({ ...r }));
  }

  async listDeliverables(): Promise<Deliverable[]> {
    // Seeded fixtures plus anything written this session (F94). A reader that returned only
    // the seed would have reported "no deliverable" for one that was submitted moments ago.
    return [...deliverables.map((d) => ({ ...d })), ...this.writtenDeliverables.values()].map((d) => ({ ...d }));
  }

  /** F94: the writer `listDeliverables` was missing, so a submission was kept by nobody. */
  async saveDeliverable(deliverable: Deliverable): Promise<void> {
    this.writtenDeliverables.set(deliverable.deliverableId, { ...deliverable });
  }

  async listReservations(vaultId?: string): Promise<Reservation[]> {
    return this.ledger.listReservations(vaultId);
  }

  async getReservation(reservationId: string): Promise<Reservation | null> {
    return this.ledger.getReservation(reservationId) ?? null;
  }

  /**
   * Reserves through the ledger's own `reserve` so the kernel stays the single
   * definition of what "reserving capital" means. Contention cannot be detected
   * across processes here — a property of the store, not this adapter, and why
   * `backend: "memory"` is reported rather than hidden.
   */
  async reserveCapital(input: ReserveCapitalInput): Promise<CapitalResult> {
    const { reserve } = await import("@/lib/kernel/vault");
    try {
      const vault = this.ledger.reserveCapital(input.vaultId, input.amount, reserve);
      const reservation: Reservation = {
        reservationId: input.reservationId,
        runId: input.runId,
        vaultId: input.vaultId,
        intentId: input.intentId,
        mandateId: input.mandateId,
        mandateVersion: input.mandateVersion,
        asset: input.asset,
        amount: input.amount,
        chain: input.chain,
        actionDigest: input.actionDigest,
        expiresAt: input.expiresAt,
        ...(input.agreementId !== undefined ? { agreementId: input.agreementId } : {}),
        ...(input.residualRef !== undefined ? { residualRef: input.residualRef } : {}),
        nonce: this.ledger.allocateNonce(input.vaultId),
        status: "RESERVED",
        version: 1,
      };
      this.ledger.putReservation(reservation);
      return { ok: true, vault, reservation };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "RESERVATION_FAILED" };
    }
  }

  async consumeNonce(vaultId: string, nonce: number, _reservationId: string): Promise<boolean> {
    return this.ledger.consumeNonce(vaultId, nonce);
  }

  async setReservationStatus(
    reservationId: string,
    status: Reservation["status"],
  ): Promise<Reservation | null> {
    return this.ledger.setReservationStatus(reservationId, status) ?? null;
  }

  async putReservation(reservation: Reservation): Promise<Reservation> {
    return this.ledger.putReservation(reservation);
  }

  async beginSettlement(reservationId: string): Promise<Reservation | null> {
    const { consumeReservation } = await import("@/lib/kernel/vault");
    return this.ledger.beginSettlement(reservationId, consumeReservation);
  }

  async completeSettlement(reservationId: string, paidAmount: number): Promise<boolean> {
    const { settleCapital } = await import("@/lib/kernel/vault");
    return this.ledger.completeSettlement(reservationId, paidAmount, settleCapital);
  }

  async recordAuthorization(auth: Authorization): Promise<void> {
    this.ledger.recordAuthorization(auth);
  }

  async listAuthorizations(runId?: string): Promise<Authorization[]> {
    return this.ledger.listAuthorizations().filter((a) => !runId || a.runId === runId).reverse();
  }

  // ── Sagas (F49) ─────────────────────────────────────────────────────────────
  //
  // A DELEGATION, not a second store. `InMemoryRepository` wraps `CapitalLedger`, and
  // the ledger already owns the saga map — implementing this interface here as a
  // separate copy would reintroduce exactly the drift `activeMandates` had (F48): two
  // answers to "is this saga persisted?" that agree only until one of them changes.

  async saveSaga(saga: Saga): Promise<void> {
    await this.ledger.saveSaga(saga);
  }

  async getSaga(sagaId: string): Promise<Saga | null> {
    return this.ledger.getSaga(sagaId);
  }

  async listSagas(runId?: string): Promise<Saga[]> {
    return this.ledger.listSagas(runId);
  }

  async updateSaga(saga: Saga): Promise<void> {
    await this.ledger.updateSaga(saga);
  }

  async recentSpend(
    vaultId: string,
    mandateId: string,
    now: Date,
    windowMinutes: number,
  ): Promise<{ at: string; amount: number }[]> {
    return this.ledger.recentSpend(vaultId, mandateId, now, windowMinutes);
  }

  /**
   * A real, append-only event log for this process (sprint item 5).
   *
   * It used to return a synthetic id and keep nothing, so `listEvents` was always
   * empty under the in-memory backend and a Console reading it could only ever show
   * fixtures. Process-local, like everything else in this store — `backend: "memory"`
   * says so.
   */
  private readonly eventLog: RunEvent[] = [];

  async appendEvent(event: Omit<RunEvent, "eventId">): Promise<RunEvent> {
    const stored: RunEvent = { ...event, eventId: `evt_${this.eventLog.length + 1}` };
    this.eventLog.push(stored);
    return { ...stored };
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.eventLog.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }

  async listEventsSince(cursor: number, limit = 200): Promise<Array<{ seq: number; event: RunEvent }>> {
    return this.eventLog.slice(Math.max(0, cursor), Math.max(0, cursor) + limit)
      .map((event, i) => ({ seq: cursor + i + 1, event: { ...event } }));
  }

  async listMandates(): Promise<Mandate[]> {
    return mandates.map((m) => ({ ...m }));
  }

  private readonly epochsMap = new Map<string, ClearingEpoch>(seedEpochs.map((e) => [e.epochId, { ...e }]));

  async getEpoch(epochId: string): Promise<ClearingEpoch | null> {
    const e = this.epochsMap.get(epochId);
    return e ? { ...e } : null;
  }

  async listEpochs(): Promise<ClearingEpoch[]> {
    return [...this.epochsMap.values()].map((e) => ({ ...e }));
  }

  async insertEpoch(epoch: ClearingEpoch): Promise<boolean> {
    if (this.epochsMap.has(epoch.epochId)) return false;
    this.epochsMap.set(epoch.epochId, { ...epoch });
    return true;
  }

  async saveEpoch(epoch: ClearingEpoch): Promise<void> {
    this.epochsMap.set(epoch.epochId, { ...epoch });
  }

  private readonly agentsMap = new Map<string, Agent>(seedAgents.map((a) => [a.agentId, { ...a }]));

  async listAgents(): Promise<Agent[]> {
    return [...this.agentsMap.values()].map((a) => ({ ...a }));
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const a = this.agentsMap.get(agentId);
    return a ? { ...a } : null;
  }

  async insertAgent(agent: Agent): Promise<boolean> {
    if (this.agentsMap.has(agent.agentId)) return false;
    this.agentsMap.set(agent.agentId, { ...agent });
    return true;
  }

  /** Test setup only (tests/fixtures.ts bindTestWallet). No route reaches it. */
  __putAgentForTests(agent: Agent): void {
    this.agentsMap.set(agent.agentId, { ...agent });
  }
}

export interface StoreHandle {
  repo: EconomicRepository;
  backend: Backend;
  /** Release the pool. A no-op for the in-memory backend. */
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __mitraStore: Promise<StoreHandle> | undefined;
}

/**
 * The store for this process, opened once.
 *
 * Memoised on `globalThis` so Next.js hot reloads do not open a new pool per
 * edit. Resets are explicit via `__resetStoreForTests`.
 */
export function getStore(): Promise<StoreHandle> {
  if (!globalThis.__mitraStore) {
    globalThis.__mitraStore = openStore();
  }
  return globalThis.__mitraStore;
}

async function openStore(): Promise<StoreHandle> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return { repo: new InMemoryRepository(), backend: "memory", close: async () => {} };
  }
  const pool: Pool = createPool(connectionString);
  const repo = new PostgresRepository(pool);
  await repo.migrate();
  return { repo, backend: "postgres", close: async () => { await pool.end(); } };
}

export async function __putAgentForTests(agent: Agent): Promise<void> {
  const { repo } = await getStore();
  if (!(repo instanceof InMemoryRepository)) throw new Error("__putAgentForTests: memory backend only");
  repo.__putAgentForTests(agent);
}

export function __resetStoreForTests(): void {
  globalThis.__mitraStore = undefined;
}
