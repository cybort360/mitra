/**
 * Sprint item 6: the CALLER VARIANT (`contracts/src/MitraVault.sol`), live on its
 * deployments — `baseSepolia__callerVariant` / `moderato__callerVariant` in
 * lib/evm/deployments.json. The canonical v2 contract (`contracts/MitraVault.sol`) is
 * exercised live through the settlement route in tests/evm-vault-transport.test.ts.
 *
 * The contract's own suite is Foundry (`cd contracts && forge test`); this file
 * exercises the DEPLOYED bytecode on Base Sepolia (BASE_VAULT_LIVE=1) and Tempo
 * Moderato (TEMPO_VAULT_LIVE=1): deposit, open a mandate, an engine-signed permit
 * whose actionHash is a real Mitra settlement commitment, submitted by a relayer —
 * then the F51 refusals asked of the chain itself by simulation (eth_call), so a
 * refusal costs nothing and changes nothing.
 *
 * One key plays principal, engine and relayer on testnet (the relayer key, seq 55);
 * the holder and payee are fresh addresses, so a payee balance change can only come
 * from the vault.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, type Abi, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_ASSETS, settlementCommitment } from "@/lib/adapters/base";
import { TEMPO_TOKENS, tempoCommitment } from "@/lib/adapters/tempo";

const KEY = ".dev-keys/evm-testnet.key";
const ARTIFACT = "contracts/out/src/MitraVault.sol/MitraVault.json";
const deployments = existsSync("lib/evm/deployments.json") ? JSON.parse(readFileSync("lib/evm/deployments.json", "utf8")) : {};

const tempo = defineChain({
  id: 42431, name: "Tempo Moderato", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: [process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz"] } },
});

const RAILS = [
  {
    name: "Base Sepolia", flag: "BASE_VAULT_LIVE", chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    token: BASE_ASSETS[84532].USDC.address, chainId: 84532, deployment: "baseSepolia__callerVariant",
    commit: (i: { settlementId: string; from: string; to: string; amount: number }) =>
      settlementCommitment({ ...i, asset: "USDC", chainId: 84532 }),
  },
  {
    name: "Tempo Moderato", flag: "TEMPO_VAULT_LIVE", chain: tempo, rpc: process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
    token: TEMPO_TOKENS.PathUSD.mint, chainId: 42431, deployment: "moderato__callerVariant",
    commit: (i: { settlementId: string; from: string; to: string; amount: number }) =>
      tempoCommitment({ ...i, amount: { asset: "PathUSD", amount: i.amount }, network: "moderato" }),
  },
] as const;

for (const rail of RAILS) {
  const live = process.env[rail.flag] === "1" && existsSync(KEY) && existsSync(ARTIFACT) && deployments[rail.deployment];
  describe.skipIf(!live)(`live MitraVault on ${rail.name} (${rail.flag}=1)`, () => {
    it("pays exactly what the engine authorized, to exactly whom; and refuses replay, strangers and redirection", async () => {
      const abi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi as Abi;
      const vault = deployments[rail.deployment].address as Hex;
      const me = privateKeyToAccount(`0x${readFileSync(KEY, "utf8").trim().replace(/^0x/, "")}`);
      const stranger = privateKeyToAccount(`0x${"55".repeat(32)}`);
      const client = createPublicClient({ chain: rail.chain, transport: http(rail.rpc) }) as PublicClient;
      // Tempo's eth_gasPrice lags (scripts/tempo-pay.mjs): pay 2x on both rails.
      const gasPrice = await client.getGasPrice();
      const wallet = createWalletClient({ chain: rail.chain, transport: http(rail.rpc), account: me });
      const send = async (args: Parameters<typeof wallet.writeContract>[0]) => {
        const hash = await wallet.writeContract({ ...args, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice } as never);
        const r = await client.waitForTransactionReceipt({ hash });
        expect(r.status, `${String(args.functionName)} ${hash}`).toBe("success");
        return r;
      };
      // Every read is pinned to the block of the write it depends on: public RPCs are
      // load-balanced, and an unpinned read can land on a node that has not seen it.
      const at = (r: { blockNumber: bigint }) => ({ blockNumber: r.blockNumber });
      // A node behind the pinned block answers "not found": that is the node, not the
      // contract, so retry — and only that.
      const pinned = async <T,>(f: () => Promise<T>): Promise<T> => {
        for (let i = 0; ; i++) {
          try { return await f(); } catch (e) {
            if (i < 20 && /not found|unknown block|header not found/i.test((e as Error).message)) { await new Promise((ok) => setTimeout(ok, 1000)); continue; }
            throw e;
          }
        }
      };

      const salt = Date.now().toString(16);
      const holder = `0x${("40" + salt).padEnd(40, "0")}` as Hex;
      const payee = `0x${("fe" + salt).padEnd(40, "0")}` as Hex;
      const amount = 10_000n; // 0.01 at 6 decimals

      const approved = await send({ address: rail.token as Hex, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
      // The deposit's gas estimate must also see the approve: wait until a node at
      // least at that block answers.
      for (let i = 0; i < 20 && (await client.getBlockNumber()) < approved.blockNumber; i++) await new Promise((ok) => setTimeout(ok, 1000));
      for (let i = 0; i < 20; i++) {
        if (await client.readContract({ address: rail.token as Hex, abi: erc20Abi, functionName: "allowance", args: [me.address, vault] }) >= amount) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      await send({ address: vault, abi, functionName: "deposit", args: [rail.token, amount] });
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const opened = await send({ address: vault, abi, functionName: "openMandate", args: [holder, me.address, rail.token, amount, amount * 2n, expiresAt] });
      const m = await pinned(() => client.readContract({ address: vault, abi, functionName: "mandates", args: [me.address, holder], ...at(opened) })) as readonly unknown[];
      const version = m[6] as bigint;

      // The action hash is a real Mitra settlement commitment for this payment.
      const actionHash = rail.commit({ settlementId: `set_vault_${salt}`, from: vault, to: payee, amount: 0.01 }) as Hex;
      const permit = { principal: me.address, holder, token: rail.token as Hex, actionHash, amount, recipient: payee, mandateVersion: version, deadline: expiresAt };
      const domain = { name: "MitraVault", version: "1", chainId: rail.chainId, verifyingContract: vault };
      const types = { SpendPermit: [
        { name: "principal", type: "address" }, { name: "holder", type: "address" }, { name: "token", type: "address" },
        { name: "actionHash", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "recipient", type: "address" },
        { name: "mandateVersion", type: "uint64" }, { name: "deadline", type: "uint64" },
      ] } as const;
      const engineSig = await me.signTypedData({ domain, types, primaryType: "SpendPermit", message: permit });
      // The contract's digest and viem's EIP-712 digest must agree, or nothing below means anything.
      expect(await pinned(() => client.readContract({ address: vault, abi, functionName: "permitDigest", args: [permit], ...at(opened) })))
        .toBe((await import("viem")).hashTypedData({ domain, types, primaryType: "SpendPermit", message: permit }));

      let pin = at(opened);
      const simulateRevert = async (p: typeof permit, sig: Hex) => {
        try { await pinned(() => client.simulateContract({ address: vault, abi, functionName: "spendAuthorized", args: [p, sig], account: me, ...pin })); return "NO_REVERT"; }
        catch (e) { return (e as { cause?: { data?: { errorName?: string } } }).cause?.data?.errorName ?? (e as Error).message.slice(0, 80); }
      };
      const strangerSig = await stranger.signTypedData({ domain, types, primaryType: "SpendPermit", message: permit });
      expect(await simulateRevert(permit, strangerSig), "F51b on chain: only the mandate's engine").toBe("EngineSignatureInvalid");
      expect(await simulateRevert({ ...permit, recipient: me.address }, engineSig), "F51c on chain: no redirection").toBe("EngineSignatureInvalid");

      const spentReceipt = await send({ address: vault, abi, functionName: "spendAuthorized", args: [permit, engineSig] });
      const tx = spentReceipt.transactionHash;
      pin = at(spentReceipt);
      const paid = await pinned(() => client.readContract({ address: rail.token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [payee], ...pin }));
      console.log(`live MitraVault ${rail.name}: spendAuthorized ${tx}, payee ${payee} balance ${paid}`);
      expect(paid).toBe(amount);

      const spent = spentReceipt.logs.find((l) => l.address.toLowerCase() === vault.toLowerCase());
      expect(spent, "SpendExecuted is emitted by the vault").toBeDefined();
      expect(spent!.data.toLowerCase()).toContain(actionHash.slice(2).toLowerCase());

      // The ceiling is two payments, so only single-use can stop this replay.
      expect(await simulateRevert(permit, engineSig), "single use, on chain").toBe("AlreadyConsumed");
      void parseAbi;
    }, 180_000);
  });
}
