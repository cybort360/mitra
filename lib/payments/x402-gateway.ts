/**
 * The x402 gateway (PRD §12.1; sprint item 4): an agent fetches a paid resource
 * through Mitra, and Mitra pays — only from a reservation, only after the
 * execution guard, only with the reference SDK.
 *
 * - Protocol: `@x402/fetch` + `@x402/core` + `@x402/evm` (x402 V2, `exact` scheme,
 *   EIP-3009 `transferWithAuthorization`). Mitra writes no x402 verifier (§12.1).
 * - Mitra's half: `planX402Payment` runs in the SDK's `onBeforePaymentCreation`
 *   hook, BEFORE anything is signed. A refusal aborts payment creation.
 * - At-most-once: the same discipline as agreement settlement (item 1). The
 *   settlement id is derived from the reservation and claimed insert-only, then the
 *   reservation's nonce is consumed — both before the authorization is signed.
 * - Confirmation: from the chain only. The resource server's facilitator reports a
 *   transaction hash; the gateway reads that transaction and requires a token
 *   Transfer from the payer to the payee for the exact amount.
 *
 * ## A signed authorization is live money until it expires
 *
 * An EIP-3009 authorization can be submitted by anyone holding it until its
 * `validBefore`. If the resource server takes the signature and does not settle,
 * the payment is NOT failed — it is outstanding. The settlement stays `PENDING` with
 * `failureReason` naming the expiry, and the reservation stays `SETTLING`.
 */

import { createPublicClient, http, type LocalAccount, type PublicClient, type Transport } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Settlement } from "@/lib/domain/types";
import type { EconomicRepository } from "@/lib/store/repository";
import { planX402Payment, X402_NETWORK, x402SettlementIdFor, type X402Plan } from "@/lib/kernel/x402";
import { settlementReceipt, type ReceiptSigner } from "@/lib/kernel/receipts";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Reads a transaction back and reports whether it moved exactly this transfer. */
export type TransferObserver = (txHash: string, expected: { token: string; from: string; to: string; amountAtomic: bigint }) =>
  Promise<{ block: number } | null>;

export function rpcTransferObserver(client: PublicClient): TransferObserver {
  return async (txHash, e) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }); } catch { return null; }
    if (receipt.status !== "success") return null;
    const addr = (t: string | undefined) => (t ? `0x${t.slice(-40)}`.toLowerCase() : "");
    const moved = receipt.logs.some((l) =>
      l.address.toLowerCase() === e.token.toLowerCase() && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics.length === 3 && addr(l.topics[1]) === e.from.toLowerCase() && addr(l.topics[2]) === e.to.toLowerCase() &&
      BigInt(l.data) === e.amountAtomic);
    return moved ? { block: Number(receipt.blockNumber) } : null;
  };
}

export interface X402PayInput {
  repo: EconomicRepository;
  reservationId: string;
  url: string;
  init?: RequestInit;
  /** Signs the EIP-3009 authorization. The vault record's address must be this account. */
  signer: LocalAccount;
  now: () => Date;
  observe: TransferObserver;
  /** For tests: the fetch the SDK wraps. */
  fetchImpl?: typeof fetch;
  /** Recorded on the receipt's chain evidence. */
  network?: string;
  /** Signs the SettlementReceipt (backlog #4); absent, the receipt is unsigned. */
  receiptSigner?: ReceiptSigner;
}

export interface X402PayResult {
  /** The resource's response, when the request completed. */
  response: Response | null;
  /** Why Mitra refused to pay, when it did. Nothing was signed. */
  refusal: string | null;
  settlement: Settlement | null;
}

