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
    lockTx: "0x2d8127923d8a52750d183e27095ae784d6c4c80860738aa375642afb0c07486c",
    refundTx: "0x05dd1f712c0ae3232769411c73d252f554a88be6c14f2a45e3828a14127849bf",
    expectedAmount: 1000n,
    expectedClient: "0xAeA8bc34df7745e35510214147a2F6A5e15Eb26D",
  },
  {
    chainName: "Tempo Moderato (42431)",
    rpc: "https://rpc.moderato.tempo.xyz",
    lockTx: "0xc43de9845ade2bf7da02aa862ab963249153534410ff6122bce9728a22a284c0",
    refundTx: "0x43e5a00d81cd9ef7d75d56aeeefabdf613c9dc5bc6d235c4545c6fd191b1338c",
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
