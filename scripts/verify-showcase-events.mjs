#!/usr/bin/env node
/**
 * Verifies and decodes EscrowLocked and EscrowRefunded event logs
 * from the live showcase transactions on Base Sepolia and Tempo Moderato.
 *
 * Demonstrates that capital actually moved and returned on-chain,
 * closing the loop between transaction presence and event-level execution truth.
 *
 * Run:
 *   node scripts/verify-showcase-events.mjs
 */

import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";

const vaultEventsAbi = parseAbi([
  "event EscrowLocked(bytes32 indexed jobId, address indexed client, address indexed provider, address token, uint256 amount, uint64 timeout)",
  "event EscrowRefunded(bytes32 indexed jobId, address indexed client, uint256 amount)",
]);

const RUNS = [
  {
    chainName: "Base Sepolia (84532)",
    rpc: "https://sepolia.base.org",
    lockTx: "0xd585765c9735ac9dc40ba636fa1fea3af2413dadac1171f2767cc0ba5e915163",
    refundTx: "0x22096706ac5670ba580b9ccc4c7698e1e6c1df59947ecaa9375d779513eb21a3",
    expectedAmount: 1000n,
    expectedClient: "0xAeA8bc34df7745e35510214147a2F6A5e15Eb26D",
  },
  {
    chainName: "Tempo Moderato (42431)",
    rpc: "https://rpc.moderato.tempo.xyz",
    lockTx: "0x32eddfd5fa7c4d1ef58a40e8b58ac78ab6e621608ab0e1db98f663ee032313ec",
    refundTx: "0x22f3d9cdb35ec0b7829ae0e643111f9ff0cbddfd08b03b190a4549348908fd34",
    expectedAmount: 1_000_000n,
    expectedClient: "0xAeA8bc34df7745e35510214147a2F6A5e15Eb26D",
  },
];

async function main() {
  console.log("================================================================================");
  console.log("  ON-CHAIN ESCROW EVENT DECODER & CAPITAL AUDIT (ADR-0012, PRD §15)");
  console.log("================================================================================\n");

  let allPassed = true;

  for (const run of RUNS) {
    console.log(`>>> ${run.chainName}`);
    const pub = createPublicClient({ transport: http(run.rpc) });

    // 1. Audit lockEscrow event
    const rcLock = await pub.getTransactionReceipt({ hash: run.lockTx });
    let lockFound = false;
    for (const log of rcLock.logs) {
      try {
        const decoded = decodeEventLog({ abi: vaultEventsAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "EscrowLocked") {
          lockFound = true;
          const { jobId, client, provider, token, amount, timeout } = decoded.args;
          console.log(`  [EscrowLocked] Block: ${rcLock.blockNumber}`);
          console.log(`    jobId:    ${jobId}`);
          console.log(`    client:   ${client}`);
          console.log(`    provider: ${provider}`);
          console.log(`    token:    ${token}`);
          console.log(`    amount:   ${amount} atomic units`);
          console.log(`    timeout:  ${timeout}`);

          const clientMatch = client.toLowerCase() === run.expectedClient.toLowerCase();
          const amountMatch = amount === run.expectedAmount;
          console.log(`    ✓ Client check: ${clientMatch ? "PASS" : "FAIL"}`);
          console.log(`    ✓ Amount check: ${amountMatch ? "PASS" : "FAIL"}`);
          if (!clientMatch || !amountMatch) allPassed = false;
        }
      } catch (e) {
        // Ignored unmatching logs (e.g. ERC20 Transfer logs)
      }
    }
    if (!lockFound) {
      console.log("  ✗ FAILED to find EscrowLocked event in tx", run.lockTx);
      allPassed = false;
    }

    // 2. Audit refundEscrow event
    const rcRefund = await pub.getTransactionReceipt({ hash: run.refundTx });
    let refundFound = false;
    for (const log of rcRefund.logs) {
      try {
        const decoded = decodeEventLog({ abi: vaultEventsAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "EscrowRefunded") {
          refundFound = true;
          const { jobId, client, amount } = decoded.args;
          console.log(`  [EscrowRefunded] Block: ${rcRefund.blockNumber}`);
          console.log(`    jobId:    ${jobId}`);
          console.log(`    client:   ${client}`);
          console.log(`    amount:   ${amount} atomic units`);

          const clientMatch = client.toLowerCase() === run.expectedClient.toLowerCase();
          const amountMatch = amount === run.expectedAmount;
          console.log(`    ✓ Client check: ${clientMatch ? "PASS" : "FAIL"}`);
          console.log(`    ✓ Amount check: ${amountMatch ? "PASS" : "FAIL"}`);
          if (!clientMatch || !amountMatch) allPassed = false;
        }
      } catch (e) {
        // Ignored
      }
    }
    if (!refundFound) {
      console.log("  ✗ FAILED to find EscrowRefunded event in tx", run.refundTx);
      allPassed = false;
    }
    console.log();
  }

  console.log("================================================================================");
  console.log(`  RESULT: ${allPassed ? "ALL EVENTS DECODED & VERIFIED — Capital Movement Confirmed" : "VERIFICATION FAILED"}`);
  console.log("================================================================================\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
