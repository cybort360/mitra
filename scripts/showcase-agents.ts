/**
 * Multi-agent live showcase — `npm run showcase:full`.
 *
 * Four acts on a real anvil chain against the real compiled `MitraJobEscrow`, with the real
 * route handlers served in-process. Every agent signs its own transitions with its own key;
 * none of them holds the client's key except the client.
 *
 * ```
 * ACT 0  Infrastructure boot         anvil, deploy, 100,000 USDC seeded
 * ACT 1  Authority & engagement      Mandate → Intent → Agreement → escrow LOCKED
 * ACT 2  Delivery & evaluation       inbox → start → submit(hash+ref) → accept → escrow RELEASED
 * ACT 3  Adversarial timeout         withhold → clock +7200s → keeper refund → reconcile REFUNDED
 * ACT 4  Telemetry                   the run log, and what actually moved
 * ```
 *
 * ## Why this builds on `startSandbox` rather than re-implementing anvil
 *
 * The sandbox already boots the chain, deploys the contract, seeds funds, drives the four
 * counterparty roles and exposes the clock and keeper. A second copy of that would be a
 * second thing to keep correct — and the one that silently drifts is the one nobody runs.
 * So this composes it and adds only what the showcase is actually for: **the authority root
 * made visible**, and **a ledger at the end** saying what moved.
 *
 * ## What is deliberately NOT here
 *
 * No synthetic results. Every number printed is read back from the chain or the store after
 * the fact. If an act fails, the script says which and exits non-zero rather than continuing
 * to a tidy summary — a showcase that completes anyway is a demo, not evidence.
 */
import { startSandbox } from "@/lib/sandbox";
import { getStore } from "@/lib/store/provider";

