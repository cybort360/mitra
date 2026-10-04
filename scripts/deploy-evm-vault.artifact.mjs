import { readFileSync } from "node:fs";

/** The compiled MitraVault ABI + bytecode, read from forge's output. */
const a = JSON.parse(readFileSync("out/MitraVault.sol/MitraVault.json", "utf8"));
export const artifact = { abi: a.abi, bytecode: a.bytecode.object };
