/**
 * Proof, on an anvil fork of Base Sepolia, that the engine pays from a CUSTOMER'S vault:
 * a principal that is not the engine funds its position in the canonical MitraVault and
 * opens a card for an agent naming the engine; the agent registers itself; the owner
 * syncs the card (POST /api/v1/vaults/sync); a reservation and a settlement go through the
 * real routes and the real vault transport. The assertions read the CHAIN afterwards.
 *
 * Run (anvil fork on :8546):  FORK_RPC=http://127.0.0.1:8546 npx tsx scripts/fork-vault-owner-pays.ts
 * Fork only: it writes token balances with anvil_setStorageAt, which a real node refuses.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const VAULT = "0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// anvil's well-known dev accounts: nothing here is a real key.
const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ENGINE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const engine = privateKeyToAccount(ENGINE_KEY);
const PAYEE = "0x1111111111111111111111111111111111111111";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const vaultAbi = parseAbi([
  "function deposit(address,uint256)",
  "function openMandate(address,address,uint64,uint64,uint64,address)",
  "function vaults(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function mandates(address,address,address) view returns (address,address,uint64,uint64,uint64,uint64,uint32,address,bool)",
]);

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};
const post = async (handler: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await handler(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

async function main() {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const test = createTestClient({ chain: baseSepolia, mode: "anvil", transport: http(RPC) });
  const asOwner = createWalletClient({ account: owner, chain: baseSepolia, transport: http(RPC) });

  // ── on chain, as the customer: fund the vault, open a card naming the engine ──
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner.address, 9n]));
  await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(100_000_000n)) });
  const wait = async (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash });
  await wait(await asOwner.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [VAULT, 50_000_000n] }));
  await wait(await asOwner.writeContract({ address: VAULT, abi: vaultAbi, functionName: "deposit", args: [USDC, 50_000_000n] }));
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  await wait(await asOwner.writeContract({
    address: VAULT, abi: vaultAbi, functionName: "openMandate",
    args: [agent.address, USDC, 10_000_000n, 40_000_000n, expiresAt, engine.address],
  }));
  console.log(`customer ${owner.address} funded 50 USDC and opened a 10/40 card for ${agent.address}, engine ${engine.address}`);

  // ── the engine, configured as on Fly: its own key, vault mode, this RPC ──────
  const keyFile = join(mkdtempSync(join(tmpdir(), "mitra-fork-")), "engine.key");
  writeFileSync(keyFile, ENGINE_KEY, { mode: 0o600 });
  Object.assign(process.env, { MITRA_EVM_SETTLEMENT_KEY_FILE: keyFile, BASE_RPC_URL: RPC, MITRA_BASE_SETTLEMENT_ACCOUNT: "vault" });
  delete process.env.DATABASE_URL;
  delete process.env.MITRA_EVM_VAULT_HOLDER;

  const { POST: agentsPOST } = await import("@/app/api/v1/agents/route");
  const { POST: syncPOST } = await import("@/app/api/v1/vaults/sync/route");
  const { POST: reservationsPOST } = await import("@/app/api/v1/reservations/route");
  const { POST: settlementsPOST } = await import("@/app/api/v1/settlements/route");
  const { mitraRequestTypedData, registrationRequest } = await import("@/lib/identity/signed-request");
  const { syncRequest } = await import("@/lib/kernel/card-sync");
  const { getStore } = await import("@/lib/store/provider");
  const { AGREEMENT_PAYMENT_CAPABILITY } = await import("@/lib/kernel/settlement");

  // 1. the agent registers itself, signed by its own wallet (F55)
  const draft = { agentId: "agent_fork_buyer", name: "Fork buyer", owner: owner.address, wallets: [{ chain: "base", address: agent.address }], capabilities: ["research"], protocols: ["mcp"] };
  const regExp = Math.floor(Date.now() / 1000) + 300;
  const regSig = await agent.signTypedData(mitraRequestTypedData(registrationRequest(draft, regExp), 84532));
  const reg = await post(agentsPOST, { agent: draft, expiresAt: regExp, proofs: [{ signer: agent.address, chainId: 84532, signature: regSig }] });
  check("agent registered itself", reg.status === 201, `HTTP ${reg.status}`);

  // 2. the owner syncs the card
  const card = {
    chain: "base" as const, principal: owner.address, holder: agent.address, agentId: draft.agentId,
    capabilities: [AGREEMENT_PAYMENT_CAPABILITY, "research"], counterparties: ["*"], issuedAt: Math.floor(Date.now() / 1000),
  };
  const syncSig = await owner.signTypedData(mitraRequestTypedData(syncRequest(card), 84532));
  const sync = await post(syncPOST, { card, auth: { signer: owner.address, chainId: 84532, signature: syncSig } });
  check("owner synced the card", sync.status === 200, sync.status === 200 ? `vault ${sync.body.data.vaultWrite}, budget ${sync.body.data.mandate.budget}, cap ${sync.body.data.mandate.maxTransaction}` : JSON.stringify(sync.body));
  if (sync.status !== 200) return;
  const { vault, mandate } = sync.body.data;

  // 3. an ACCEPTED agreement to pay (stored directly: the agreement lifecycle has its own suite)
  const { repo } = await getStore();
  await repo.saveAgreement!({
    agreementId: "ag_fork_1", spaceIds: [], runId: "run_fork_1", intentId: "intent_fork_1", client: draft.agentId,
    provider: "provider_fork", externalJobRefs: [], price: { asset: "USDC", amount: 7 }, deadline: "2027-01-01T00:00:00Z",
    acceptanceCriteria: ["done"], failurePolicy: "refund", status: "ACCEPTED", escrowReleased: true,
    payTo: { chain: "base", address: PAYEE }, version: 5,
  } as never);

  const before = {
    position: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "vaults", args: [owner.address, USDC] }),
    payee: await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [PAYEE] }),
    engineVault: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "vaults", args: [engine.address, USDC] }),
  };

  // 4. over the per-payment cap: refused by policy before anything is reserved
  const tooMuch = await post(reservationsPOST, {
    mandateId: mandate.mandateId, vaultId: vault.vaultId, amount: 12, asset: "USDC", chain: "base",
    counterparty: "provider_fork", capability: AGREEMENT_PAYMENT_CAPABILITY, intentId: "intent_x", runId: "run_x",
  });
  check("12 USDC (over the 10 cap) is refused by policy", tooMuch.status === 403 && tooMuch.body.reasonCodes?.includes("MAX_TRANSACTION_EXCEEDED"), JSON.stringify(tooMuch.body.reasonCodes));

  // 5. reserve and settle the agreement
  const res = await post(reservationsPOST, {
    mandateId: mandate.mandateId, vaultId: vault.vaultId, amount: 7, asset: "USDC", chain: "base",
    counterparty: "provider_fork", capability: AGREEMENT_PAYMENT_CAPABILITY, intentId: "intent_fork_1", runId: "run_fork_1",
    agreementId: "ag_fork_1",
  });
  check("7 USDC reserved", res.status === 201 || res.status === 200, `HTTP ${res.status} ${res.status >= 300 ? JSON.stringify(res.body) : ""}`);
  const reservationId = res.body.data?.reservationId;
  const paid = await post(settlementsPOST, { op: "settle", agreementId: "ag_fork_1", reservationId });
  let s = paid.body.data?.settlement;
  check("settlement submitted from the customer's vault", (paid.status === 200 || paid.status === 202) && !!s?.txHash, `HTTP ${paid.status} ${s ? `${s.status} tx ${s.txHash}` : JSON.stringify(paid.body)}`);
  // `pay` returns once the transaction is sent; confirmation reads the chain. A settlement
  // left SUBMITTED is confirmed later, through the rail bound to the same vault.
  for (let i = 0; i < 5 && s?.status === "SUBMITTED"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await post(settlementsPOST, { op: "confirm", settlementId: s.settlementId });
    s = c.body.data?.settlement ?? s;
  }
  check("settlement CONFIRMED from the chain", s?.status === "CONFIRMED", `${s?.status}, evidence ${s?.evidenceLevel}`);
  check("settlement names the customer as payer", s?.from?.toLowerCase() === owner.address.toLowerCase(), s?.from);

  // 6. the chain, independently
  const after = {
    position: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "vaults", args: [owner.address, USDC] }),
    payee: await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [PAYEE] }),
    engineVault: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "vaults", args: [engine.address, USDC] }),
    mandate: await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "mandates", args: [owner.address, agent.address, USDC] }),
  };
  check("the customer's vault position fell by exactly 7 USDC", before.position[1] - after.position[1] === 7_000_000n, `${before.position[1]} -> ${after.position[1]}`);
  check("the payee received exactly 7 USDC", after.payee - before.payee === 7_000_000n);
  check("the card's on-chain spend is 7 USDC", after.mandate[4] === 7_000_000n);
  check("the engine's own vault position did not move", after.engineVault[1] === before.engineVault[1]);
  if (s?.txHash) {
    const rc = await pub.getTransactionReceipt({ hash: s.txHash });
    check("the transaction went to the vault contract, from the engine (relayer)", rc.to?.toLowerCase() === VAULT && rc.from.toLowerCase() === engine.address.toLowerCase(), `to ${rc.to} from ${rc.from}`);
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("ERROR", e);
    process.exit(1);
  });
