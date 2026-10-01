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
