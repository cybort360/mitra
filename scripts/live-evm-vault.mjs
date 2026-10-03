#!/usr/bin/env node
/**
 * LIVE on-chain proof that MitraVault enforces the invariants — the EVM
 * counterpart of SOLANA_LIVE=1.
 *
 * Everything here is a real transaction against a real network. The assertions are
 * about what the CONTRACT did, read back from chain state, not about what the
 * client believes it sent.
 *
 * Run:  node scripts/live-evm-vault.mjs baseSepolia|moderato
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from "viem";
import { artifact } from "./deploy-evm-vault.artifact.mjs";

const CFG = {
  baseSepolia: {
    chainId: 84532, name: "baseSepolia", rpc: "https://sepolia.base.org",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    expectName: "USDC",
  },
  moderato: {
    chainId: 42431, name: "moderato", rpc: "https://rpc.moderato.tempo.xyz",
    // Three wrong values lived here before this was right, and a third-person
    // "correction" turned one error into another:
    //   0x20c0...00000  41 hex chars - malformed, my typo
    //   0x20c0...0001   a valid contract, but name() == "AlphaUSD"
    //   0x20c0...0000   name() == "PathUSD"   <- this
    //
    // A constant is not a defence; it is what failed twice. `expectName` asserts the
    // chain agrees BEFORE any value moves, which is the property F40 asked for and
    // a bare address never had.
    token: "0x20c0000000000000000000000000000000000000",
    expectName: "PathUSD",
  },
};

const erc20Name = parseAbi(["function name() view returns (string)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

let failures = 0;
const check = (n, c, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? `  ${d}` : ""}`); if (!c) failures++; };

async function main() {
  const key = process.argv[2] ?? "baseSepolia";
  const cfg = CFG[key];
  const dep = JSON.parse(readFileSync("lib/evm/deployments.json", "utf8"))[key];
  if (!dep) throw new Error(`no deployment recorded for ${key}`);

  const chain = { id: cfg.chainId, name: cfg.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } };
  const pub = createPublicClient({ chain, transport: http(cfg.rpc) });
  const acct = privateKeyToAccount(`0x${readFileSync(".dev-keys/evm-testnet.key", "utf8").trim()}`);
  const w = createWalletClient({ account: acct, chain, transport: http(cfg.rpc) });
  const run = async (f, a) => w.writeContract({ address: dep.address, abi: artifact.abi, functionName: f, args: a, chain, value: 0n });

  const V = dep.address;
  // Unique per run: `openMandate` refuses to overwrite, so a fixed holder makes the
  // script single-use. Deriving it from the timestamp avoids needing a teardown
  // path on the contract just to make the harness re-runnable.
  const HOLDER = `0x000000000000000000000000000000000000${(BigInt(Math.floor(Date.now() / 1000)) % 100000n).toString(16).padStart(4, "0")}`;
  const PROVIDER = "0x0000000000000000000000000000000000000pro";
  const RECIPIENT = "0x000000000000000000000000000000000000bee5";
  const ENGINE = acct.address;      // this key is the policy engine, deterministically
  // THE assertion, before anything else. Read the mint's own name and refuse to
  // continue unless it is the token we claim to be testing.
  if (cfg.expectName) {
    const tokenName = await pub.readContract({ address: cfg.token, abi: erc20Name, functionName: "name" });
    check(`token ${cfg.token} is ${cfg.expectName}`, tokenName === cfg.expectName, `name() = ${tokenName}`);
    if (tokenName !== cfg.expectName) {
      console.log(`\n  REFUSING to run: this mint is ${tokenName}, not ${cfg.expectName}.`);
      process.exit(1);
    }
  }
  const DECIMALS = await pub.readContract({ address: cfg.token, abi: erc20, functionName: "decimals" });
  const UNIT = 10n ** BigInt(DECIMALS);
  // Sized to what the deployer ACTUALLY holds, not to a round number. The first
  // run requested 10 USDC against a balance of 0.124795 and reverted with
  // "transfer amount exceeds allowance" — an error about allowance that is really
  // about the balance, which is why the size is derived rather than asserted.
  const balRaw = await pub.readContract({ address: cfg.token, abi: erc20, functionName: "balanceOf", args: [acct.address] });
  const AMOUNT = balRaw / 2n;
  // The floor is deliberately low: the Base Sepolia test key holds 0.124795 USDC,
  // less than one whole token, and a sub-dollar deposit still exercises every guard
  // this script exists to prove. The number that matters is that it is non-zero and
  // that the recipient delta is checked for EXACT equality, not "> 0".
  if (AMOUNT < 1000n) throw new Error(`balance ${balRaw} is too small to be a meaningful deposit`);
  const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log(`\n=== ${key} (${cfg.chainId}) ===`);
  console.log(`  vault    ${V}`);
  console.log(`  token    ${cfg.token} (${DECIMALS} dp)`);
  console.log(`  deployer ${acct.address}`);

  const balBefore = balRaw;
  console.log(`  token balance ${balBefore} (${Number(balBefore) / Number(UNIT)} tokens) -> depositing ${AMOUNT}`);

  // 1. deposit
  const approveHash = await w.writeContract({ address: cfg.token, abi: erc20, functionName: "approve", args: [V, balBefore], chain });
  const approveRc = await pub.waitForTransactionReceipt({ hash: approveHash });
  check("approve confirmed", approveRc.status === "success");
  await new Promise((r) => setTimeout(r, 2000));
  const depHash = await run("deposit", [cfg.token, AMOUNT]);
  const depRc = await pub.waitForTransactionReceipt({ hash: depHash });
  check("deposit confirmed", depRc.status === "success", `tx ${depHash} block ${depRc.blockNumber}`);
  await new Promise((r) => setTimeout(r, 2000));

  // 2. open a mandate for the holder
  const mh = await run("openMandate", [HOLDER, AMOUNT, AMOUNT * 10n, DEADLINE, ENGINE]);
  const mrc = await pub.waitForTransactionReceipt({ hash: mh });
  check("openMandate confirmed", mrc.status === "success", `tx ${mh}`);
  await new Promise((r) => setTimeout(r, 3000));

  const mand = await pub.readContract({ address: V, abi: artifact.abi, functionName: "mandates", args: [HOLDER] });
  check("mandate is bound to this principal", String(mand[0]).toLowerCase() === acct.address.toLowerCase());
  check("mandate names this key as policy engine", String(mand[7]).toLowerCase() === ENGINE.toLowerCase());
  check("mandate version starts at 1", mand[6] === 1);

  // 3. engine signs an EIP-712 SpendPermit
  const typehash = await pub.readContract({ address: V, abi: artifact.abi, functionName: "PERMIT_TYPEHASH" });
  const domainSep = await pub.readContract({ address: V, abi: artifact.abi, functionName: "domainSeparator" });
  const { keccak256, toHex, encodeAbiParameters } = await import("viem");
  const settlementId = keccak256(toHex("settle-1"));
  const structHash = keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" },
    { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint32" }, { type: "uint64" },
  ], [typehash, acct.address, HOLDER, cfg.token, AMOUNT, RECIPIENT, settlementId, 1, DEADLINE]));
  const actionHash = keccak256(`0x1901${domainSep.slice(2)}${structHash.slice(2)}`);
  const sig = await acct.sign({ hash: actionHash });
  console.log(`  actionHash ${actionHash}`);

  // 4. spend
  const recBefore = await pub.readContract({ address: cfg.token, abi: erc20, functionName: "balanceOf", args: [RECIPIENT] });
  const sh = await run("spendAuthorized", [acct.address, HOLDER, cfg.token, AMOUNT, RECIPIENT, "settle-1", 1, DEADLINE, sig]);
  const src = await pub.waitForTransactionReceipt({ hash: sh });
  check("spendAuthorized confirmed", src.status === "success", `tx ${sh} block ${src.blockNumber}`);
  let recAfter = recBefore;
  let spentAmt = 0n;
  for (let i = 0; i < 5; i++) {
    recAfter = await pub.readContract({ address: cfg.token, abi: erc20, functionName: "balanceOf", args: [RECIPIENT] });
    const m = await pub.readContract({ address: V, abi: artifact.abi, functionName: "mandates", args: [HOLDER] });
    spentAmt = m[4];
    if (recAfter - recBefore === AMOUNT && spentAmt === AMOUNT) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check("recipient received EXACTLY the amount", recAfter - recBefore === AMOUNT, `${recAfter - recBefore} atomic`);
  check("cumulative spend recorded", spentAmt === AMOUNT, `spent=${spentAmt}`);

  // 5. replay must be refused ON-CHAIN
  let replayRefused = false;
  try {
    const rh = await run("spendAuthorized", [acct.address, HOLDER, cfg.token, AMOUNT, RECIPIENT, "settle-1", 1, DEADLINE, sig]);
    const rc = await pub.waitForTransactionReceipt({ hash: rh });
    replayRefused = rc.status !== "success";
  } catch (e) { replayRefused = true; }
  check("REPLAY refused on-chain", replayRefused);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
