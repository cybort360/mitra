import type {
  Authorization, AuthorizationDecision, Reservation, ReservationStatus, Saga, Vault,
} from "@/lib/domain/types";
import { mandates, reservations, vaults } from "@/lib/store/seed";
import { transition } from "@/lib/kernel/machines";
import { createHash, randomUUID } from "node:crypto";

/**
 * Process-local capital and nonce ledger.
 *
 * Phase 1 scope: this replaces nothing persistent — `lib/store` is still the
 * seed array until Phase 3 lands a real store. What it does provide is the
 * mutable state a mutation needs in order to be *real* rather than a dry run:
 * consumed nonces and reserved capital. Without it, `consumedNonces` would be
 * whatever the caller passed in, and the idempotency boundary in docs/API.md
 * would be self-asserted rather than enforced.
 *
 * The single-writer assumption is deliberate and matches the seed store: one
 * Node process, one ledger. Swapping this for Postgres is a Phase 3 change and
 * must not leak into the kernel, which stays pure.
 */
export class CapitalLedger {
  /** reservationId -> reservation currently held. */
  private readonly reservations = new Map<string, Reservation>();
  /** Nonces already spent, per vault, so replays are refused across reservations. */
  private readonly consumedNonces = new Map<string, Set<number>>();
  /** Latest vault capital position, keyed by vaultId. */
  private readonly vaults = new Map<string, Vault>();
  /** Authorizations issued, newest last. */
  private readonly authorizations: Authorization[] = [];

  private readonly sagas = new Map<string, Saga>();

  constructor(seedVaults: readonly Vault[] = [], seedReservations: readonly Reservation[] = []) {
    for (const v of seedVaults) this.vaults.set(v.vaultId, { ...v });
    for (const r of seedReservations) this.reservations.set(r.reservationId, { ...r });
  }

  /**
   * `activeMandates` and `activeReservations` are DERIVED here, from live state,
   * rather than carried through from the seed.
   *
   * **This is F33 again, in a different object.** The seed declared which
   * reservations were active, and the ledger echoed that declaration back
   * forever — so a reservation that had since been released still appeared active,
   * and nothing noticed because the Postgres backend DERIVED the same fields from
   * actual state. The two backends answered different questions about the same
   * vault, and the backend-parity test found it.
   *
   * A declared list that is not recomputed is the same defect as
   * `Space.agreementIds`: a second copy of a fact, stored beside the fact, free
   * to drift. Deriving it makes the two copies impossible to disagree.
   */
  private derive(vaultId: string, v: Vault): Vault {
    const activeReservations = [...this.reservations.values()]
      .filter((r) => r.vaultId === vaultId && (r.status === "RESERVED" || r.status === "COMMITTED"))
      .map((r) => r.reservationId)
      .sort();
    // F48: `activeMandates` is now DERIVED from the seed's mandate array by
    // (vaultId, status), exactly as Postgres derives it. It used to be left as the
    // seed's DECLARED list, with a comment recording the divergence as "a genuine
    // difference in what the two backends can know".
    //
    // That was not a difference in knowledge — both have the same mandate array. It
    // was a declared list that nobody recomputed, and it drifted the moment a mandate
    // was added: Postgres saw three ACTIVE mandates for this vault, the ledger saw
    // the two the seed had named. The backend-parity test caught it immediately.
    //
    // Same defect as `Space.agreementIds` (F33) and the same fix: derive, don't declare.
    const activeMandates = mandates
      .filter((m) => m.vaultId === vaultId && m.status === "ACTIVE")
      .map((m) => m.mandateId)
      .sort();
    return { ...v, activeMandates, activeReservations };
  }

  getVault(vaultId: string): Vault | undefined {
    const v = this.vaults.get(vaultId);
    return v ? this.derive(vaultId, v) : undefined;
  }

  /**
   * Every vault the ledger holds.
   *
   * Added because the `/vaults` API route was reading the static seed array
   * directly: it returned *fixtures* with a live reconciliation computed on top,
   * which is indistinguishable from real state at the HTTP boundary. The ledger
   * already owned the vaults; it simply had no way to enumerate them, so the
   * route reached past it. A store that cannot list what it holds invites its
   * callers to go around it.
   */
  listVaults(): Vault[] {
    return [...this.vaults.entries()].map(([id, v]) => this.derive(id, v));
  }

