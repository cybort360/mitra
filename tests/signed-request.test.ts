/**
 * F55 — caller identity. Seam A: the signed-request module.
 *
 * An agreement transition or a registration is authorised by an EIP-712
 * signature over the exact request, from a wallet registered to the actor that
 * holds the role. Decision: shared context ctx_d236086bde9601ee.
 */
import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SignatureVerifier } from "@/lib/evm/eip712";
import { mitraRequestTypedData, verifySignedRequest, type MitraRequest } from "@/lib/identity/signed-request";

const client = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const NOW = 1_790_000_000; // unix seconds

const clientAgent = { agentId: "agent_client", wallets: [{ chain: "base" as const, address: client.address }] };

const request = (over: Partial<MitraRequest> = {}): MitraRequest => ({
  op: "fund",
  agreementId: "ag_1",
  fromStatus: "OPEN",
  actor: "agent_client",
  bodyHash: `0x${"ab".repeat(32)}`,
  expiresAt: NOW + 300,
  ...over,
});

/** An EOA signature never reaches ERC-1271; a call here means the EOA path was skipped. */
const noContractWallets: SignatureVerifier = {
  isValidSignature: async () => { throw new Error("unexpected ERC-1271 call"); },
};

describe("signed requests", () => {
  it("accepts a request signed by a wallet registered to the actor", async () => {
    const r = request();
    const signature = await client.signTypedData(mitraRequestTypedData(r, 84532));
    const verdict = await verifySignedRequest({
      request: r,
      auth: { signer: client.address, chainId: 84532, signature },
      agent: clientAgent,
      now: NOW,
      verifier: noContractWallets,
    });
    expect(verdict).toEqual({ ok: true, mode: "eoa" });
  });

  it("refuses a valid signature from a wallet not registered to the actor", async () => {
    // The stranger signs honestly as themselves, but claims to act as agent_client.
    const r = request();
    const signature = await stranger.signTypedData(mitraRequestTypedData(r, 84532));
    const verdict = await verifySignedRequest({
      request: r,
      auth: { signer: stranger.address, chainId: 84532, signature },
      agent: clientAgent,
      now: NOW,
      verifier: noContractWallets,
    });
    expect(verdict).toEqual({ ok: false, reason: "SIGNER_NOT_AGENT_WALLET" });
  });

  it("refuses a signature under a chain the wallet is not registered on", async () => {
    // A contract wallet's address on another chain may be another contract with
    // another owner, so registration is per chain. Tempo Moderato is 42431.
    const r = request();
    const signature = await client.signTypedData(mitraRequestTypedData(r, 42431));
    const verdict = await verifySignedRequest({
      request: r,
      auth: { signer: client.address, chainId: 42431, signature },
      agent: clientAgent, // registered on base only
      now: NOW,
      verifier: noContractWallets,
    });
    expect(verdict).toEqual({ ok: false, reason: "SIGNER_NOT_AGENT_WALLET" });
  });

  it("refuses a request at or after its expiry", async () => {
    const r = request({ expiresAt: NOW });
    const signature = await client.signTypedData(mitraRequestTypedData(r, 84532));
    const verdict = await verifySignedRequest({
      request: r,
      auth: { signer: client.address, chainId: 84532, signature },
      agent: clientAgent,
      now: NOW,
      verifier: noContractWallets,
    });
    expect(verdict).toEqual({ ok: false, reason: "REQUEST_EXPIRED" });
  });

  it("refuses a signature presented with any field changed", async () => {
    const signed = request();
    const signature = await client.signTypedData(mitraRequestTypedData(signed, 84532));
    for (const changed of [
      request({ op: "acceptDeliverable" }),
      request({ agreementId: "ag_2" }),
      request({ fromStatus: "FUNDED" }),
      request({ bodyHash: `0x${"cd".repeat(32)}` }),
      request({ expiresAt: NOW + 600 }),
    ]) {
      const verdict = await verifySignedRequest({
        request: changed,
        auth: { signer: client.address, chainId: 84532, signature },
        agent: clientAgent,
        now: NOW,
        verifier: { isValidSignature: async () => "0x00000000" },
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it("accepts a contract wallet that approves the request's digest via ERC-1271", async () => {
    const wallet = "0x000000000000000000000000000000000000c0de" as const;
    const r = request();
    const expectedDigest = hashTypedData(mitraRequestTypedData(r, 84532));
    const asked: string[] = [];
    const verdict = await verifySignedRequest({
      request: r,
      auth: { signer: wallet, chainId: 84532, signature: "0x1234" },
      agent: { agentId: "agent_client", wallets: [{ chain: "base", address: wallet }] },
      now: NOW,
      verifier: {
        isValidSignature: async (contract, digest) => {
          asked.push(`${contract}:${digest}`);
          return digest === expectedDigest ? "0x1626ba7e" : "0xffffffff";
        },
      },
    });
    expect(verdict).toEqual({ ok: true, mode: "contract" });
    expect(asked).toEqual([`${wallet}:${expectedDigest}`]);
  });
});
