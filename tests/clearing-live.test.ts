/**
 * Phase 7, seam D — a whole clearing epoch, live: netted by the kernel, run through
 * MitraClearing on-chain, and its residuals paid through the execution guard and
 * MitraVault, each bound to the transfer the contract finalized.
 *
 * Gated: CLEARING_LIVE=1 (both chains) or CLEARING_LIVE=base|tempo. Uses the dev
 * key in .dev-keys/evm-testnet.key as clearing operator, vault principal and engine.
 * Decision: shared context ctx_9b9e7a8c3172e71b.
 *
 * The cycle: buyer owes data 0.03, data owes eval 0.02, eval owes buyer 0.005.
 * Gross 0.055 nets to two residuals, both from the buyer — the party whose vault
 * position this key controls.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi, http, keccak256, parseAbi,
  type Hex, type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Agent, Mandate, Obligation } from "@/lib/domain/types";
import { BASE_ASSETS } from "@/lib/adapters/base";
import { TEMPO_TOKENS } from "@/lib/adapters/tempo";
import { MITRA_VAULT_ABI } from "@/lib/adapters/evm-vault-transport";
import { toAtomic } from "@/lib/evm/eip712";
import { calculateEpoch, finalizeEpochOnce, freezeEpoch, netObligations, openEpoch, resultHash } from "@/lib/kernel/clearing";
import { RESIDUAL_CAPABILITY, residualSettlementIdFor } from "@/lib/kernel/settlement";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { __setRailsForTests, railsFromEnv } from "@/lib/settlement/rails";
import { CLEARING_ABI, CLEARING_STATUSES, __resetClearingReaderForTests, __setClearingReaderForTests, clearingReaderFromEnv, onChainEpochId } from "@/lib/settlement/clearing-reader";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";
import { POST as settlementsPOST } from "@/app/api/v1/settlements/route";

const KEY = ".dev-keys/evm-testnet.key";
const WINDOW = 30n; // seconds of challenge window on-chain

const OPERATOR_ABI = parseAbi([
  "struct TransferInstruction { address from; address to; uint128 amount; }",
  "function openEpoch(bytes32 epochId, uint64 challengeWindow)",
  "function recordObligation(bytes32 epochId, address debtor, address creditor, uint128 amount)",
  "function freezeEpoch(bytes32 epochId)",
  "function proposeResult(bytes32 epochId, TransferInstruction[] net, bytes32 resultHash)",
  "function finalizeEpoch(bytes32 epochId) returns (uint8)",
  "function recordReceipt(bytes32 epochId, uint256 transferIndex, bytes32 receiptHash)",
  "function receiptsOf(bytes32 epochId) view returns (bytes32[])",
]);
const VAULT_ADMIN_ABI = parseAbi([
  "function vaults(address principal, address token) view returns (uint256 total, uint256 available, uint256 reserved, uint256 escrowed, uint256 encumbered, uint256 settling, uint256 frozen, bool emergencyFreeze)",
  "function deposit(address token, uint256 amount)",
  "function openMandate(address holder, address token, uint64 limit, uint64 ceiling, uint64 expiresAt, address policyEngine)",
  "function amendMandate(address holder, address token, uint64 newLimit, uint64 newCeiling, uint64 newExpiresAt)",
]);

const tempoChain = (rpc: string) => defineChain({ id: 42431, name: "Tempo Moderato", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const RAILS = [
  { chain: "base" as const, network: "baseSepolia", viem: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    asset: "USDC" as const, token: BASE_ASSETS[84532].USDC.address as Hex, vaultId: "vault_base_ops",
    env: (rpc: string) => ({ BASE_RPC_URL: rpc, MITRA_BASE_SETTLEMENT_ACCOUNT: "vault" }) },
  { chain: "tempo" as const, network: "moderato", viem: tempoChain(process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz"),
    rpc: process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
    asset: "PathUSD" as const, token: TEMPO_TOKENS.PathUSD.mint as Hex, vaultId: "vault_tempo_settle",
    env: (rpc: string) => ({ TEMPO_RPC_URL: rpc, MITRA_TEMPO_SETTLEMENT_ACCOUNT: "vault" }) },
];

class LiveRepo extends InMemoryRepository {
  mandate!: Mandate;
  async getMandate(id: string) { return id === this.mandate?.mandateId ? this.mandate : super.getMandate(id); }
}

afterEach(() => {
  __setRailsForTests(null);
  __resetClearingReaderForTests();
  globalThis.__mitraStore = undefined;
});

const flag = process.env.CLEARING_LIVE ?? "";
const deployments = existsSync("lib/evm/deployments.json") ? JSON.parse(readFileSync("lib/evm/deployments.json", "utf8")) : {};

for (const rail of RAILS) {
  const live = (flag === "1" || flag === rail.chain) && existsSync(KEY) && deployments.clearing?.[rail.network]?.address && deployments[rail.network]?.address;
  describe.skipIf(!live)(`live: a clearing epoch on ${rail.chain}, residuals paid through the guard (CLEARING_LIVE)`, () => {
    it("nets a 3-party cycle, finalizes it on MitraClearing, pays both residuals through the vault, and attaches their receipts", async () => {
      const me = privateKeyToAccount(`0x${readFileSync(KEY, "utf8").trim().replace(/^0x/, "")}`);
      const derive = (label: string) => `0x${keccak256(new TextEncoder().encode(`${label}:${me.address}`)).slice(-40)}` as Hex;
      const holder = derive("mitra-vault-holder");
      const wallets = { agent_buyer_07: me.address as Hex, agent_data_03: derive("mitra-clearing-payee:data"), agent_eval_02: derive("mitra-clearing-payee:eval") };
      const clearing = deployments.clearing[rail.network].address as Hex;
      const vault = deployments[rail.network].address as Hex;
      const client = createPublicClient({ chain: rail.viem, transport: http(rail.rpc) }) as PublicClient;
      const wallet = createWalletClient({ chain: rail.viem, transport: http(rail.rpc), account: me });
      const txs: Record<string, Hex> = {};
      const write = async (label: string, args: Record<string, unknown>) => {
        const gp = await client.getGasPrice();
        const hash = await wallet.writeContract({ ...args, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp } as never);
        const r = await client.waitForTransactionReceipt({ hash });
        expect(r.status, label).toBe("success");
        for (let i = 0; i < 20 && (await client.getBlockNumber()) < r.blockNumber; i++) await new Promise((ok) => setTimeout(ok, 1000));
        txs[label] = hash;
        return r;
      };

      // ── provisioning: the buyer's vault position and its token-keyed mandate (F61) ──
      const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
      const [mPrincipal, , , ceiling, spent, expiresAt, , engine, revoked] = await client.readContract({
        address: vault, abi: MITRA_VAULT_ABI, functionName: "mandates", args: [me.address, holder, rail.token] });
      if (mPrincipal === "0x0000000000000000000000000000000000000000") {
        await write("openMandate", { address: vault, abi: VAULT_ADMIN_ABI, functionName: "openMandate", args: [holder, rail.token, 100_000n, 1_000_000n, until, me.address] });
      } else {
        expect(revoked).toBe(false);
        expect(engine.toLowerCase()).toBe(me.address.toLowerCase());
        if (expiresAt <= BigInt(Math.floor(Date.now() / 1000) + 600) || spent + 100_000n > ceiling) {
          await write("amendMandate", { address: vault, abi: VAULT_ADMIN_ABI, functionName: "amendMandate", args: [holder, rail.token, 100_000n, spent + 1_000_000n, until] });
        }
      }
      const [, available] = await client.readContract({ address: vault, abi: VAULT_ADMIN_ABI, functionName: "vaults", args: [me.address, rail.token] });
      if (available < 100_000n) {
        await write("approve", { address: rail.token, abi: erc20Abi, functionName: "approve", args: [vault, 200_000n] });
        await write("deposit", { address: vault, abi: VAULT_ADMIN_ABI, functionName: "deposit", args: [rail.token, 200_000n] });
      }

      // ── off-chain: the kernel nets the cycle ──
      const epochId = `epoch_live_${rail.chain}_${Date.now()}`;
      const now = new Date().toISOString();
      const ob = (id: string, debtor: string, creditor: string, amount: number): Obligation => ({
        obligationId: id, runId: `run_${epochId}`, debtor, creditor, amount: { asset: rail.asset, amount }, sourceEvent: "live-cycle",
        dueAt: now, priority: 1, status: "ACCEPTED", nonce: 1, version: 1,
      });
      const obligations = [
        ob(`${epochId}_1`, "agent_buyer_07", "agent_data_03", 0.03),
        ob(`${epochId}_2`, "agent_data_03", "agent_eval_02", 0.02),
        ob(`${epochId}_3`, "agent_eval_02", "agent_buyer_07", 0.005),
      ];
      const opened = openEpoch({ epochId, asset: rail.asset, settlementDomain: rail.chain, obligations, openedAt: now });
      if (!opened.ok) throw new Error(opened.reason);
      const frozen = freezeEpoch(opened.value, obligations);
      if (!frozen.ok) throw new Error(frozen.reason);
      const calculated = calculateEpoch(frozen.value, obligations);
      if (!calculated.ok) throw new Error(calculated.reason);
      const result = netObligations(obligations);
      expect(result.grossVolume).toBe(0.055);
      expect(result.residualTransfers.every((t) => t.from === "agent_buyer_07")).toBe(true);
      const commitment = `0x${resultHash(result, epochId).split(":")[1]}` as Hex;

      // ── on-chain: MitraClearing runs the same epoch ──
      const id = onChainEpochId(epochId);
      const addr = (party: string) => wallets[party as keyof typeof wallets];
      const atomic = (n: number) => toAtomic(n, 6);
      await write("openEpoch", { address: clearing, abi: OPERATOR_ABI, functionName: "openEpoch", args: [id, WINDOW] });
      for (const [i, o] of obligations.entries()) {
        await write(`recordObligation_${i}`, { address: clearing, abi: OPERATOR_ABI, functionName: "recordObligation", args: [id, addr(o.debtor), addr(o.creditor), atomic(o.amount.amount)] });
      }
      await write("freezeEpoch", { address: clearing, abi: OPERATOR_ABI, functionName: "freezeEpoch", args: [id] });
      // The root on-chain is the rolling hash of exactly what was recorded.
      let root = `0x${"00".repeat(32)}` as Hex;
      for (const o of obligations) {
        root = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint128" }],
          [root, addr(o.debtor), addr(o.creditor), atomic(o.amount.amount)]));
      }
      const onChainEpoch = await client.readContract({ address: clearing, abi: CLEARING_ABI, functionName: "epochs", args: [id] });
      expect(onChainEpoch[4], "inputsRoot is bound on-chain").toBe(root);

      const net = result.residualTransfers.map((t) => ({ from: addr(t.from), to: addr(t.to), amount: atomic(t.amount) }));
      await write("proposeResult", { address: clearing, abi: OPERATOR_ABI, functionName: "proposeResult", args: [id, net, commitment] });
      const proposed = await client.readContract({ address: clearing, abi: CLEARING_ABI, functionName: "epochs", args: [id] });
      expect(CLEARING_STATUSES[proposed[0]]).toBe("Proposed");

      // Settling before the chain finalizes is refused — the guard waits for MitraClearing.
      const repo = new LiveRepo(new CapitalLedger(seedVaults.map((v) => (v.vaultId === rail.vaultId
        ? { ...v, address: me.address, asset: rail.asset, chain: rail.chain, available: 1000, total: 1000, reserved: 0 } : v)), []));
      repo.mandate = {
        mandateId: `m_residual_${rail.chain}`, name: "pay clearing residuals", version: 1, principal: "P", agentId: "agent_buyer_07",
        vaultId: rail.vaultId, asset: rail.asset, budget: 100, maxTransaction: 1, allowedCounterparties: ["agent_data_03", "agent_eval_02"],
        allowedCapabilities: [RESIDUAL_CAPABILITY], prohibitedCapabilities: [], approvedChains: [rail.chain], policyVersion: "t",
        expiresAt: "2030-01-01T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
      };
      for (const party of ["agent_data_03", "agent_eval_02"] as const) {
        const agent = (await repo.getAgent(party)) as Agent;
        repo.__putAgentForTests({ ...agent, wallets: [...agent.wallets, { chain: rail.chain, address: wallets[party] }] });
      }
      globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });
      __setRailsForTests(await railsFromEnv({ MITRA_EVM_SETTLEMENT_KEY_FILE: KEY, MITRA_EVM_VAULT_HOLDER: holder, ...rail.env(rail.rpc) }));
      __setClearingReaderForTests(clearingReaderFromEnv(rail.env(rail.rpc)));

      const post = (h: (r: Request) => Promise<Response>, body: unknown) => h(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
      const reserve = async (i: number) => {
        const t = result.residualTransfers[i];
        const res = await post(reservationsPOST, { mandateId: repo.mandate.mandateId, vaultId: rail.vaultId, amount: t.amount, asset: rail.asset,
          chain: rail.chain, counterparty: t.to, capability: RESIDUAL_CAPABILITY, intentId: "i", runId: `run_${epochId}`,
          residual: { epochId, transferIndex: i }, now: new Date().toISOString() });
        const body = await res.json();
        expect(res.status, JSON.stringify(body)).toBe(201);
        return body.data.reservationId as string;
      };

      const finalizedOffChain = finalizeEpochOnce(calculated.value, result, []);
      if (!finalizedOffChain.ok) throw new Error(finalizedOffChain.reason);
      await repo.saveEpoch(finalizedOffChain.value);
      const early = await reserve(0);
      const refused = await (await post(settlementsPOST, { op: "settleResidual", epochId, transferIndex: 0, reservationId: early, now: new Date().toISOString() })).json();
      expect(refused.error, "the chain has not finalized yet").toBe("RESIDUAL_NOT_FINALIZED_ON_CHAIN");

      // ── the window closes; anyone may finalize ──
      const expires = Number(proposed[2]);
      while (Math.floor(Date.now() / 1000) <= expires + 2) await new Promise((ok) => setTimeout(ok, 2000));
      for (let i = 0; ; i++) {
        try {
          await write("finalizeEpoch", { address: clearing, abi: OPERATOR_ABI, functionName: "finalizeEpoch", args: [id] });
          break;
        } catch (e) {
          // The block clock can trail the wall clock by a few seconds.
          if (i >= 10) throw e;
          await new Promise((ok) => setTimeout(ok, 3000));
        }
      }

      // ── each residual: guarded settlement, confirmed from the chain, receipt attached ──
      for (const [i] of result.residualTransfers.entries()) {
        const reservationId = i === 0 ? early : await reserve(i);
        let body = await (await post(settlementsPOST, { op: "settleResidual", epochId, transferIndex: i, reservationId, now: new Date().toISOString() })).json();
        for (let k = 0; k < 30 && body.data?.settlement?.status !== "CONFIRMED"; k++) {
          await new Promise((ok) => setTimeout(ok, 2000));
          body = await (await post(settlementsPOST, { op: "confirm", settlementId: residualSettlementIdFor(epochId, i), now: new Date().toISOString() })).json();
        }
        const s = body.data?.settlement;
        console.log(`clearing ${rail.chain}: residual ${i} ${result.residualTransfers[i].from}→${result.residualTransfers[i].to} ${result.residualTransfers[i].amount} tx ${s?.txHash} ${s?.status} ${JSON.stringify(body.error ?? "")}`);
        expect(s?.status, JSON.stringify(body)).toBe("CONFIRMED");
        const receipt = await client.getTransactionReceipt({ hash: s.txHash });
        expect(receipt.to?.toLowerCase(), "paid through the vault contract").toBe(vault.toLowerCase());
        await write(`recordReceipt_${i}`, { address: clearing, abi: OPERATOR_ABI, functionName: "recordReceipt", args: [id, BigInt(i), s.txHash] });
      }

      const settled = await client.readContract({ address: clearing, abi: CLEARING_ABI, functionName: "epochs", args: [id] });
      expect(CLEARING_STATUSES[settled[0]]).toBe("Settled");
      expect((await repo.getEpoch(epochId))?.status).toBe("SETTLED");
      console.log(`clearing ${rail.chain}: epoch ${epochId} (on-chain ${id}) SETTLED. clearing ${clearing}, vault ${vault}`);
      console.log(`clearing ${rail.chain} txs: ${JSON.stringify(txs)}`);
    }, 600_000);
  });
}
