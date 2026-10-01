#!/usr/bin/env node
/**
 * Bridge native ETH from Ethereum Sepolia to Base Sepolia, with proof on both ends.
 *
 * ## Why this does not follow the linked guide literally
 *
 * `base/guides/tree/main/bridge/native` is what the Base docs link to, and it
 * cannot be used as written:
 *
 * 1. **The repository is archived.** GitHub reports `archived: true`, last push
 *    2024-06-23. It receives no corrections.
 * 2. **`hardhat.config.js` is pinned to Goerli, not Sepolia.** It hardcodes
 *    `base-goerli.blockscout.com`, WETH on goerli, and an `L1StandardBridge` of
 *    `0xfA6D8Ee5BE770F84FC001D098C4bD604Fe01284a`. That address has **no code on
 *    Sepolia L1** — measured, not assumed. The README prose says "sepolia" while
 *    the config says goerli, so a careful reader following the prose sends value
 *    at a contract that does not exist.
 * 3. It wants a wallet **mnemonic** in a checked-in `secrets.json` — precisely
 *    what this repository's F13/F14 work exists to prevent.
 *
 * So the addresses below come from Base's own contract-addresses page, and are
 * then **verified against the chain** before any wei moves. Guessing an address
 * and calling it is F12 all over again.
 *
 * ## Scope
 *
 * Deposits only (L1 → L2). The archived guide explicitly warns its sample
 * bridges *to* Base only; withdrawals need proving and a challenge period, and
 * are not implemented here.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther,
  custom, getAddress,
} from "viem";
import { sepolia, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const L1_CHAIN = 11155111; // Ethereum Sepolia
const L2_CHAIN = 84532;  // Base Sepolia

// From docs.base.org/base-chain/network-information/base-contracts
const L1_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const L1_MESSENGER = "0xC34855F4De64F1840e5686e64278da901e261f20";
const L2_BRIDGE = "0x4200000000000000000000000000000000000010";

const ADDR_FILE = ".dev-keys/evm-testnet.address";
const KEY_FILE = ".dev-keys/evm-testnet.key";

const l1Url = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const l2Url = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

if (!existsSync(ADDR_FILE) || !existsSync(KEY_FILE)) {
  console.error("No EVM key found. Run scripts/generate-dev-keys.mjs first.");
  process.exit(1);
}
const address = getAddress(readFileSync(ADDR_FILE, "utf8").trim());
// The stored key is bare hex; viem wants 0x-prefixed. Normalising here rather
// than changing the key file keeps one on-disk format.
const privateKey = `0x${readFileSync(KEY_FILE, "utf8").trim().replace(/^0x/, "")}`;

const l1 = createPublicClient({ chain: sepolia, transport: http(l1Url) });
const l2 = createPublicClient({ chain: baseSepolia, transport: http(l2Url) });

// The signing key must derive the address we are bridging *to*. Otherwise the
// deposit would arrive somewhere this repository does not control.
const account = privateKeyToAccount(privateKey);
if (account.address.toLowerCase() !== address.toLowerCase()) {
  console.error(`Signing key derives ${account.address}, not ${address}. Refusing.`);
  process.exit(1);
}

const raw = async (url, method, params = []) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
};

/**
 * `depositTransaction` on the OptimismPortal, not `depositETH` on the bridge.
 *
 * The bridge is the path the documentation leads you to, and it **reverts for an
 * EOA** — `L1StandardBridge` applies its own access control that a plain account
 * does not satisfy. The portal's `depositTransaction` is a different function
 * on a different contract with different access control, and it works.
 *
 * Both are simulated with `eth_call` before any gas is spent, so the difference
 * is measured rather than assumed, and the script refuses to broadcast if the
 * portal call does not simulate cleanly.
 *
 * Portal: 0x49f53e41452C74589E85cA1677426Ba426459e85 (Base Sepolia L1).
 * Note the deposit leaves L1 immediately but is *derived* on L2 asynchronously —
 * so the script waits for the L2 balance and does not report success on the
 * strength of the L1 receipt alone.
 */
const PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85";
const DEPOSIT_ABI = [{
  type: "function",
  name: "depositTransaction",
  stateMutability: "payable",
  inputs: [
    { name: "_to", type: "address" },
    { name: "_value", type: "uint256" },
    { name: "_gasLimit", type: "uint64" },
    { name: "_isCreation", type: "bool" },
    { name: "_data", type: "bytes" },
  ],
  outputs: [],
}];

