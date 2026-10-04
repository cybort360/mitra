#!/usr/bin/env node
/**
 * Deploy MitraClearing.sol to Base Sepolia and Tempo Moderato.
 *
 * Mirrors scripts/deploy-evm-vault.mjs (viem, one signing path) rather than
 * `forge create`, so there is a single key-handling code path to audit.
 *
 * The constructor takes the clearinghouse `operator`. This is the clearinghouse
 * EOA, NOT a contract, and that is recorded honestly: it is a single point of
 * control over epoch commits and settlement recording. Spec 55.3 lists clearing
 * trust as an open question; the permissionless challenge/finalise paths exist so
 * that operator cannot unilaterally settle a challenged epoch.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const OUT = "lib/evm/deployments.json";
const ART = "out/MitraClearing.sol/MitraClearing.json";

const CHAINS = {
  baseSepolia: { id: 84532, name: "baseSepolia", rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
  moderato:    { id: 42431, name: "moderato",    rpc: process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz" },
};

async function main() {
  const only = process.argv[2];
  const artifact = JSON.parse(readFileSync(ART, "utf8"));
  const bytecode = artifact.bytecode.object;
  if (!bytecode || bytecode === "0x") throw new Error(`no bytecode in ${ART} — run forge build first`);

  const key = readFileSync(".dev-keys/evm-testnet.key", "utf8").trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);

  const db = JSON.parse(readFileSync(OUT, "utf8"));
  db.clearing ??= {};

  for (const [name, cfg] of Object.entries(CHAINS)) {
    if (only && only !== name) continue;
    const chain = { id: cfg.id, name, rpcUrls: { default: { http: [cfg.rpc] } } };
    const pub = createPublicClient({ transport: http(cfg.rpc) });
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });

    let addr;
    let hash;
    let blockNumber;

    if (db.clearing?.[name]?.address) {
      addr = db.clearing[name].address;
      hash = db.clearing[name].deployTx;
      blockNumber = db.clearing[name].deployBlock;
      console.log(`\n=== ${cfg.name} (${cfg.id}) [already deployed at ${addr}] ===`);
    } else {
      hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode,
        args: [account.address],
        chain,
        account,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });

      if (rc.status !== "success") throw new Error(`${name}: deployment reverted`);
      addr = rc.contractAddress;
      blockNumber = Number(rc.blockNumber);
      console.log(`\n=== ${cfg.name} (${cfg.id}) ===`);
      console.log(`  operator  ${account.address}`);
      console.log(`  clearing  ${addr}`);
      console.log(`  tx        ${hash}`);
      console.log(`  block     ${blockNumber}`);
    }

    // Confirm the deployed contract actually answers with OUR operator, rather
    // than trusting the receipt. A wrong-arg deployment would otherwise look
    // identical here. Use retry in case public RPC replicas lag behind sequencer.
    let onChain;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        onChain = await pub.readContract({
          address: addr,
          abi: artifact.abi,
          functionName: "operator",
        });
        if (onChain) break;
      } catch (err) {
        if (attempt === 6) throw err;
        console.log(`  waiting for RPC replica (attempt ${attempt}/6)...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (onChain.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`${name}: operator mismatch on-chain (${onChain})`);
    }
    console.log(`  verified  operator() == deployer (${onChain})`);

    db.clearing[name] = {
      address: addr,
      chainId: cfg.id,
      operator: account.address,
      deployTx: hash,
      deployBlock: blockNumber,
    };
  }

  writeFileSync(OUT, JSON.stringify(db, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
