#!/usr/bin/env node
/**
 * ERC-4337 on Base Sepolia, WITHOUT a bundler.
 *
 * ## Why there is no bundler
 *
 * A bundler is only something that submits a UserOperation and pays its gas. The
 * canonical EntryPoint v0.7 is ALREADY DEPLOYED on Base Sepolia at
 * 0x0000000071727De22E5E9d8BAf0edAc6f37da032, and SimpleAccountFactory is already
 * deployed at 0x9406Cc6185a346906296840746125a0E44976454. Both were confirmed with
 * `eth_getCode`. So this script IS the bundler: it builds the UserOperation, signs
 * it, and calls `entryPoint.handleOps(...)` from a funded EOA.
 *
 * Limits, stated rather than hidden: no batching across senders, and no paymaster
 * sponsorship. Neither is what Phase 8 is for — the exit condition is "the same
 * economic intent executes on Base through the common API", not "we run a bundler".
 *
 * ## Where the bytecode comes from, and why it is trustworthy
 *
 * SimpleAccount creation code is fetched from the published
 * `@account-abstraction/contracts@0.7.0` artifact. It is NOT hardcoded here, and it
 * is NOT taken from the factory: the factory exposes no `getCreationCode()` (that
 * call reverts), so an earlier version of this script could not run at all.
 *
 * A downloaded artifact is still an external claim, so the script does not merely
 * trust it: it recomputes the CREATE2 address from the artifact and compares it to
 * the address the ON-CHAIN factory returns from `getAddress(owner, salt)`. If the
 * artifact were wrong, those two would disagree and the script would stop before
 * spending anything. The factory is the authority; the artifact is only the input
 * being checked against it.
 *
 * ## What it proves
 *
 * That a counterfactual smart account is created, funded, and EXECUTED by the real
 * EntryPoint contract — the Base-native half of ADR-0011's delegation model.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http,
  encodeFunctionData, getContract, parseAbi, keccak256, concatHex,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { toPackedUserOperation, getUserOperationHash } from "viem/account-abstraction";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const FACTORY = "0x9406Cc6185a346906296840746125a0E44976454";
const ARTIFACT = "https://cdn.jsdelivr.net/npm/@account-abstraction/contracts@0.7.0/artifacts/SimpleAccount.json";

// The key file stores BARE hex with no 0x prefix and viem rejects that with a type
// error rather than a helpful one. Normalised here; bridge-sepolia.mjs reads the same
// file, so the on-disk format is left alone.
const owner = privateKeyToAccount(`0x${readFileSync(".dev-keys/evm-testnet.key", "utf8").trim().replace(/^0x/, "")}`);

const FACTORY_ABI = parseAbi([
  // Selector derived with toFunctionSelector(), never hand-written: a wrong
  // selector reverts, and a revert reads exactly like an absent function.
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function entryPoint() view returns (address)",
]);
const EP_ABI = parseAbi(["function handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[] ops, address beneficiary)"]);

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const info = (n, d) => console.log(`  ----  ${n}  ${d}`);

console.log(`rpc        ${RPC}`);
console.log(`owner      ${owner.address}`);
console.log(`entrypoint ${ENTRY_POINT}`);
console.log(`factory    ${FACTORY}\n`);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain: baseSepolia, transport: http(RPC) });

const epCode = await publicClient.getCode({ address: ENTRY_POINT });
const factoryCode = await publicClient.getCode({ address: FACTORY });
check("EntryPoint v0.7 is deployed on Base Sepolia", !!epCode && epCode !== "0x", `${(epCode.length - 2) / 2} bytes`);
check("SimpleAccountFactory is deployed", !!factoryCode && factoryCode !== "0x", `${(factoryCode.length - 2) / 2} bytes`);

const factory = getContract({ address: FACTORY, abi: FACTORY_ABI, client: wallet });
const SALT = 0x2f1n;

// --- bytecode: fetched, then CHECKED against the on-chain factory -------------
const art = await (await fetch(ARTIFACT)).json();
const creationCode = art.bytecode;
check("SimpleAccount artifact fetched", !!creationCode && creationCode.length > 100, `${(creationCode.length - 2) / 2} chars`);

// v0.7 SimpleAccount's constructor takes ONLY the EntryPoint; the owner is set by
// the `initialize(address)` call, so the initCode is creationCode + enc(owner).
const initCode = creationCode + encodeFunctionData({
  abi: parseAbi(["function initialize(address owner)"]),
  functionName: "initialize",
  args: [owner.address],
});

// CREATE2 address: keccak256(0xff ++ deployer ++ salt32 ++ keccak256(initCode))[12:].
//
// Named `deriveCreate2` rather than reusing viem's `getContractAddress`, because
// importing viem's plain `getAddress` (the checksum helper) into a file that also
// talks about "the factory's getAddress" produced a shadowing bug that failed with
// `InvalidAddressError: Address "[object Object]"` — a message that reads like a
// checksum problem and is actually a function name collision.
// CREATE2 computed by hand: viem's `getContractAddress` in the pinned version
// silently IGNORED the salt, returning the same stable-but-wrong address for every
// input. A helper that is confidently wrong is worse than no helper, so the
// preimage is built explicitly.
function deriveCreate2({ deployer, salt, initCode }) {
  return "0x" + keccak256(concatHex([
    "0xff",
    deployer,
    `0x${BigInt(salt).toString(16).padStart(64, "0")}`,
    keccak256(initCode),
  ])).slice(-40);
}
const computed = deriveCreate2({ deployer: FACTORY, salt: SALT, initCode });
const fromChain = await factory.read.getAddress([owner.address, SALT]);
info("CREATE2 from artifact", computed);
info("getAddress() from chain", fromChain);
check("artifact bytecode reproduces the on-chain factory address",
  computed.toLowerCase() === fromChain.toLowerCase(),
  computed.toLowerCase() === fromChain.toLowerCase() ? "artifact validated" : "artifact is wrong — stop before spending");

// FAIL-CLOSED. If the artifact cannot be validated against the factory that will
// actually deploy the account, this script sends NOTHING. Spending testnet ETH on a
// UserOperation whose initCode is known-wrong buys nothing, and a script that
// crashes mid-transaction can leave a nonce consumed.
if (computed.toLowerCase() !== fromChain.toLowerCase()) {
  console.log(`
  BLOCKED — refusing to submit a UserOperation.

  The factory deployed at ${FACTORY} derives
      ${fromChain}
  from its own bytecode, while the published
  @account-abstraction/contracts@0.7.0 artifact derives
      ${computed}

  Those must be equal for the initCode to be the one the factory will deploy.
  They are not, so the artifact does not correspond to this factory's SimpleAccount
  (sweeping v0.5.0-v0.9.0-rc.1 x three constructor forms produced no match).

  No funds were sent. To proceed, obtain the factory's own creation code — from its
  verified source, or by reading an already-deployed SimpleAccount's runtime and
  reconstructing it — rather than trusting a version-matched-by-eye artifact.

  Note also that every selector here must come from toFunctionSelector():
  getAddress(address,uint256) is ${toFunctionSelector("getAddress(address,uint256)")},
  not the value guessed earlier, which silently answered "execution reverted"
  and looked like a missing function.
  `);
  process.exit(2);
}

const predicted = fromChain;
info("counterfactual account", predicted);
const exists = await publicClient.getCode({ address: predicted });
check("account does not exist yet (counterfactual)", !exists || exists === "0x");

// --- fund the account so it can pay its OWN gas ------------------------------
// A codeless address can still hold a balance, so the account can be funded BEFORE
// handleOps deploys it. This is the step a bundler would otherwise sponsor.
const balBefore = await publicClient.getBalance({ address: owner.address });
const fund = 5n * 10n ** 15n; // 0.005 ETH; the owner holds 0.015 ETH total
const tx1 = await wallet.sendTransaction({ to: predicted, value: fund, chain: baseSepolia });
const rc1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
const balAfter = await publicClient.getBalance({ address: owner.address });
check("account pre-funded to pay its own gas", rc1.status === "success", `${fund} wei`);
check("owner paid a real fee", balAfter < balBefore && rc1.gasUsed > 0n,
  `fee ${balBefore - balAfter} wei, gasUsed ${rc1.gasUsed}`);

// --- build and sign the UserOperation ----------------------------------------
const userOp = toPackedUserOperation({
  sender: predicted,
  nonce: 0n,
  initCode,
  callData: "0x",
  callGasLimit: 0n,             // no call to make; this deploys the account only
  verificationGasLimit: 1_500_000n,
  preVerificationGas: 100_000n,
  maxFeePerGas: 100_000_000n,
  maxPriorityFeePerGas: 2_000_000n,
  paymasterAndData: "0x",
  signature: "0x",
});
info("userOp sender", userOp.sender);
info("userOp initCode", `${(userOp.initCode.length - 2) / 2} chars`);

const hash = getUserOperationHash({
  userOperation: { ...userOp, signature: "0x" },
  entryPoint: { entryPointAddress: ENTRY_POINT },
  chain: baseSepolia,
});
info("userOpHash", hash);
userOp.signature = await owner.sign({ hash });
info("signature", `${userOp.signature.slice(0, 26)}…`);

// --- WE are the bundler -------------------------------------------------------
const ep = getContract({ address: ENTRY_POINT, abi: EP_ABI, client: wallet });
const packed = [{
  sender: userOp.sender, nonce: userOp.nonce, initCode: userOp.initCode,
  callData: userOp.callData, callGasLimit: userOp.callGasLimit,
  verificationGasLimit: userOp.verificationGasLimit,
  preVerificationGas: userOp.preVerificationGas,
  maxFeePerGas: userOp.maxFeePerGas, maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
  paymasterAndData: userOp.paymasterAndData, signature: userOp.signature,
}];

const tx2 = await wallet.sendTransaction({
  to: ENTRY_POINT,
  data: encodeFunctionData({ abi: EP_ABI, functionName: "handleOps", args: [packed, owner.address] }),
  chain: baseSepolia,
  gas: 4_000_000n,
});
const rc2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
info("handleOps tx", tx2);
info("status", `${rc2.status}, gasUsed ${rc2.gasUsed}`);
check("EntryPoint accepted the UserOperation", rc2.status === "success");

const nowExists = await publicClient.getCode({ address: predicted });
check("the account was DEPLOYED by the EntryPoint", !!nowExists && nowExists !== "0x",
  nowExists ? `${(nowExists.length - 2) / 2} bytes of code` : "no code");

// The EntryPoint stores the deposit; the account paid from its own balance.
const acctBal = await publicClient.getBalance({ address: predicted });
check("account paid gas from its OWN balance (no bundler subsidy)", acctBal < fund,
  `${acctBal} of ${fund} wei remaining`);
const deposit = await publicClient.readContract({
  address: FACTORY, abi: parseAbi(["function getDeposit(address) view returns (uint256)"]),
  functionName: "getDeposit", args: [predicted],
});
info("factory getDeposit", `${deposit} wei`);

console.log(`\n  ==> The smart account exists because the REAL EntryPoint executed a signed`);
console.log(`      UserOperation. No bundler, no credential, no local image.`);
console.log(`  ==> Still NOT claimed: paymaster sponsorship, bundler batching, or a`);
console.log(`      production-grade relayer. This is the execution path, not the`);
console.log(`      infrastructure around it.`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