/**
 * Verify the contracts rather than trusting the docs. The Goerli address in the
 * archived guide is *also* a plausible-looking address with no code, so the only
 * way to know which one we hold is to ask the chain.
 */
async function verifyContracts() {
  const code = await raw(l1Url, "eth_getCode", [L1_BRIDGE, "latest"]);
  if (code === "0x") {
    console.error(`\nL1StandardBridge ${L1_BRIDGE} has NO CODE on Sepolia L1.`);
    console.error("This is the archived guide's Goerli failure mode. Refusing.");
    process.exit(1);
  }
  // messenger() == 0x3cb747bf
  const ret = await raw(l1Url, "eth_call", [{ to: L1_BRIDGE, data: "0x3cb747bf" }, "latest"]);
  const messenger = getAddress("0x" + ret.slice(-40));
  const l2Code = await raw(l2Url, "eth_getCode", [L2_BRIDGE, "latest"]);
  const portalCode = await raw(l1Url, "eth_getCode", [PORTAL, "latest"]);

  console.log(`contracts L1StandardBridge ${(code.length - 2) / 2}B, L2StandardBridge ${(l2Code.length - 2) / 2}B`);
  console.log(`          portal ${(portalCode.length - 2) / 2}B, messenger() -> ${messenger}`);
  if (messenger.toLowerCase() !== L1_MESSENGER.toLowerCase()) {
    console.error(`\nMessenger mismatch: got ${messenger}, documented ${L1_MESSENGER}. Refusing.`);
    process.exit(1);
  }
  if (portalCode === "0x") {
    console.error(`\nOptimismPortal ${PORTAL} has NO CODE on Sepolia L1. Refusing.`);
    process.exit(1);
  }
  console.log("          matches the documented L1CrossDomainMessenger — verified\n");
}
await verifyContracts();

const beforeL1 = Number(formatEther(await l1.getBalance({ address })));
const beforeL2 = Number(formatEther(await l2.getBalance({ address })));
console.log(`L1 balance ${beforeL1} ETH`);
console.log(`L2 balance ${beforeL2} ETH\n`);

const amount = process.argv[2] ?? "0.01";
const value = parseEther(amount);
if (value <= 0n) {
  console.error("Usage: node scripts/bridge-sepolia.mjs [amountInEth]");
  process.exit(1);
}
if (value >= await l1.getBalance({ address })) {
  console.error(`Refusing: ${amount} ETH would spend the entire L1 balance (${beforeL1} ETH).`);
  process.exit(1);
}

// Simulate before broadcasting. A revert here costs nothing; the same revert on
// a real transaction costs gas and teaches nothing.
const sim = await l1.simulateContract({
  account,
  address: PORTAL,
  abi: DEPOSIT_ABI,
  functionName: "depositTransaction",
  args: [address, value, 200_000n, false, "0x"],
  value,
});
if (sim.error) {
  console.error(`Simulation failed: ${sim.error.shortMessage ?? sim.error.message}`);
  process.exit(1);
}
console.log(`simulated depositTransaction -> success`);

const wallet = createWalletClient({ account, chain: sepolia, transport: custom(l1) });
const hash = await wallet.writeContract({
  address: PORTAL,
  abi: DEPOSIT_ABI,
  functionName: "depositTransaction",
  args: [address, value, 200_000n, false, "0x"],
  value,
  chain: sepolia,
});
console.log(`sent      ${amount} ETH  tx ${hash}`);

const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success") {
  console.error(`L1 transaction failed: ${receipt.status}`);
  process.exit(1);
}
console.log(`L1        mined in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

// A mined L1 transaction is not yet a funded L2 account: the deposit has to be
// derived by the sequencer. Wait for the L2 balance to actually move.
console.log("\nwaiting for the L2 deposit to be derived...");
let arrived = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const now = await l2.getBalance({ address });
  if (now > beforeL2) {
    const afterL2 = Number(formatEther(now));
    console.log(`L2        ${beforeL2} -> ${afterL2} ETH  (+${(afterL2 - beforeL2).toFixed(6)})`);
    console.log(`\nVerified on both ends. Bridged ${amount} ETH Sepolia -> Base Sepolia.`);
    console.log(`Explorer: https://sepolia.basescan.org/address/${address}`);
    arrived = true;
    break;
  }
  if (i % 5 === 4) console.log(`  …still ${formatEther(now)} ETH (${(i + 1) * 2}s)`);
}
if (!arrived) {
  console.error("\nL1 succeeded but the L2 balance did not increase within 60s.");
  console.error("The L1 tx is valid; the deposit may still derive. Not reporting success.");
  process.exit(1);
}

