/**
 * Sprint item 3: the ERC-4337 Base transport and the on-chain ERC-1271 verifier,
 * offline. The live half is in `tests/settlement-caller.test.ts` (BASE_LIVE=1).
 *
 * The confirmation rule is tested on `observeSmartAccountSettlement` with
 * transactions and receipts built from the real ABIs (EntryPoint v0.6, the smart
 * account's `execute`, ERC-20). The one case that matters most is the trap the
 * transport header describes: `handleOps` succeeding while the UserOperation
 * inside it failed.
 */
import { describe, expect, it } from "vitest";
import {
  concatHex, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint06Abi, entryPoint06Address } from "viem/account-abstraction";
import { BASE_ASSETS, settlementCommitment } from "@/lib/adapters/base";
import { Erc4337Transport, observeSmartAccountSettlement, SMART_ACCOUNT_ABI } from "@/lib/adapters/base-4337-transport";
import { ERC6492_INVALID, ERC6492_MAGIC_SUFFIX, RpcSignatureVerifier } from "@/lib/evm/erc1271";
import { ERC1271_MAGIC_VALUE, settlementDigest, settlingDomain, verifyAuthorisation } from "@/lib/evm/eip712";

const ACCOUNT = "0x00ad7c71680a5b1a9b86d41440022857fc17e7ca" as const;
const RELAYER = "0x7823d6bea51cc21c5d8588c7ff72e33130848116" as const;
const TO = "0x1111111111111111111111111111111111111111" as const;
const USDC = BASE_ASSETS[84532].USDC.address.toLowerCase() as Hex;
const COMMIT = settlementCommitment({ settlementId: "set_1", from: ACCOUNT, to: TO, amount: 0.01, asset: "USDC", chainId: 84532 });
const TX = `0x${"ab".repeat(32)}`;
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

function build(over: {
  sender?: Hex; success?: boolean; eventSender?: Hex; token?: Hex; value?: bigint; inner?: Hex;
  transferFrom?: Hex; transferAmount?: bigint; txTo?: string; status?: "success" | "reverted";
} = {}) {
  const inner = over.inner ?? concatHex([encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, 10_000n] }), COMMIT]);
  const callData = encodeFunctionData({ abi: SMART_ACCOUNT_ABI, functionName: "execute", args: [over.token ?? USDC, over.value ?? 0n, inner] });
  const op = {
    sender: over.sender ?? ACCOUNT, nonce: 0n, initCode: "0x" as Hex, callData, callGasLimit: 1n, verificationGasLimit: 1n,
    preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: "0x" as Hex, signature: "0x" as Hex,
  };
  const input = encodeFunctionData({ abi: entryPoint06Abi, functionName: "handleOps", args: [[op], RELAYER] });
  const opEvent = {
    address: entryPoint06Address,
    topics: encodeEventTopics({ abi: entryPoint06Abi, eventName: "UserOperationEvent", args: { userOpHash: `0x${"11".repeat(32)}`, sender: over.eventSender ?? ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, over.success ?? true, 1n, 1n]),
  };
  const transfer = {
    // Emitted by the token the call targeted, so an unregistered token is refused by
    // the registry check itself rather than by a log mismatch.
    address: over.token ?? USDC,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(over.transferFrom ?? ACCOUNT), pad(TO)] as Hex[],
    data: pad(`0x${(over.transferAmount ?? 10_000n).toString(16)}`),
  };
  return {
    txHash: TX, account: ACCOUNT, chainId: 84532 as const,
    tx: { to: over.txTo ?? entryPoint06Address, input },
    receipt: { status: over.status ?? ("success" as const), blockNumber: 47_000_000n, logs: [transfer, opEvent] },
  };
}

describe("observeSmartAccountSettlement — what counts as a confirmed smart-account settlement", () => {
  it("a successful UserOperation that moved the tokens from the account is observed, with its commitment", () => {
    expect(observeSmartAccountSettlement(build())).toEqual({
      txHash: TX, block: 47_000_000, carriedCommitment: COMMIT.toLowerCase(), from: ACCOUNT, to: TO, amountAtomic: 10_000n, asset: USDC,
    });
  });

  it("THE TRAP: handleOps succeeded but the UserOperation inside it failed → not paid", () => {
    expect(observeSmartAccountSettlement(build({ success: false }))).toBeNull();
  });

  const refused: Array<[string, Parameters<typeof build>[0]]> = [
    ["the handleOps transaction reverted", { status: "reverted" }],
    ["the transaction did not call the EntryPoint", { txTo: TO }],
    ["the UserOperation was another account's", { sender: TO, eventSender: TO }],
    ["the success event names another account", { eventSender: TO }],
    ["the tokens moved from someone other than the account", { transferFrom: RELAYER }],
    ["the Transfer amount differs from the calldata", { transferAmount: 9_999n }],
    ["the call target is not a registered token, even with a matching Transfer from it", { token: "0x2222222222222222222222222222222222222222" }],
    ["the call sent native value", { value: 1n }],
    ["the inner transfer carries no commitment", { inner: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, 10_000n] }) }],
  ];
  for (const [why, over] of refused) {
    it(`not observed when ${why}`, () => {
      expect(observeSmartAccountSettlement(build(over))).toBeNull();
    });
  }
});

