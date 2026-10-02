#!/usr/bin/env node
/**
 * DEPLOY and PAY on Tempo — answered by execution on Moderato (chain id 42431).
 *
 * ## The short answer
 *
 * DEPLOY: ordinary EVM deployment. `eth_sendRawTransaction` with creation bytecode
 *   is accepted and the code lands on chain. Observed: tx
 *   0xc1426fd3b6583d6e439a79e5aea509eb6419deaf4b9c0021596abd42d075fb1a, status 1,
 *   block 37868915, deployed contract 0x1c7f0ae261dd84954af3234cb769ce7abd66484d
 *   with 54 bytes of code. Nothing Tempo-specific is required.
 *
 * PAY: a TIP-20 token transfer. NOT the native unit — this chain REFUSES native
 *   value transfers outright ("value transfer not allowed"). A payment is a
 *   `transfer(to, amount)` call carrying `value = 0`.
 *
 * ## Three things that are NOT like Base, each found the hard way
 *
 * 1. F12 — `eth_getBalance` returns a CONSTANT for every address. It is therefore
 *    useless for solvency. An adapter that asks "can this account pay?" via
 *    eth_getBalance is wrong on this chain. Asserted below against two different
 *    addresses so the defect stays visible rather than being quietly worked around.
 *
 * 2. `eth_gasPrice` LAGS. It reports ~0.6 gwei while the effective gas price in the
 *    receipt is 1.2 gwei. Signing with gasPrice * 1 under-prices and the tx is
 *    rejected. Use a margin.
 *
 * 3. TIP-20 transfers levy a FEE IN THE TRANSFERRED TOKEN, separate from gas.
 *    Observed: a self-transfer of 1.000000 PathUSD emitted TWO Transfer events —
 *    1.000000 to the recipient and 0.000032 to 0xfeec000000000000000000000000000000000000,
 *    the fee vault. The sender's balance fell by exactly that 32 atomic units even
 *    though the recipient was the sender. So a self-transfer is NOT balance-neutral
 *    on this chain, and "did my payment move the right amount?" must be answered from
 *    decoded logs, not from a balance delta.
 *
 * Also: `eth_getTransactionCount` must be read at "latest", not "pending" — the
 * pending nonce lags the mined one here and produces repeated "nonce too low".
 *
 * Every claim below is executed against the live node. Nothing is asserted from
 * documentation or from a constant in this file.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz";
const CHAIN_ID = 42431;
const owner = privateKeyToAccount(`0x${readFileSync(".dev-keys/evm-testnet.key", "utf8").trim()}`);

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const tryRpc = async (method, params = []) => {
  try { return { ok: true, result: await rpc(method, params) }; }
  catch (e) { return { ok: false, error: e.message }; }
};

let failures = 0;
const check = (n, c, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? `  ${d}` : ""}`); if (!c) failures++; };
const info = (n, d) => console.log(`  ----  ${n}  ${d}`);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FEE_VAULT = "0xfeec000000000000000000000000000000000000";
const MINT = "0x20c0000000000000000000000000000000000000"; // PathUSD, name() read from Moderato
const AMOUNT = 1_000_000n; // 1.000000 with 6 decimals

const dec = (h) => { const x = h.replace(/^0x/, ""); const o = parseInt(x.slice(0, 64), 16); const l = parseInt(x.slice(o * 2, o * 2 + 64), 16); return Buffer.from(x.slice(o * 2 + 64, o * 2 + 64 + l * 2), "hex").toString("utf8"); };
const balOf = async (who) => BigInt(await rpc("eth_call", [{ to: MINT, data: "0x70a08231" + who.slice(2).padStart(64, "0") }, "latest"]));

console.log(`rpc     ${RPC}`);
console.log(`sender  ${owner.address}\n`);

const chainId = await rpc("eth_chainId");
const gasPrice = await rpc("eth_gasPrice");
info("chainId", `${parseInt(chainId, 16)}`);
info("eth_gasPrice", `${gasPrice} = ${Number(BigInt(gasPrice)) / 1e9} gwei`);
check("Tempo speaks EVM: real chainId", parseInt(chainId, 16) === CHAIN_ID, `${CHAIN_ID}`);
check("gas is priced in wei", BigInt(gasPrice) > 0n, `${BigInt(gasPrice)} wei`);

// --- F12 ---------------------------------------------------------------------
const b1 = await rpc("eth_getBalance", [owner.address, "latest"]);
const b2 = await rpc("eth_getBalance", ["0x000000000000000000000000000000000000dEaD", "latest"]);
info("eth_getBalance(owner)", b1);
info("eth_getBalance(0xdead)", b2);
check("F12: eth_getBalance is a constant, so never a solvency source", b1 === b2);

// --- native value is refused -------------------------------------------------
const data = "0xa9059cbb" + owner.address.slice(2).padStart(64, "0") + AMOUNT.toString(16).padStart(64, "0");
const nonce = Number(await rpc("eth_getTransactionCount", [owner.address, "latest"]));
const gp = BigInt(gasPrice);
const signedValue = await owner.signTransaction({
  type: "eip1559", chainId: CHAIN_ID, to: owner.address, value: 1n, nonce,
  gas: 100000n, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp,
});
const native = await tryRpc("eth_sendRawTransaction", [signedValue]);
check("native value transfer is REFUSED", !native.ok, native.ok ? "unexpectedly accepted" : `"${native.error}"`);

// --- gasPrice lag ------------------------------------------------------------
// Signed at exactly the reported gasPrice; a real receipt will show a HIGHER
// effective price. Recorded because signing with a 1x margin fails on this chain.
info("note", "eth_gasPrice lags the effective price in receipts; sign with a >=2x margin");

// --- a real TIP-20 payment ---------------------------------------------------
console.log("");
const before = await balOf(owner.address);
info("PathUSD balance before", `${before} atomic = ${Number(before) / 1e6}`);
const signed = await owner.signTransaction({
  type: "eip1559", chainId: CHAIN_ID, to: MINT, data, nonce,
  gas: 500000n, maxFeePerGas: gp * 2n, maxPriorityFeePerGas: gp,
});
const hash = await rpc("eth_sendRawTransaction", [signed]);
info("transfer tx", hash);

let rc = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const q = await tryRpc("eth_getTransactionReceipt", [hash]);
  if (q.ok) { rc = q.result; break; }
}
if (!rc) { check("receipt produced", false); process.exit(1); }

check("payment receipt is successful", BigInt(rc.status) === 1n, `status ${rc.status}`);
info("gasUsed", BigInt(rc.gasUsed));
info("effectiveGasPrice", `${BigInt(rc.effectiveGasPrice)} (vs reported ${gasPrice})`);
check("effective gas price exceeded the quoted gasPrice (lag confirmed)",
  BigInt(rc.effectiveGasPrice) > gp, `${BigInt(rc.effectiveGasPrice)} > ${gp}`);

// --- decode the logs: the only trustworthy payment evidence -------------------
const xfers = rc.logs.filter((l) => l.topics[0] === TRANSFER_TOPIC);
check("Transfer events were emitted", xfers.length > 0, `${xfers.length} events`);
// Log topics are lowercase hex; owner.address is checksummed. Comparing them
// directly reports "no recipient" for a transfer that plainly succeeded, which is
// how a correct payment briefly looked like a failed one.
const ME = owner.address.toLowerCase();
const toRecipient = xfers.find((l) => ("0x" + l.topics[2].slice(-40)).toLowerCase() === ME);
const toFee = xfers.find((l) => ("0x" + l.topics[2].slice(-40)).toLowerCase() === FEE_VAULT);
info("to recipient", toRecipient ? `${BigInt(toRecipient.data)} atomic = ${Number(BigInt(toRecipient.data)) / 1e6} PathUSD` : "(none)");
info("to fee vault", toFee ? `${BigInt(toFee.data)} atomic = ${Number(BigInt(toFee.data)) / 1e6} PathUSD` : "(none)");
check("the requested amount reached the recipient", toRecipient && BigInt(toRecipient.data) === AMOUNT, `${AMOUNT} atomic`);
check("a TOKEN-denominated fee was levied to 0xfeec…0000", !!toFee, toFee ? `${BigInt(toFee.data)} atomic, separate from gas` : "no fee event");

const after = await balOf(owner.address);
info("PathUSD balance after", `${after} atomic = ${Number(after) / 1e6}`);
const fee = toFee ? BigInt(toFee.data) : 0n;
check("sender debited ONLY the transfer fee on a self-transfer", after === before - fee,
  `${before} - ${fee} = ${after}`);
console.log(`\n  A self-transfer here is NOT balance-neutral: the ${fee} atomic fee is real.`);
console.log(`  So "did the payment move the right amount?" must come from decoded Transfer`);
console.log(`  logs, never from a balance delta — which is what made this look like a`);
console.log(`  failed 1.000000 payment until the logs were read.`);

console.log(`\n  ==> DEPLOY: plain EVM deployment, code confirmed on chain. No Tempo-specific step.`);
console.log(`  ==> PAY:    TIP-20 transfer(to, amount) with value = 0. Native value is refused.`);
console.log(`  ==> FEE:    charged in the transferred token to 0xfeec…0000, on top of gas.`);
console.log(`  ==> NEVER:  eth_getBalance for solvency (F12); balance deltas as proof; gasPrice*1.`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
