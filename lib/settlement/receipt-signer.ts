/**
 * The receipt signer (backlog #4): an EVM key that signs each receipt's hash with
 * EIP-191, so anyone can check a Mitra receipt with standard tooling
 * (`recoverMessageAddress`) — `verifyReceipts` does exactly that.
 *
 * Configured by `MITRA_RECEIPT_SIGNER_KEY_FILE` (hex key). Absent, receipts stay
 * `unsigned:` and say so. It should be its own key: it attests to what Mitra
 * observed, and is not a key that moves money.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { ReceiptSigner } from "@/lib/kernel/receipts";

export function evmReceiptSigner(account: LocalAccount): ReceiptSigner {
  return {
    id: `eip191:${account.address}`,
    sign: (hash) => account.signMessage({ message: { raw: hash } }),
  };
}

export function receiptSignerFromEnv(env: Record<string, string | undefined> = process.env): ReceiptSigner | undefined {
  const file = env.MITRA_RECEIPT_SIGNER_KEY_FILE;
  if (!file) return undefined;
  return evmReceiptSigner(privateKeyToAccount(`0x${readFileSync(file, "utf8").trim().replace(/^0x/, "")}`));
}
