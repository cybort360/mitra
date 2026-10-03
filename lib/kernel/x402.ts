/**
 * The Mitra check on an x402 payment (PRD §12.1; sprint item 4).
 *
 * §12.1: "Mitra should not write a partial x402 verifier. Use the reference
 * SDK/conforming implementation and enforce Mitra-specific constraints around
 * resource identity, mandate scope, vault, reservation, limits, replay, chain,
 * asset, and fulfillment. An x402 payment MUST consume an available reservation."
 *
 * So the protocol is `@x402/*`'s, and this module is only the Mitra half: given the
 * payment requirements a 402 announced, may THIS reservation pay them? It runs in
 * the SDK's `onBeforePaymentCreation` hook, before anything is signed.
 *
 * ## How a reservation names an x402 payee
 *
 * A reservation for an x402 payment is made with
 * `counterparty = "x402:<payTo, lowercase>"` and `capability = "x402_payment"`, so
 * policy evaluates the payee when the reservation is made. Here the digest is
 * re-derived from the requirements' `payTo`: a 402 naming any other payee produces a
 * different digest and the execution guard refuses it (`ACTION_DIGEST_MISMATCH`). A
 * resource server cannot redirect a reservation to itself by announcing a new
 * `payTo`.
 *
 * Pure by kernel convention.
 */

import type { Mandate, Reservation, Vault } from "@/lib/domain/types";
import { validateExecutionBinding } from "@/lib/kernel/authorization";
import { fail, pass, type Result } from "@/lib/kernel/commerce";
import { actionDigestFor } from "@/lib/store/ids";
import { BASE_ASSETS } from "@/lib/adapters/base";

export const X402_CAPABILITY = "x402_payment";
export const x402Counterparty = (payTo: string) => `x402:${payTo.toLowerCase()}`;
/** CAIP-2 id of the only network this gateway pays on. */
export const X402_NETWORK = "eip155:84532";
export const x402SettlementIdFor = (reservationId: string) => `set_x402_${reservationId}`;

/** The fields of an x402 V2 `PaymentRequirements` this check reads. */
export interface X402Requirements {
  scheme: string;
  network: string;
  /** Atomic units, as a decimal string. */
  amount: string;
  asset: string;
  payTo: string;
}

export interface X402Plan {
  settlementId: string;
  /** Decimal amount, for the settlement record. */
  amount: number;
  amountAtomic: bigint;
  payTo: string;
  token: `0x${string}`;
}

export function planX402Payment(input: {
  requirements: X402Requirements;
  /** The resource the 402 is for, and the one the caller set out to buy. */
  announcedResource: string;
  expectedResource: string;
  reservation: Reservation;
  mandate: Mandate;
  vault: Vault;
  /** The account that will sign the authorization. */
  payer: string;
  now: Date;
  consumedNonces: number[];
}): Result<X402Plan> {
  const { requirements: r, reservation, mandate, vault, now } = input;

  // Resource identity: the agent pays for what it asked for, not whatever the
  // server says this 402 is about.
  if (input.announcedResource !== input.expectedResource) return fail("X402_RESOURCE_MISMATCH");
  if (r.scheme !== "exact") return fail("X402_SCHEME_NOT_SUPPORTED");
  if (r.network !== X402_NETWORK || reservation.chain !== "base") return fail("X402_NETWORK_MISMATCH");

  const token = BASE_ASSETS[84532][reservation.asset];
  if (!token) return fail("X402_ASSET_NOT_SUPPORTED");
  if (r.asset.toLowerCase() !== token.address.toLowerCase()) return fail("X402_ASSET_MISMATCH");
  if (!/^[1-9][0-9]*$/.test(r.amount)) return fail("X402_AMOUNT_INVALID");
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.payTo)) return fail("X402_PAYTO_INVALID");

  if (mandate.mandateId !== reservation.mandateId) return fail("MANDATE_MISMATCH");
  if (mandate.vaultId !== vault.vaultId || reservation.vaultId !== vault.vaultId) return fail("VAULT_MISMATCH");
  if (mandate.status !== "ACTIVE") return fail("MANDATE_NOT_ACTIVE");
  if (now >= new Date(mandate.expiresAt)) return fail("MANDATE_EXPIRED");
  if (vault.emergencyFreeze) return fail("VAULT_FROZEN");
  // The signer is the account the money leaves; the vault record must name it.
  if (vault.address.toLowerCase() !== input.payer.toLowerCase()) return fail("VAULT_NOT_BOUND_TO_PAYER");

  const amountAtomic = BigInt(r.amount);
  const amount = Number(amountAtomic) / 10 ** token.decimals;
  const digest = actionDigestFor({
    vaultId: reservation.vaultId,
    mandateId: reservation.mandateId,
    mandateVersion: reservation.mandateVersion,
    amount: reservation.amount,
    asset: reservation.asset,
    chain: "base",
    counterparty: x402Counterparty(r.payTo),
    capability: X402_CAPABILITY,
  });
  // The execution guard: digest (binds payee), amount within the reservation,
  // asset, chain, expiry, and a nonce not yet spent.
  const guard = validateExecutionBinding(reservation, digest, amount, reservation.asset, "base", now, {
    consumedNonces: input.consumedNonces,
  });
  if (!guard.ok) return fail(guard.reason);

  return pass({
    settlementId: x402SettlementIdFor(reservation.reservationId),
    amount,
    amountAtomic,
    payTo: r.payTo,
    token: token.address,
  });
}
