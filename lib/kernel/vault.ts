import type { Reservation, Vault } from "@/lib/domain/types";

export function reconcileVault(vault: Vault) {
  const accounted = vault.available + vault.reserved + vault.escrowed + vault.encumbered + vault.settling + vault.frozen;
  return { accounted, difference: Number((vault.total - accounted).toFixed(8)), ok: Math.abs(vault.total - accounted) < 0.000001 };
}

export function reserve(vault: Vault, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("INVALID_RESERVATION_AMOUNT");
  if (vault.emergencyFreeze) throw new Error("VAULT_FROZEN");
  if (amount > vault.available) throw new Error("INSUFFICIENT_AVAILABLE_CAPITAL");
  return { ...vault, available: vault.available - amount, reserved: vault.reserved + amount, version: vault.version + 1 };
}

export function releaseReservation(vault: Vault, reservation: Reservation) {
  if (reservation.status !== "RESERVED") throw new Error("RESERVATION_NOT_RELEASABLE");
  if (reservation.amount > vault.reserved) throw new Error("RESERVATION_EXCEEDS_RESERVED_CAPITAL");
  return { ...vault, available: vault.available + reservation.amount, reserved: vault.reserved - reservation.amount, version: vault.version + 1 };
}

export function consumeReservation(vault: Vault, reservation: Reservation) {
  if (reservation.status !== "RESERVED" && reservation.status !== "COMMITTED") throw new Error("RESERVATION_NOT_EXECUTABLE");
  if (reservation.amount > vault.reserved) throw new Error("RESERVATION_EXCEEDS_RESERVED_CAPITAL");
  return { ...vault, reserved: vault.reserved - reservation.amount, settling: vault.settling + reservation.amount, version: vault.version + 1 };
}

/**
 * A settlement confirmed from the chain closes its reservation's capital
 * (backlog #2). The reservation moved `reserved → settling` when settlement began
 * (`consumeReservation`); now the reserved amount leaves `settling`, the amount
 * actually PAID leaves `total`, and any remainder — an x402 payment may be below its
 * reservation — returns to `available`. Before this, a paid vault still showed the
 * money as reserved, and its total never fell.
 */
export function settleCapital(vault: Vault, reservedAmount: number, paidAmount: number) {
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) throw new Error("INVALID_PAID_AMOUNT");
  if (paidAmount > reservedAmount) throw new Error("PAID_EXCEEDS_RESERVATION");
  if (reservedAmount > vault.settling) throw new Error("SETTLEMENT_EXCEEDS_SETTLING_CAPITAL");
  const round = (n: number) => Number(n.toFixed(6));
  return {
    ...vault,
    settling: round(vault.settling - reservedAmount),
    total: round(vault.total - paidAmount),
    available: round(vault.available + (reservedAmount - paidAmount)),
    version: vault.version + 1,
  };
}
