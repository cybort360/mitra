#!/usr/bin/env node
/**
 * Deploy MitraJobEscrow.sol to Base Sepolia and Tempo Moderato.
 *
 * Mirrors scripts/deploy-evm-vault.mjs (viem, one signing path) rather than
 * `forge create`, so there is a single key-handling code path to audit.
 *
 * The escrow takes no constructor args and has no operator: anyone may call
 * refundJob after timeout, and completeJob is gated by client/evaluator. That
 * is deliberate — an operator would re-centralise the settlement this contract
 * exists to keep permissionless.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const OUT = "lib/evm/deployments.json";
const ART = "out/MitraJobEscrow.sol/MitraJobEscrow.json";

/** Bump when the contract changes in a way that makes earlier deployments unsafe to reuse. */
const REVISION = "F64";
const SUPERSEDED_REASON =
  "F64: no challenge outcome (a challenged epoch finalized), FROZEN accepted obligations, " +
  "a late result swap finalized without a fresh window; see forge/FAILURES.md";
const REDEPLOY = process.argv.includes("--redeploy");

const CHAINS = {
  baseSepolia: { id: 84532, name: "baseSepolia", rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
  moderato:    { id: 42431, name: "moderato",    rpc: process.env.TEMPO_RPC ?? "https://rpc.moderato.tempo.xyz" },
};

async function main() {
  const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const artifact = JSON.parse(readFileSync(ART, "utf8"));
  const bytecode = artifact.bytecode.object;
  if (!bytecode || bytecode === "0x") throw new Error(`no bytecode in ${ART} — run forge build first`);

  const key = readFileSync(".dev-keys/evm-testnet.key", "utf8").trim();
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);

  const db = JSON.parse(readFileSync(OUT, "utf8"));
  db.jobEscrow ??= {};

  for (const [name, cfg] of Object.entries(CHAINS)) {
    if (only && only !== name) continue;
    const chain = { id: cfg.id, name, rpcUrls: { default: { http: [cfg.rpc] } } };
    const pub = createPublicClient({ transport: http(cfg.rpc) });
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });

    // `--force` / FORCE_REDEPLOY=1 (the lead's flag) and `--redeploy` both force a fresh instance.
    const force = REDEPLOY || process.env.FORCE_REDEPLOY === "1" || process.argv.includes("--force");
    let addr;
    let hash;
    let blockNumber;

    // F64: an entry deployed before the fix (no matching `revision`) is not reused.
    // It is kept, labelled, under `clearingSuperseded`, and a fresh instance is deployed.
    const prior = db.jobEscrow?.[name];
    if (prior?.address && (force || prior.revision !== REVISION)) {
      db.jobEscrowSuperseded ??= [];
      db.jobEscrowSuperseded.push({ network: name, ...prior, supersededAt: new Date().toISOString(), reason: SUPERSEDED_REASON });
      delete db.jobEscrow[name];
      console.log(`\n${name}: superseding ${prior.address} (${prior.revision ?? "pre-F64"})`);
    }

    if (db.jobEscrow?.[name]?.address) {
      addr = db.jobEscrow[name].address;
      hash = db.jobEscrow[name].deployTx;
      blockNumber = db.jobEscrow[name].deployBlock;
      console.log(`\n=== ${cfg.name} (${cfg.id}) [already deployed at ${addr}] ===`);
    } else {
      hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode,
        args: [],
        chain,
        account,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });

      if (rc.status !== "success") throw new Error(`${name}: deployment reverted`);
      addr = rc.contractAddress;
      blockNumber = Number(rc.blockNumber);
      console.log(`\n=== ${cfg.name} (${cfg.id}) ===`);
      console.log(`  deployer  ${account.address}`);
      console.log(`  clearing  ${addr}`);
      console.log(`  caip10    eip155:${cfg.id}:${addr}`);
      console.log(`  tx        ${hash}`);
      console.log(`  block     ${blockNumber}`);
    }

    // The escrow has no operator view, so verification is the code itself:
    // the runtime at the address must byte-match the compiled artifact — not
    // merely be a contract that answers something.
    let code;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        code = await pub.getCode({ address: addr });
        if (code && code !== "0x") break;
        console.log(`  waiting for RPC replica (attempt ${attempt}/6)...`);
      } catch (err) {
        if (attempt === 6) throw err;
        console.log(`  waiting for RPC replica (attempt ${attempt}/6)...`);
      }
      if (attempt < 6) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!code || code === "0x") {
      throw new Error(`${name}: no code at ${addr} after deploy`);
    }
    console.log(`  verified  code present at ${addr} (${(code.length - 2) / 2} bytes)`);

    // The code must be the code we compiled, not just any contract.
    const runtimeCodeMatchesArtifact = code?.toLowerCase() === artifact.deployedBytecode.object.toLowerCase();
    if (!runtimeCodeMatchesArtifact) throw new Error(`${name}: runtime code at ${addr} does not match ${ART}`);
    console.log(`  verified  runtime code == ${ART} (${(code.length - 2) / 2} bytes)`);

    db.jobEscrow[name] = {
      address: addr,
      caip10: `eip155:${cfg.id}:${addr}`,
      chainId: cfg.id,
      deployer: account.address,
      deployTx: hash,
      deployBlock: blockNumber,
      revision: REVISION,
      runtimeCodeMatchesArtifact,
    };
  }

  writeFileSync(OUT, JSON.stringify(db, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
