/**
 * `npm run sandbox`: the PP-7 sandbox's three scenarios, printed as they happen.
 *
 *   1. delivered and accepted: the escrow pays the provider on chain
 *   2. withheld: the chain clock jumps two hours and the contract's timeout refund runs
 *   3. garbage: the evaluator rejects and the committed route refunds the escrow
 *
 * Needs anvil (Foundry). Runs on a throwaway chain and the in-memory store; see
 * lib/sandbox/index.ts for what is real and what is scripted.
 */
import { startSandbox, type Sandbox } from "@/lib/sandbox";

const STATUS = ["none", "funded", "completed", "refunded"];
const usdc = (units: bigint) => `${Number(units) / 1e6} USDC`;

async function show(sb: Sandbox, id: string, label: string) {
  const a = await sb.client.mitra.commerce.getAgreement(id);
  console.log(`   ${label}: Mitra ${a.status}, escrow ${STATUS[await sb.escrowStatus(id)]}`);
}

async function main() {
  const sb = await startSandbox({ adversary: "withhold" });
  try {
    console.log(`\n${sb.banner}\n`);
    console.log(`chain ${sb.chain.rpcUrl} (id ${sb.chain.chainId}), escrow ${sb.chain.escrow}`);
    console.log(`client ${sb.client.agentId} holds ${usdc(await sb.chain.tokenBalance(sb.client.account.address))}\n`);

    console.log("1. delivered and accepted");
    await sb.openAgreement({ agreementId: "demo_happy", price: 25 });
    await sb.fund("demo_happy");
    for (const l of [...(await sb.tick()), ...(await sb.tick())]) console.log(`   ${l}`);
    await show(sb, "demo_happy", "result");
    console.log(`   provider holds ${usdc(await sb.chain.tokenBalance(sb.provider.account.address))}\n`);

    console.log("2. withheld, then the escrow times out");
    await sb.openAgreement({ agreementId: "demo_timeout", provider: "adversary", price: 40, timeoutSeconds: 7200 });
    await sb.fund("demo_timeout");
    for (const l of [...(await sb.tick()), ...(await sb.tick())]) console.log(`   ${l}`);
    const t0 = await sb.clock.now();
    const t1 = await sb.clock.advanceSeconds(7200);
    console.log(`   chain clock +${t1 - t0}s`);
    console.log(`   keeper refundJob ${await sb.keeper.refundTimedOut("demo_timeout")}`);
    // F97. Before the fix this read "Mitra EXECUTING, escrow refunded": the keeper is not a
    // party and tells nobody, so the agreement kept claiming capital it had already lost.
    // The read now reconciles against the chain, so the FIRST observation is already correct.
    await show(sb, "demo_timeout", "Mitra learns of it from the chain (F97)");
    // And the client's own refund op is now correctly refused as terminal rather than
    // re-refunding. Demonstrating the idempotence, not the transition.
    try {
      await sb.client.mitra.recovery.refundEscrow("demo_timeout", { failureReason: "PROVIDER_TIMEOUT" });
      await show(sb, "demo_timeout", "client refund op (unexpected)");
    } catch (e) {
      console.log(`   client's refund op: ${(e as { code?: string }).code ?? "refused"} — already REFUNDED, no second refund`);
    }
    await show(sb, "demo_timeout", "unchanged");
    console.log("");

    console.log("3. garbage, rejected");
    sb.adversary.behaviour = "garbage";
    await sb.openAgreement({ agreementId: "demo_garbage", provider: "adversary", price: 10 });
    await sb.fund("demo_garbage");
    for (const l of [...(await sb.tick()), ...(await sb.tick())]) console.log(`   ${l}`);
    await show(sb, "demo_garbage", "result");
    console.log(`\nclient holds ${usdc(await sb.chain.tokenBalance(sb.client.account.address))}`);
  } finally {
    await sb.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
