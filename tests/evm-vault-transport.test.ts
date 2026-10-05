/**
 * Package B.4, on the canonical v2 contract (`contracts/MitraVault.sol`): Mitra settles
 * THROUGH the vault (`lib/adapters/evm-vault-transport.ts`).
 *
 * Offline: the confirmation rule on transactions built from the real v2 ABI — calldata
 * AND receipt, since v2's event carries the permit digest, not Mitra's commitment — and
 * `pay()` against a scripted node: every refusal checked to send nothing, and the happy
 * path checked by decoding what was actually submitted and recovering the engine's
 * signature from it. The live runs (through the agreement route, on Base Sepolia and
 * Tempo Moderato) are gated on BASE_VAULT_LIVE / TEMPO_VAULT_LIVE below.
 */
import { describe, expect, it } from "vitest";
import {
  custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, hashTypedData,
  keccak256, parseTransaction, recoverTypedDataAddress, type Hex, type TransactionSerialized,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_ASSETS } from "@/lib/adapters/base";
import { MITRA_VAULT_ABI, MitraVaultTransport, SPEND_PERMIT_TYPES, observeVaultSpend, vaultDomain } from "@/lib/adapters/evm-vault-transport";

const VAULT = "0x9c2c2d42a1a282b665bc67f407017b7605e51e8f" as const;
const PRINCIPAL = "0x7823d6bea51cc21c5d8588c7ff72e33130848116" as const;
const HOLDER = "0x000000000000000000000000000000000000a11c" as const;
const TO = "0x1111111111111111111111111111111111111111" as const;
const USDC = BASE_ASSETS[84532].USDC.address.toLowerCase() as Hex;
const TOKENS = new Set([USDC]);
const ACTION = `0x${"ab".repeat(32)}` as Hex;
const TX = `0x${"cd".repeat(32)}`;
const CHAIN = 84532;

type Permit = { principal: Hex; holder: Hex; token: Hex; actionHash: Hex; amount: bigint; recipient: Hex; mandateVersion: number; deadline: bigint };