describe("Erc4337Transport.send — refusals happen before anything is signed or sent", () => {
  const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const calls: string[] = [];
  const transport = custom({ request: async ({ method }: { method: string }) => { calls.push(method); throw new Error(`unscripted ${method}`); } });
  const t = new Erc4337Transport({ owner, relayer: owner, chainId: 84532, transport });
  const ok = { to: TO as Hex, amountAtomic: "10000", asset: BASE_ASSETS[84532].USDC, chainId: 84532 as const, data: COMMIT as string };
  const cases: Array<[string, Partial<typeof ok> & Record<string, unknown>, string]> = [
    ["another chain", { chainId: 8453 as never }, "CHAIN_MISMATCH"],
    ["native value", { asset: null as never }, "NATIVE_SETTLEMENT_NOT_SUPPORTED"],
    ["an unregistered token", { asset: { ...BASE_ASSETS[84532].USDC, address: TO } }, "UNREGISTERED_ERC20_FOR_CHAIN"],
    ["a malformed recipient", { to: "0x123" as Hex }, "INVALID_RECIPIENT_ADDRESS"],
    ["a non-positive amount", { amountAtomic: "0" }, "INVALID_ATOMIC_AMOUNT"],
    ["a commitment that is not 32 bytes", { data: "0x1234" }, "COMMITMENT_NOT_BYTES32"],
  ];
  for (const [why, over, reason] of cases) {
    it(`refuses ${why} → ${reason}, with no RPC call`, async () => {
      calls.length = 0;
      await expect(t.send({ ...ok, ...over } as typeof ok)).rejects.toThrow(reason);
      expect(calls).toEqual([]);
    });
  }

  it("refuses a mainnet chain id at construction", () => {
    expect(() => new Erc4337Transport({ owner, relayer: owner, chainId: 8453, transport })).toThrow("UNSUPPORTED_BASE_CHAIN_FOR_4337");
  });
});

describe("RpcSignatureVerifier — ERC-1271 and ERC-6492 through verifyAuthorisation", () => {
  const domain = settlingDomain(84532, "0x0000000000000000000000000000000000000000");
  const typed = { settlementId: "set_1", from: ACCOUNT, to: TO, amountAtomic: 10_000n, asset: BASE_ASSETS[84532].USDC.address };
  const digest = settlementDigest(domain, typed);
  const plainSig = `0x${"aa".repeat(100)}` as Hex;
  const wrapped6492 = `0x${"bb".repeat(100)}${ERC6492_MAGIC_SUFFIX}` as Hex;

  function client(answers: { readContract?: () => Promise<string>; verifyHash?: () => Promise<boolean> }) {
    const seen: string[] = [];
    const c = {
      readContract: async () => { seen.push("readContract"); return answers.readContract ? answers.readContract() : Promise.reject(new Error("no code")); },
      verifyHash: async () => { seen.push("verifyHash"); return answers.verifyHash ? answers.verifyHash() : false; },
    } as unknown as PublicClient;
    return { c, seen };
  }
  const verify = (c: PublicClient, signature: Hex) =>
    verifyAuthorisation({ digest, signature, expectedSigner: ACCOUNT, domain, typed, verifier: new RpcSignatureVerifier(c) });

  it("a deployed account answering the magic value → contract signature accepted", async () => {
    const { c, seen } = client({ readContract: async () => ERC1271_MAGIC_VALUE });
    expect(await verify(c, plainSig)).toEqual({ ok: true, mode: "contract" });
    expect(seen).toEqual(["readContract"]);
  });

  it("any other answer is refused, never reinterpreted", async () => {
    const { c } = client({ readContract: async () => "0x00000000" });
    expect((await verify(c, plainSig)).ok).toBe(false);
  });

  it("a reverting or codeless account is ERC1271_CALL_FAILED, not valid", async () => {
    const { c } = client({});
    expect(await verify(c, plainSig)).toEqual({ ok: false, reason: "ERC1271_CALL_FAILED" });
  });

  it("only a 6492-wrapped signature takes the counterfactual path", async () => {
    const yes = client({ verifyHash: async () => true });
    expect(await verify(yes.c, wrapped6492)).toEqual({ ok: true, mode: "contract" });
    expect(yes.seen).toEqual(["verifyHash"]);
    const no = client({ verifyHash: async () => false, readContract: async () => ERC1271_MAGIC_VALUE });
    expect((await verify(no.c, wrapped6492)).ok, "a rejected 6492 signature does not fall back to a plain 1271 call").toBe(false);
    expect(no.seen).toEqual(["verifyHash"]);
    expect(await new RpcSignatureVerifier(no.c).isValidSignature(ACCOUNT, digest, wrapped6492)).toBe(ERC6492_INVALID);
  });
});