const RESET = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}${RESET}`;
const green = (s: string) => `\x1b[32m${s}${RESET}`;
const red = (s: string) => `\x1b[31m${s}${RESET}`;

const usdc = (n: bigint) => (Number(n) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The escrow's on-chain status, as the contract records it. */
const ESCROW: Record<number, string> = { 0: "NONE", 1: "FUNDED", 2: "COMPLETED", 3: "REFUNDED" };

class ShowcaseFailure extends Error {}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    throw new ShowcaseFailure("DATABASE_URL is set. The showcase runs only on the in-memory store; unset it.");
  }

  console.log(`\n${bold("MITRA — MULTI-AGENT LIVE SHOWCASE")}`);
  console.log(dim("three agents, real signatures, real escrow, one adversarial timeout\n"));

  // ── ACT 0 ─────────────────────────────────────────────────────────────────
  console.log(bold("ACT 0  Infrastructure boot"));
  const sb = await startSandbox({ adversary: "withhold" });
  try {
    console.log(`   chain     ${sb.chain.rpcUrl} (id ${sb.chain.chainId})`);
    console.log(`   escrow    ${sb.chain.escrow}`);
    console.log(`   client    ${sb.client.agentId} · ${usdc(await sb.chain.tokenBalance(sb.client.account.address))} USDC`);
    console.log(`   provider  ${sb.provider.agentId}`);
    console.log(`   evaluator ${sb.evaluator.agentId}\n`);

    // ── ACT 1 ─────────────────────────────────────────────────────────────────
    console.log(bold("ACT 1  Authority & engagement"));
    const mandate = sb.mandates[0];
    if (!mandate) throw new ShowcaseFailure("no Mandate was seeded — the authority tree has no root");

    // The buyer reads its own ceiling through the PUBLIC API, not from a fixture object.
    const readBack = await sb.client.mitra.mandates.get(mandate.mandateId);
    if (readBack.budget !== mandate.budget) {
      throw new ShowcaseFailure(`Mandate read back with budget ${readBack.budget}, seeded ${mandate.budget}`);
    }
    console.log(`   mandate   ${readBack.mandateId} · ${readBack.status} · ` +
      `≤${usdc(BigInt(readBack.maxTransaction * 1e6))}/tx of ${usdc(BigInt(readBack.budget * 1e6))} ${readBack.asset}`);
    console.log(dim(`             read back through GET /api/v1/mandates, not from the seed`));

    const intent = await sb.client.mitra.commerce.createIntent({
      intentId: `intent_showcase_${Date.now()}`,
      runId: "run_showcase",
      principal: "Mitra Labs (showcase)",
      initiatingAgentId: sb.client.agentId,
      mandateId: readBack.mandateId,
      objective: "Competitive AI agent economics report",
      budget: { asset: "USDC", amount: 25 },
      constraints: ["covers 100 companies", "no vendor lock-in"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    console.log(`   intent    ${intent.intentId}`);

    const AGREE_A = "showcase_delivered";
    await sb.openAgreement({ agreementId: AGREE_A, price: 25 });
    const clientBeforeA = await sb.chain.tokenBalance(sb.client.account.address);
    await sb.fund(AGREE_A);
    const locked = await sb.chain.tokenBalance(sb.client.account.address);
    if (clientBeforeA - locked !== 25_000_000n) {
      throw new ShowcaseFailure(`escrow locked ${usdc(clientBeforeA - locked)} USDC, expected 25`);
    }
    console.log(`   agreement ${AGREE_A} FUNDED · escrow ${ESCROW[await sb.escrowStatus(AGREE_A)]} · 25.00 USDC locked on chain\n`);

    // ── ACT 2 ─────────────────────────────────────────────────────────────────
    console.log(bold("ACT 2  Autonomous delivery & evaluation"));
    const providerBefore = await sb.chain.tokenBalance(sb.provider.account.address);

    const duty = (await sb.provider.mitra.inbox.list({ kinds: ["WORK_REQUIRED"] })).items
      .find((i) => i.agreementId === AGREE_A);
    if (!duty) throw new ShowcaseFailure("the provider's inbox showed no WORK_REQUIRED duty");
    console.log(`   inbox     provider sees ${duty.kind} for ${duty.agreementId}`);

    await sb.provider.mitra.commerce.startExecution(AGREE_A);
    console.log(`   start     ${sb.provider.agentId} started execution (provider-signed)`);

    // Provider turn only, so the evaluator's inbox can be observed BEFORE it consumes the
    // duty — the handoff is the thing this act exists to show.
    for (const line of await sb.tick({ parties: ["provider"] })) if (line.includes(AGREE_A)) console.log(`   ${line}`);

    const agreed = await sb.client.mitra.commerce.getAgreement(AGREE_A);
    const deliverable = agreed.deliverables?.[agreed.deliverables.length - 1];
    if (!deliverable) throw new ShowcaseFailure("no deliverable was recorded — F94 regression");
    console.log(`   deliver   ${deliverable.contentHash.slice(0, 23)}… · ${deliverable.artifactRefs[0]}`);
    console.log(dim(`             read from the AGREEMENT, not handed over out of band`));

    const evalDuty = (await sb.evaluator.mitra.inbox.list({ kinds: ["EVALUATION_REQUIRED"] })).items
      .find((i) => i.agreementId === AGREE_A);
    if (!evalDuty) throw new ShowcaseFailure("the evaluator's inbox showed no EVALUATION_REQUIRED duty");
    console.log(`   inbox     evaluator sees ${evalDuty.kind} for ${evalDuty.agreementId}`);

    for (const line of await sb.tick({ parties: ["evaluator"] })) if (line.includes(AGREE_A)) console.log(`   ${line}`);

    const accepted = await sb.client.mitra.commerce.getAgreement(AGREE_A);
    if (accepted.status !== "ACCEPTED") throw new ShowcaseFailure(`expected ACCEPTED, got ${accepted.status}`);
    const providerAfter = await sb.chain.tokenBalance(sb.provider.account.address);
    if (providerAfter - providerBefore !== 25_000_000n) {
      throw new ShowcaseFailure(`the provider was paid ${usdc(providerAfter - providerBefore)} USDC, expected 25`);
    }
    console.log(`   accept    evaluator accepted · escrow ${ESCROW[await sb.escrowStatus(AGREE_A)]}`);
    console.log(`   payout    ${usdc(providerAfter - providerBefore)} USDC reached the provider's address on chain\n`);

    // ── ACT 3 ─────────────────────────────────────────────────────────────────
    console.log(bold("ACT 3  Adversarial timeout & keeper recovery"));
    const AGREE_B = "showcase_timeout";
    await sb.openAgreement({ agreementId: AGREE_B, provider: "adversary", price: 40, timeoutSeconds: 7200 });
    const clientBeforeB = await sb.chain.tokenBalance(sb.client.account.address);
    await sb.fund(AGREE_B);
    console.log(`   agreement ${AGREE_B} FUNDED · escrow ${ESCROW[await sb.escrowStatus(AGREE_B)]} · 40.00 USDC locked`);

    for (const line of await sb.tick({ parties: ["adversary"] })) if (line.includes(AGREE_B)) console.log(`   ${line}`);

    const advanced = await sb.clock.advanceSeconds(7200);
    console.log(`   clock     chain clock advanced +${advanced}s`);
    const keeperTx = await sb.keeper.refundTimedOut(AGREE_B);
    console.log(`   keeper    refundJob ${keeperTx.slice(0, 26)}…  ${dim("(an account with no role in the job)")}`);

    if (await sb.escrowStatus(AGREE_B) !== 3) throw new ShowcaseFailure("the escrow did not reach REFUNDED on chain");
    const reconciled = await sb.client.mitra.commerce.getAgreement(AGREE_B);
    if (reconciled.status !== "REFUNDED") {
      throw new ShowcaseFailure(`expected the agreement to reconcile to REFUNDED, got ${reconciled.status}`);
    }
    const clientAfterB = await sb.chain.tokenBalance(sb.client.account.address);
    if (clientAfterB !== clientBeforeB) {
      throw new ShowcaseFailure(`client holds ${usdc(clientAfterB)} after the refund, expected ${usdc(clientBeforeB)}`);
    }
    console.log(`   reconcile Mitra observed REFUNDED from the chain — nobody told it`);
    console.log(`   refund    ${usdc(clientAfterB)} USDC restored to the client, intact\n`);

    // ── ACT 4 ─────────────────────────────────────────────────────────────────
    console.log(bold("ACT 4  Telemetry"));
    const runs = [AGREE_A, AGREE_B];
    let total = 0;
    for (const agreementId of runs) {
      const { repo } = await getStore();
      const events = await repo.listEvents(`run_${agreementId}`);
      total += events.length;
      console.log(`\n   ${bold(agreementId)}  ${dim(`escrow ${ESCROW[await sb.escrowStatus(agreementId)]}`)}`);
      for (const e of events) {
        console.log(`     ${e.at.slice(11, 19)}  ${e.kind.padEnd(11)} ${dim(e.title)}`);
      }
    }
    console.log(dim(`\n   ${total} events across both runs, read back from the store\n`));

    // ── the ledger ───────────────────────────────────────────────────────────
    const clientFinal = await sb.chain.tokenBalance(sb.client.account.address);
    const providerFinal = await sb.chain.tokenBalance(sb.provider.account.address);
    const rows: Array<[string, string]> = [
      ["client on-chain balance", `${usdc(clientFinal)} USDC`],
      ["provider on-chain balance", `${usdc(providerFinal)} USDC`],
      [`agreement ${AGREE_A}`, `${ESCROW[await sb.escrowStatus(AGREE_A)]} · paid the provider 25.00`],
      [`agreement ${AGREE_B}`, `${ESCROW[await sb.escrowStatus(AGREE_B)]} · refunded to the client 40.00`],
      ["events recorded", String(total)],
    ];
    console.log(bold("LEDGER"));
    for (const [k, v] of rows) console.log(`   ${k.padEnd(28)} ${v}`);
    console.log(`\n${green("SHOWCASE COMPLETE")} — every figure above read back from the chain or the store.\n`);
  } finally {
    await sb.stop();
  }
}

main().catch((e: unknown) => {
  console.error(`\n${red("SHOWCASE FAILED")}: ${(e as Error).message}\n`);
  process.exitCode = 1;
});