/** A v2 spend, as the chain records it: the submitted calldata and the receipt. */
function spend(over: {
  status?: "success" | "reverted"; to?: string; principal?: Hex; holder?: Hex; token?: Hex; amount?: bigint;
  eventFrom?: string; eventPrincipal?: Hex; eventRecipient?: Hex; eventAmount?: bigint; eventDigest?: Hex;
  transferFrom?: Hex; transferAmount?: bigint; noTransfer?: boolean; input?: Hex; chainId?: number;
} = {}) {
  const permit: Permit = {
    principal: over.principal ?? PRINCIPAL, holder: over.holder ?? HOLDER, token: over.token ?? USDC, actionHash: ACTION,
    amount: over.amount ?? 10_000n, recipient: TO, mandateVersion: 1, deadline: 2_000_000_000n,
  };
  const digest = hashTypedData({ domain: vaultDomain(CHAIN, VAULT), types: SPEND_PERMIT_TYPES, primaryType: "SpendPermit", message: permit });
  const executed = {
    address: over.eventFrom ?? VAULT,
    topics: encodeEventTopics({ abi: MITRA_VAULT_ABI, eventName: "SpendExecuted",
      args: { principal: over.eventPrincipal ?? permit.principal, recipient: over.eventRecipient ?? TO, token: permit.token } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [over.eventAmount ?? permit.amount, over.eventDigest ?? digest]),
  };
  const transfer = {
    address: permit.token,
    topics: encodeEventTopics({ abi: MITRA_VAULT_ABI, eventName: "Transfer", args: { from: over.transferFrom ?? VAULT, to: TO } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [over.transferAmount ?? permit.amount]),
  };
  return {
    txHash: TX, vault: VAULT, chainId: over.chainId ?? CHAIN, principal: PRINCIPAL, holder: HOLDER, tokens: TOKENS,
    input: over.input ?? encodeFunctionData({ abi: MITRA_VAULT_ABI, functionName: "spendAuthorized", args: [permit, "0x1234"] }),
    receipt: { status: over.status ?? ("success" as const), to: over.to ?? VAULT, blockNumber: 99n, logs: over.noTransfer ? [executed] : [transfer, executed] },
  };
}

describe("observeVaultSpend — what counts as a payment through the v2 vault", () => {
  it("a vault spend for this principal's mandate, with the tokens leaving the vault, is observed — commitment from calldata", () => {
    expect(observeVaultSpend(spend())).toEqual({
      txHash: TX, block: 99, carriedCommitment: ACTION, from: PRINCIPAL, to: TO, amountAtomic: 10_000n, asset: USDC,
    });
  });
  const refused: Array<[string, Parameters<typeof spend>[0]]> = [
    ["the transaction reverted", { status: "reverted" }],
    ["the transaction did not call the vault", { to: TO }],
    ["the calldata is not spendAuthorized", { input: encodeFunctionData({ abi: MITRA_VAULT_ABI, functionName: "mandates", args: [PRINCIPAL, HOLDER, USDC] }) }],
    ["the calldata is garbage", { input: "0xdeadbeef" }],
    ["the spend was another principal's", { principal: TO }],
    ["the calldata names another principal, whatever the event says", { principal: TO, eventPrincipal: PRINCIPAL }],
    ["the spend was under another holder's mandate", { holder: TO }],
    ["the spend paid an unregistered token", { token: TO }],
    ["no SpendExecuted was emitted by the vault", { eventFrom: TO }],
    ["the event names another principal", { eventPrincipal: TO }],
    ["the event names another recipient", { eventRecipient: PRINCIPAL }],
    ["the event's amount differs from the permit", { eventAmount: 9_999n }],
    ["the event is for a different permit (digest mismatch)", { eventDigest: `0x${"ee".repeat(32)}` }],
    ["the digest was computed for another chain", { chainId: 8453 }],
    ["no tokens moved", { noTransfer: true }],
    ["the tokens came from somewhere other than the vault", { transferFrom: PRINCIPAL }],
    ["the moved amount differs from the spend", { transferAmount: 9_999n }],
  ];
  for (const [why, over] of refused) it(`not observed when ${why}`, () => expect(observeVaultSpend(spend(over))).toBeNull());
});

type MandateTuple = readonly [Hex, Hex, bigint, bigint, bigint, bigint, number, Hex, boolean];

/** A scripted node. `mandate` is what v2's `mandates(principal, holder)` returns. */
function node(mandate: MandateTuple, chainId = 84532) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params: params ?? [] });
      switch (method) {
        case "eth_chainId": return `0x${chainId.toString(16)}`;
        case "eth_call": return encodeFunctionResult({ abi: MITRA_VAULT_ABI, functionName: "mandates", result: mandate });
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_getTransactionCount": return "0x1";
        case "eth_estimateGas": return "0x30000";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_getBlockByNumber": return { number: "0x10", baseFeePerGas: "0x1", timestamp: "0x1", hash: `0x${"1".repeat(64)}`, parentHash: `0x${"0".repeat(64)}`, gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] };
        case "eth_sendRawTransaction": return TX;
        default: throw new Error(`unscripted ${method}`);
      }
    },
  });
  return { transport, calls };
}