export async function payX402(input: X402PayInput): Promise<X402PayResult> {
  const { repo } = input;
  const reservation = await repo.getReservation(input.reservationId);
  if (!reservation) return { response: null, refusal: "RESERVATION_NOT_FOUND", settlement: null };
  const mandate = await repo.getMandate(reservation.mandateId);
  if (!mandate) return { response: null, refusal: "MANDATE_NOT_FOUND", settlement: null };
  const vault = await repo.getVault(reservation.vaultId);
  if (!vault) return { response: null, refusal: "VAULT_NOT_FOUND", settlement: null };

  let refusal: string | null = null;
  let plan: X402Plan | null = null;
  let settlement: Settlement | null = null;
  let validBefore: string | null = null;
  let settledTx: string | null = null;
  let settleError: string | null = null;

  const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(toClientEvmSigner(input.signer)));

  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    const now = input.now();
    const consumedNonces = (await repo.listReservations(vault.vaultId))
      .filter((r) => r.status === "COMMITTED" || r.status === "SETTLING" || r.status === "SETTLED")
      .map((r) => r.nonce);
    const fresh = (await repo.getReservation(reservation.reservationId)) ?? reservation;
    const p = planX402Payment({
      requirements: selectedRequirements,
      announcedResource: paymentRequired.resource?.url ?? "",
      expectedResource: input.url,
      reservation: fresh, mandate, vault, payer: input.signer.address, now, consumedNonces,
    });
    if (!p.ok) { refusal = p.reason; return { abort: true, reason: p.reason }; }

    const claim: Settlement = {
      settlementId: p.value.settlementId, runId: fresh.runId, reservationId: fresh.reservationId, obligationIds: [],
      chain: "base", asset: fresh.asset, amount: p.value.amount, from: input.signer.address, to: p.value.payTo,
      status: "PENDING", submittedAt: now.toISOString(), evidenceLevel: "DESIGN_ONLY",
    };
    if (!await repo.claimSettlement(claim)) { refusal = "SETTLEMENT_ALREADY_CLAIMED"; return { abort: true, reason: refusal }; }
    if (!await repo.consumeNonce(vault.vaultId, fresh.nonce, fresh.reservationId)) {
      settlement = { ...claim, status: "FAILED", failureReason: "NONCE_ALREADY_CONSUMED" };
      await repo.updateSettlement(settlement);
      refusal = "NONCE_ALREADY_CONSUMED";
      return { abort: true, reason: refusal };
    }
    // SETTLING, and its capital reserved → settling, in one store operation.
    if (!await repo.beginSettlement(fresh.reservationId)) {
      settlement = { ...claim, status: "FAILED", failureReason: "RESERVATION_NOT_EXECUTABLE" };
      await repo.updateSettlement(settlement);
      refusal = "RESERVATION_NOT_EXECUTABLE";
      return { abort: true, reason: refusal };
    }
    plan = p.value;
    settlement = claim;
  });

  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    const auth = (paymentPayload.payload as { authorization?: { validBefore?: string | number } }).authorization;
    if (auth?.validBefore !== undefined) validBefore = new Date(Number(auth.validBefore) * 1000).toISOString();
  });

  client.onPaymentResponse(async (ctx) => {
    if (ctx.settleResponse?.success && ctx.settleResponse.transaction) settledTx = ctx.settleResponse.transaction;
    else settleError = ctx.settleResponse?.errorReason ?? (ctx.paymentRequired ? "VERIFY_FAILED" : ctx.error?.message ?? "NO_SETTLEMENT");
  });

  const paidFetch = wrapFetchWithPayment(input.fetchImpl ?? fetch, client);
  let response: Response | null = null;
  try {
    response = await paidFetch(input.url, input.init);
  } catch (e) {
    if (refusal) return { response: null, refusal, settlement };
    // The SDK refused before Mitra's hook ran (e.g. an unregistered network, or a
    // token outside its spend controls). Nothing was signed; say so, not null.
    if (!settlement) return { response: null, refusal: `X402_PAYMENT_NOT_CREATED: ${e instanceof Error ? e.message : String(e)}`, settlement: null };
    settleError = settleError ?? (e instanceof Error ? e.message : String(e));
  }

  if (!settlement) return { response, refusal, settlement: null };
  // The non-null assertions below are safe: `settlement` is only set together with `plan`.
  const p = plan as unknown as X402Plan;
  let s = settlement as Settlement;

  if (!settledTx) {
    // Signed (or about to be), not settled: outstanding until the authorization expires.
    s = { ...s, failureReason: `AUTHORIZATION_OUTSTANDING_UNTIL ${validBefore ?? "unknown"}: ${settleError ?? "no settlement reported"}` };
    await repo.updateSettlement(s);
    return { response, refusal: null, settlement: s };
  }

  s = { ...s, status: "SUBMITTED", txHash: settledTx, evidenceLevel: "LOCAL_PASS" };
  await repo.updateSettlement(s);
  const seen = await input.observe(settledTx, { token: p.token, from: input.signer.address, to: p.payTo, amountAtomic: p.amountAtomic });
  if (!seen) return { response, refusal: null, settlement: s };

  // Capital, exactly once: the reserved amount leaves settling, the PAID amount
  // leaves total, and what the 402 did not ask for returns to available.
  await repo.completeSettlement(reservation.reservationId, p.amount);
  const now = input.now();
  const confirmed: Settlement = { ...s, status: "CONFIRMED", confirmedAt: now.toISOString(), evidenceLevel: "TESTNET_PASS" };
  const receipt = await repo.appendReceipt(settlementReceipt(confirmed, input.network ?? "base-sepolia", now), input.receiptSigner);
  const final: Settlement = { ...confirmed, receiptId: receipt.receiptId };
  await repo.updateSettlement(final);
  return { response, refusal: null, settlement: final };
}

/** A transfer observer on Base Sepolia over the given transport. */
export function baseSepoliaObserver(transport: Transport = http()): TransferObserver {
  return rpcTransferObserver(createPublicClient({ chain: baseSepolia, transport }) as PublicClient);
}

export { x402SettlementIdFor };
