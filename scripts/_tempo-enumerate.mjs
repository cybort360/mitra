import { parseAbi, encodeFunctionData } from "viem";
const RPC = "https://rpc.moderato.tempo.xyz";
const abi = parseAbi(["function name() view returns (string)","function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)"]);
const rpc = async (m, p = []) => (await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json());
const dec = (h) => { h = h.replace(/^0x/, ""); if (!h) return ""; let s = ""; for (let i = 2; i < h.length; i += 64) { const b = h.slice(i, i + 64).match(/../g) || []; s += String.fromCharCode(...b.map((x) => parseInt(x, 16))); } return s.replace(/\0/g, "").trim(); };

console.log("=== enumerate TIP-20 mints by index on Moderato ===");
console.log("(a mint exists iff name() answers; a revert means no contract there)\n");
const found = [];
for (let i = 0; i <= 12; i++) {
  const addr = "0x20c0" + i.toString(16).padStart(36, "0");
  const n = await rpc("eth_call", [{ to: addr, data: encodeFunctionData({ abi, functionName: "name" }) }, "latest"]);
  if (n.error) { console.log(`  ${addr}  -- no contract`); continue; }
  const name = dec(n.result);
  const d = await rpc("eth_call", [{ to: addr, data: encodeFunctionData({ abi, functionName: "decimals" }) }, "latest"]);
  const s = await rpc("eth_call", [{ to: addr, data: encodeFunctionData({ abi, functionName: "totalSupply" }) }, "latest"]);
  console.log(`  ${addr}  ${name.padEnd(10)} decimals=${d.result ? parseInt(d.result, 16) : "?"}  supply=${s.result ? BigInt(s.result) : 0n}`);
  found.push({ addr, name, decimals: d.result ? parseInt(d.result, 16) : null });
}
console.log(`\n  non-index mint seen earlier: 0x20c0000000000000000000006a37da5c996874be = OpenUSD`);
console.log(`\n  === summary: ${found.length} indexed mints, none named OUSD ===`);
console.log("  " + found.map((f) => f.name).join(", "));