describe("MitraVaultTransport.pay — refuses before signing, pays exactly what was asked", () => {
  const key = privateKeyToAccount(`0x${"77".repeat(32)}`);
  const NOW = 1_800_000_000_000;
  const live = (over: Partial<{ principal: Hex; engine: Hex; limit: bigint; ceiling: bigint; spent: bigint; expires: bigint; version: number; revoked: boolean }> = {}): MandateTuple =>
    [over.principal ?? key.address, HOLDER, over.limit ?? 100_000n, over.ceiling ?? 1_000_000n, over.spent ?? 0n,
      over.expires ?? BigInt(NOW / 1000 + 3600), over.version ?? 3, over.engine ?? key.address, over.revoked ?? false];
  const make = (n: ReturnType<typeof node>) => new MitraVaultTransport({
    chain: baseSepolia, vault: VAULT, principal: key.address, holder: HOLDER, engine: key, relayer: key, tokens: TOKENS, transport: n.transport, now: () => NOW,
  });
  const ask: { to: string; token: string; amountAtomic: string; commitment: string } = { to: TO, token: USDC, amountAtomic: "10000", commitment: ACTION };

  const offline: Array<[string, Partial<typeof ask>, string]> = [
    ["a malformed recipient", { to: "0x12" }, "INVALID_RECIPIENT_ADDRESS"],
    ["a token outside the rail", { token: TO }, "UNREGISTERED_TOKEN_FOR_VAULT_RAIL"],
    ["a zero amount", { amountAtomic: "0" }, "INVALID_ATOMIC_AMOUNT"],
    ["a commitment that is not 32 bytes", { commitment: "0x1234" }, "COMMITMENT_NOT_BYTES32"],
  ];
  for (const [why, over, reason] of offline) {
    it(`refuses ${why} with no RPC call`, async () => {
      const n = node(live());
      await expect(make(n).pay({ ...ask, ...over })).rejects.toThrow(reason);
      expect(n.calls).toEqual([]);
    });
  }

  const onchain: Array<[string, Parameters<typeof live>[0], string]> = [
    ["there is no mandate (zero record)", { principal: "0x0000000000000000000000000000000000000000", version: 0 }, "MANDATE_NOT_FOUND"],
    ["the record is for another principal", { principal: TO }, "MANDATE_NOT_FOUND"],
    ["this key is not the mandate's engine", { engine: TO }, "POLICY_ENGINE_MISMATCH"],
    ["the mandate is revoked", { revoked: true }, "MANDATE_REVOKED"],
    ["the mandate has expired", { expires: BigInt(NOW / 1000) }, "MANDATE_EXPIRED"],
    // v2 never checks the limit at spend: this refusal is the only enforcement there is.
    ["the amount exceeds the mandate's limit", { limit: 9_999n }, "EXCEEDS_MANDATE_LIMIT"],
    ["the ceiling has no headroom", { ceiling: 100_000n, spent: 90_001n }, "EXCEEDS_MANDATE_CEILING"],
  ];
  for (const [why, over, reason] of onchain) {
    it(`refuses when ${why}, and sends nothing`, async () => {
      const n = node(live(over));
      await expect(make(n).pay(ask)).rejects.toThrow(reason);
      expect(n.calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
    });
  }

  it("an amount exactly at the limit, and exactly filling the ceiling, is paid", async () => {
    const n = node(live({ limit: 10_000n, ceiling: 100_000n, spent: 90_000n }));
    expect((await make(n).pay(ask)).txHash).toBe(TX);
  });

  it("reads the mandate for the token it pays (F61): a USDC ceiling is not a ceiling on any other token", async () => {
    const n = node(live());
    await make(n).pay(ask);
    const call = n.calls.find((c) => c.method === "eth_call")!;
    const { functionName, args } = decodeFunctionData({ abi: MITRA_VAULT_ABI, data: (call.params[0] as { data?: Hex; input?: Hex }).data ?? (call.params[0] as { input: Hex }).input });
    expect(functionName).toBe("mandates");
    expect((args as unknown as Hex[]).map((a) => a.toLowerCase())).toEqual([key.address.toLowerCase(), HOLDER, USDC]);
  });

  it("refuses a node on another chain", async () => {
    const n = node(live(), 8453);
    await expect(make(n).pay(ask)).rejects.toThrow("CHAIN_MISMATCH");
  });

  it("submits spendAuthorized with the permit it was asked for, signed by the engine under the v2 domain", async () => {
    const n = node(live());
    expect((await make(n).pay(ask)).txHash).toBe(TX);
    const raw = n.calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as TransactionSerialized;
    const tx = parseTransaction(raw);
    expect(tx.to?.toLowerCase()).toBe(VAULT);
    const { functionName, args } = decodeFunctionData({ abi: MITRA_VAULT_ABI, data: tx.data! });
    expect(functionName).toBe("spendAuthorized");
    const [permit, sig] = args as unknown as [Permit, Hex];
    expect(permit).toMatchObject({ principal: key.address, holder: HOLDER, actionHash: ACTION, amount: 10_000n, recipient: TO, mandateVersion: 3, deadline: BigInt(NOW / 1000 + 900) });
    expect(permit.token.toLowerCase()).toBe(USDC);
    const signer = await recoverTypedDataAddress({
      domain: { name: "MitraVault", version: "1", chainId: 84532, verifyingContract: VAULT },
      types: SPEND_PERMIT_TYPES, primaryType: "SpendPermit", message: permit, signature: sig,
    });
    expect(signer).toBe(key.address);

    // What pay() submitted is what observe() accepts, given the vault's v2 receipt —
    // the commitment recovered from calldata, the event bound by the permit digest.
    const digest = hashTypedData({ domain: vaultDomain(84532, VAULT), types: SPEND_PERMIT_TYPES, primaryType: "SpendPermit", message: permit });
    const logs = [
      { address: VAULT, topics: encodeEventTopics({ abi: MITRA_VAULT_ABI, eventName: "SpendExecuted", args: { principal: key.address, recipient: TO, token: USDC } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [10_000n, digest]) },
      { address: USDC, topics: encodeEventTopics({ abi: MITRA_VAULT_ABI, eventName: "Transfer", args: { from: VAULT, to: TO } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }], [10_000n]) },
    ];
    expect(observeVaultSpend({ txHash: TX, vault: VAULT, chainId: 84532, principal: key.address, holder: HOLDER, tokens: TOKENS, input: tx.data!,
      receipt: { status: "success", to: VAULT, blockNumber: 7n, logs } })?.carriedCommitment).toBe(ACTION);
  });
});

// ── LIVE: an ACCEPTED agreement settles THROUGH the deployed vault ───────────

import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, type PublicClient } from "viem";
import { afterEach } from "vitest";
import type { Agreement, Mandate as MitraMandate, Space } from "@/lib/domain/types";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { TEMPO_TOKENS } from "@/lib/adapters/tempo";
import { __setRailsForTests, railsFromEnv } from "@/lib/settlement/rails";
import { AGREEMENT_PAYMENT_CAPABILITY, settlementIdFor } from "@/lib/kernel/settlement";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";
import { POST as settlementsPOST } from "@/app/api/v1/settlements/route";
import { GET as evidenceGET } from "@/app/api/v1/settlements/evidence/route";