  /**
   * A vault whose capital lives in the vault CONTRACT (a customer's card, synced from the
   * chain). Created from the chain's positions; refreshed from them only while the
   * engine's own books for it are idle, so a sync can never overwrite capital this
   * engine has reserved, escrowed, encumbered or put into settlement.
   */
  upsertChainVault(vault: Vault): "created" | "refreshed" | "kept" {
    const current = this.vaults.get(vault.vaultId);
    if (!current) {
      this.vaults.set(vault.vaultId, { ...vault });
      return "created";
    }
    const busy = current.reserved + current.escrowed + current.encumbered + current.settling > 0;
    if (busy) {
      this.vaults.set(vault.vaultId, { ...current, emergencyFreeze: vault.emergencyFreeze });
      return "kept";
    }
    this.vaults.set(vault.vaultId, { ...current, ...vault, version: current.version + 1 });
    return "refreshed";
  }

  /** Capital that is actually spendable, with a reservation applied if required. */
  /**
   * Settlement capital (backlog #2), each one synchronous so it cannot interleave:
   * begin moves the reservation to SETTLING (through COMMITTED, as the machine
   * requires) and its capital `reserved → settling`; complete moves it to SETTLED
   * and closes the capital. Complete returns false if the reservation is not
   * SETTLING — the once-only gate a racing second confirmation hits.
   */
  beginSettlement(reservationId: string, consume: (v: Vault, r: Reservation) => Vault): Reservation | null {
    const r = this.reservations.get(reservationId);
    if (!r || (r.status !== "RESERVED" && r.status !== "COMMITTED")) return null;
    const v = this.vaults.get(r.vaultId);
    if (!v) return null;
    const nextVault = consume(v, r);
    let next = r;
    if (next.status === "RESERVED") next = { ...transition("reservation", next, "COMMITTED"), version: next.version + 1 };
    next = { ...transition("reservation", next, "SETTLING"), version: next.version + 1 };
    this.vaults.set(r.vaultId, nextVault);
    this.reservations.set(reservationId, next);
    return { ...next };
  }

