import type {
  Authorization, AuthorizationDecision, Reservation, ReservationStatus, Vault,
} from "@/lib/domain/types";
import { reservations, vaults } from "@/lib/store/seed";
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

  constructor(seedVaults: readonly Vault[] = [], seedReservations: readonly Reservation[] = []) {
    for (const v of seedVaults) this.vaults.set(v.vaultId, { ...v });
    for (const r of seedReservations) this.reservations.set(r.reservationId, { ...r });
  }

  getVault(vaultId: string): Vault | undefined {
    const v = this.vaults.get(vaultId);
    return v ? { ...v } : undefined;
  }

  /** Capital that is actually spendable, with a reservation applied if required. */
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
    const next = { ...r, status, version: r.version + 1 };
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