const KEY = ".dev-keys/evm-testnet.key";
/** v2's principal-side surface (contracts/MitraVault.sol). */
const VAULT_ADMIN_ABI = parseAbi([
  "function vaults(address principal, address token) view returns (uint256 total, uint256 available, uint256 reserved, uint256 escrowed, uint256 encumbered, uint256 settling, uint256 frozen, bool emergencyFreeze)",
  "function deposit(address token, uint256 amount)",
  "function openMandate(address holder, address token, uint64 limit, uint64 ceiling, uint64 expiresAt, address policyEngine)",
  "function amendMandate(address holder, address token, uint64 newLimit, uint64 newCeiling, uint64 newExpiresAt)",
]);
/** The canonical (v2) deployment for a chain: never a `__callerVariant` entry. */
const canonical = (deployments: Record<string, { chainId?: number; address?: string }>, chainId: number) =>
  Object.entries(deployments).find(([k, v]) => !k.includes("__") && v.chainId === chainId)?.[1];
const tempoChain = (rpc: string) => defineChain({ id: 42431, name: "Tempo Moderato", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

const LIVE_RAILS = [
  { chain: "base" as const, flag: "BASE_VAULT_LIVE", viem: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    asset: "USDC" as const, token: BASE_ASSETS[84532].USDC.address, vaultId: "vault_base_ops", gasMult: 1n,
    env: (rpc: string) => ({ BASE_RPC_URL: rpc, MITRA_BASE_SETTLEMENT_ACCOUNT: "vault" }) },
  { chain: "tempo" as const, flag: "TEMPO_VAULT_LIVE", viem: tempoChain(process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz"), rpc: process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
    asset: "PathUSD" as const, token: TEMPO_TOKENS.PathUSD.mint, vaultId: "vault_tempo_settle", gasMult: 2n,
    env: (rpc: string) => ({ TEMPO_RPC_URL: rpc, MITRA_TEMPO_SETTLEMENT_ACCOUNT: "vault" }) },
];

class LiveRepo extends InMemoryRepository {
  mandate!: MitraMandate;
  async getMandate(id: string) { return id === this.mandate?.mandateId ? this.mandate : super.getMandate(id); }
}

afterEach(() => { __setRailsForTests(null); globalThis.__mitraStore = undefined; });

for (const rail of LIVE_RAILS) {
  const deployments = existsSync("lib/evm/deployments.json") ? JSON.parse(readFileSync("lib/evm/deployments.json", "utf8")) : {};
  const live = process.env[rail.flag] === "1" && existsSync(KEY) && canonical(deployments, rail.viem.id);
  describe.skipIf(!live)(`live: an ACCEPTED agreement settles through MitraVault v2 on ${rail.chain} (${rail.flag}=1)`, () => {
    it("pays through spendAuthorized, confirms from the chain, and the evidence verifies", async () => {
      const me = privateKeyToAccount(`0x${readFileSync(KEY, "utf8").trim().replace(/^0x/, "")}`);
      const holder = `0x${keccak256(new TextEncoder().encode(`mitra-vault-holder:${me.address}`)).slice(-40)}` as Hex;
      const vaultAddr = canonical(deployments, rail.viem.id)!.address as Hex;
      const client = createPublicClient({ chain: rail.viem, transport: http(rail.rpc) }) as PublicClient;
      const wallet = createWalletClient({ chain: rail.viem, transport: http(rail.rpc), account: me });
      const gp = await client.getGasPrice();
      const write = async (args: Record<string, unknown>) => {
        const hash = await wallet.writeContract({ ...args, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp } as never);
        const r = await client.waitForTransactionReceipt({ hash });
        expect(r.status).toBe("success");
        for (let i = 0; i < 20 && (await client.getBlockNumber()) < r.blockNumber; i++) await new Promise((ok) => setTimeout(ok, 1000));
      };

      // One-time, conditional provisioning: a mandate for `holder` with headroom, and capital in the position.
      // v2 opens a (principal, holder) mandate once; after that it is amended, never reopened.
      const [mPrincipal, , , ceiling, spent, expiresAt, , engine, revoked] = await client.readContract({ address: vaultAddr, abi: MITRA_VAULT_ABI, functionName: "mandates", args: [me.address, holder, rail.token as Hex] });
      const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
      if (mPrincipal === "0x0000000000000000000000000000000000000000") {
        await write({ address: vaultAddr, abi: VAULT_ADMIN_ABI, functionName: "openMandate", args: [holder, rail.token as Hex, 100_000n, 1_000_000n, until, me.address] });
      } else {
        expect(revoked, "the test holder's mandate was revoked; derive a new holder").toBe(false);
        expect(engine.toLowerCase()).toBe(me.address.toLowerCase());
        if (expiresAt <= BigInt(Math.floor(Date.now() / 1000) + 600) || spent + 10_000n > ceiling) {
          await write({ address: vaultAddr, abi: VAULT_ADMIN_ABI, functionName: "amendMandate", args: [holder, rail.token as Hex, 100_000n, spent + 1_000_000n, until] });
        }
      }
      const [, available] = await client.readContract({ address: vaultAddr, abi: VAULT_ADMIN_ABI, functionName: "vaults", args: [me.address, rail.token as Hex] });
      if (available < 10_000n) {
        await write({ address: rail.token, abi: erc20Abi, functionName: "approve", args: [vaultAddr, 100_000n] });
        await write({ address: vaultAddr, abi: VAULT_ADMIN_ABI, functionName: "deposit", args: [rail.token, 100_000n] });
      }

      // Mitra: the vault record names the principal whose position pays.
      const repo = new LiveRepo(new CapitalLedger(seedVaults.map((v) => (v.vaultId === rail.vaultId ? { ...v, address: me.address, asset: rail.asset, available: 1000, total: 1000, reserved: 0 } : v)), []));
      repo.mandate = {
        mandateId: `m_${rail.chain}_vault`, name: "pay providers through the vault", version: 1, principal: "P", agentId: "agent_buyer_07",
        vaultId: rail.vaultId, asset: rail.asset, budget: 100, maxTransaction: 10, allowedCounterparties: ["provider_alpha"],
        allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY], prohibitedCapabilities: [], approvedChains: [rail.chain],
        policyVersion: "t", expiresAt: "2030-01-01T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
      };
      await repo.updateSpace({ spaceId: "space_vault_live", owner: "agent_buyer_07", status: "ACTIVE", participants: ["agent_buyer_07", "provider_alpha"],
        allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY], settlementChains: [rail.chain], budget: { asset: rail.asset, amount: 100 },
        committed: { asset: rail.asset, amount: 0 }, version: 1, createdAt: new Date().toISOString() } as unknown as Space);
      globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });
      __setRailsForTests(await railsFromEnv({ MITRA_EVM_SETTLEMENT_KEY_FILE: KEY, MITRA_EVM_VAULT_HOLDER: holder, ...rail.env(rail.rpc) }));

      const id = `ag_vault_${rail.chain}_${Date.now()}`;
      const agreement: Agreement = {
        agreementId: id, spaceIds: ["space_vault_live"], runId: `run_${id}`, intentId: "i", client: "agent_buyer_07", provider: "provider_alpha",
        externalJobRefs: [], price: { asset: rail.asset, amount: 0.01 }, deadline: "2030-01-01T00:00:00Z", acceptanceCriteria: [],
        failurePolicy: "refund", status: "ACCEPTED", escrowReleased: true, payTo: { chain: rail.chain, address: me.address }, version: 5,
      };
      await repo.saveAgreement(agreement);
      const now = new Date().toISOString();
      const post = (h: (r: Request) => Promise<Response>, body: unknown) => h(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
      const rr = await post(reservationsPOST, { mandateId: repo.mandate.mandateId, vaultId: rail.vaultId, amount: 0.01, asset: rail.asset, chain: rail.chain,
        counterparty: "provider_alpha", capability: AGREEMENT_PAYMENT_CAPABILITY, intentId: "i", runId: agreement.runId, agreementId: id, now });
      const r = await rr.json();
      expect(rr.status, JSON.stringify(r)).toBe(201);

      let body = await (await post(settlementsPOST, { op: "settle", agreementId: id, reservationId: r.data.reservationId, now })).json();
      for (let i = 0; i < 30 && body.data?.settlement?.status !== "CONFIRMED"; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        body = await (await post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor(id), now: new Date().toISOString() })).json();
      }
      const s = body.data?.settlement;
      console.log(`live vault rail ${rail.chain}: ${s?.settlementId} tx ${s?.txHash} status ${s?.status} ${JSON.stringify(body.error ?? "")}`);
      expect(s.status).toBe("CONFIRMED");
      expect(s.from.toLowerCase()).toBe(me.address.toLowerCase());

      const ev = await (await evidenceGET(new Request(`http://localhost/api/v1/settlements/evidence?settlementId=${s.settlementId}`))).json();
      console.log(`live vault rail ${rail.chain} evidence: ${JSON.stringify(ev.data?.verdict ?? ev)}`);
      expect(ev.data.verdict).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
      const receipt = await client.getTransactionReceipt({ hash: s.txHash });
      expect(receipt.to?.toLowerCase(), "the payment called the vault contract").toBe(vaultAddr.toLowerCase());
    }, 240_000);
  });
}