  completeSettlement(reservationId: string, paid: number, settle: (v: Vault, reserved: number, paid: number) => Vault): boolean {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== "SETTLING") return false;
    const v = this.vaults.get(r.vaultId);
    if (!v) return false;
    const nextVault = settle(v, r.amount, paid);
    this.vaults.set(r.vaultId, nextVault);
    this.reservations.set(reservationId, { ...transition("reservation", r, "SETTLED"), version: r.version + 1 });
    return true;
  }

  reserveCapital(vaultId: string, amount: number, reserve: (v: Vault, a: number) => Vault): Vault {
    const current = this.vaults.get(vaultId);
    if (!current) throw new Error(`VAULT_NOT_FOUND: ${vaultId}`);
    const next = reserve(current, amount);
    this.vaults.set(vaultId, next);
    return { ...next };
  }

  /** Nonces already consumed on this vault. */
  consumedFor(vaultId: string): number[] {
    return [...(this.consumedNonces.get(vaultId) ?? [])];
  }

  /**
   * Spend a nonce. Idempotent by design: a repeat returns false rather than
   * throwing, so the caller decides how to report it.
   */
  consumeNonce(vaultId: string, nonce: number): boolean {
    const set = this.consumedNonces.get(vaultId) ?? new Set<number>();
    if (set.has(nonce)) return false;
    set.add(nonce);
    this.consumedNonces.set(vaultId, set);
    return true;
  }

  /**
   * Local insertion order, used only to sort listings newest-first. It is not
   * part of the domain `Reservation` and never leaves this module.
   */
  private readonly order = new Map<string, number>();
  private seq = 0;

  putReservation(reservation: Reservation): Reservation {
    this.reservations.set(reservation.reservationId, { ...reservation });
    this.order.set(reservation.reservationId, ++this.seq);
    return { ...reservation };
  }

  /**
   * Allocate a nonce that has not been used on this vault.
   *
   * Callers must not invent their own: a fixed nonce collides as soon as one
   * reservation is spent, and every later execution on the same vault is then
   * refused as a replay even though it is a distinct instruction.
   */
  allocateNonce(vaultId: string): number {
    const used = this.consumedNonces.get(vaultId) ?? new Set<number>();
    const taken = new Set<number>();
    for (const r of this.reservations.values()) if (r.vaultId === vaultId) taken.add(r.nonce);
    let n = 1;
    while (used.has(n) || taken.has(n)) n += 1;
    return n;
  }

  getReservation(reservationId: string): Reservation | undefined {
    const r = this.reservations.get(reservationId);
    return r ? { ...r } : undefined;
  }

  setReservationStatus(reservationId: string, status: ReservationStatus): Reservation | undefined {
    const r = this.reservations.get(reservationId);
    if (!r) return undefined;
    // Enforced, not trusted: the documented reservation state machine now
    // governs writes. Previously any status could be set on any record.
    const next = { ...transition("reservation", r, status), version: r.version + 1 };
    this.reservations.set(reservationId, next);
    return { ...next };
  }

  listReservations(vaultId?: string): Reservation[] {
    return [...this.reservations.values()]
      .filter((r) => !vaultId || r.vaultId === vaultId)
      .map((r) => ({ ...r }))
      .sort((a, b) => (this.order.get(b.reservationId) ?? 0) - (this.order.get(a.reservationId) ?? 0));
  }

  recordAuthorization(auth: Authorization): Authorization {
    this.authorizations.push({ ...auth });
    return { ...auth };
  }

  listAuthorizations(): Authorization[] {
    return this.authorizations.map((a) => ({ ...a }));
  }

  /**
   * Spend already executed inside the velocity window, derived from settled
   * reservations so the feed cannot be forged by the caller. A negative amount
   * in a seeded record would otherwise *reduce* the windowed sum and let a
   * request slip under the limit, so only finite positive amounts count.
   */
  recentSpend(vaultId: string, mandateId: string, now: Date, windowMinutes: number): { at: string; amount: number }[] {
    const cutoff = now.getTime() - windowMinutes * 60_000;
    return [...this.reservations.values()]
      .filter((r) => r.vaultId === vaultId && r.mandateId === mandateId)
      .filter((r) => r.status === "SETTLED" || r.status === "COMMITTED")
      .filter((r) => Number.isFinite(r.amount) && r.amount > 0)
      .filter((r) => new Date(r.expiresAt).getTime() > cutoff)
      .map((r) => ({ at: r.expiresAt, amount: r.amount }));
  }

  // ── Sagas (F49) ─────────────────────────────────────────────────────────────
  //
  // A saga is stored by value, not by reference, so a caller mutating the object it
  // passed in cannot reach into the store afterwards — the same rule the vault and
  // reservation maps already follow. `saveSaga` is an upsert because the recovery
  // kernel produces a new immutable Saga per transition rather than mutating one.

  async saveSaga(saga: Saga): Promise<void> {
    this.sagas.set(saga.sagaId, { ...saga, steps: saga.steps.map((s) => ({ ...s })) });
  }

  async getSaga(sagaId: string): Promise<Saga | null> {
    return this.sagas.get(sagaId) ?? null;
  }

  async listSagas(runId?: string): Promise<Saga[]> {
    const all = [...this.sagas.values()];
    return runId ? all.filter((s) => s.runId === runId) : all;
  }

  async updateSaga(saga: Saga): Promise<void> {
    await this.saveSaga(saga);
  }
}

/** Stable digest binding an instruction to the exact terms that were evaluated. */
export function actionDigestFor(input: {
  vaultId: string; mandateId: string; mandateVersion: number;
  amount: number; asset: string; chain: string; counterparty: string; capability: string;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    input.vaultId, input.mandateId, input.mandateVersion,
    input.amount, input.asset, input.chain, input.counterparty, input.capability,
  ])).digest("hex")}`;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Process-wide ledger.
 *
 * A module-level singleton so that state survives across requests within one
 * Node process, which is what makes nonce replay detection and capital
 * accounting observable rather than per-call. Seeded from the store on first
 * use. Reset by `__resetLedgerForTests` only.
 */
declare global {
  // eslint-disable-next-line no-var
  var __mitraLedger: CapitalLedger | undefined;
}

export function getLedger(): CapitalLedger {
  if (!globalThis.__mitraLedger) {
    globalThis.__mitraLedger = new CapitalLedger(vaults, reservations);
  }
  return globalThis.__mitraLedger;
}

export function __resetLedgerForTests(): void {
  globalThis.__mitraLedger = undefined;
}
