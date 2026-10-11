/**
 * Standing autonomous keeper — PRD §28.5, F97.
 *
 * A keeper's whole job is the obligation nobody else has: **the refund that has to happen
 * after the deadline passes**, for parties that may themselves have gone away. The contract
 * makes that permissionless deliberately, so recovery does not depend on buyer or provider
 * cooperation. What is missing in a deployed system is not the ability, but the *timer* —
 * something has to notice the deadline passed. That is this process.
 *
 * ## What a keeper can and cannot do
 *
 * It can call `refundJob` / `refundEscrow` — after the deadline, for anyone, to return capital
 * to its owner. It needs a funded account for gas and **no role in any agreement**. It never
 * signs a `completeJob`, never calls the release path, and never touches a `dispute` it did
 * not observe. The asymmetry is the security property: **a keeper can move capital out of an
 * escrow, and only ever out — it can never move capital into one.**
 *
 * ## Why `--once` exists
 *
 * A daemon that can only run forever is untestable and untrustworthy in CI. `--once` runs a
 * single pass and exits with a status a caller can assert on, so "the keeper finds and
 * refunds an overdue escrow" is a pinned test rather than a claim.
 *
 * Exit codes are meaningful on purpose: 0 = nothing was due (healthy), 3 = at least one
 * agreement was refused or failed. A keeper that cannot refund must not report success.
 */
import type { EscrowRail, EscrowTerms } from "@/lib/commerce/onchain-escrow";
import { reconcileAgreementEscrow, type KeeperOutcome } from "@/lib/commerce/escrow-reconcile";
import type { Agreement } from "@/lib/domain/types";

const ONCE = process.argv.includes("--once");
const QUIET = process.argv.includes("--quiet");

export interface KeeperEvent {
  agreementId: string;
  action: KeeperOutcome["action"];
  reason?: string;
  txHash?: string;
}

export interface KeeperTarget {
  agreement: Agreement;
  intended: EscrowTerms;
}

export interface KeeperPassResult {
  scanned: number;
  due: number;
  refunded: number;
  observed: number;
  refused: number;
  outcomes: KeeperEvent[];
}

/** Statuses where capital can still be sitting in an escrow. */
const LIVE_STATUSES = new Set<Agreement["status"]>(["FUNDED", "EXECUTING", "SUBMITTED"]);

/**
 * The due-set: agreements that could still need a refund.
 *
 * **Only agreements this store believes have an escrow.** An agreement with no escrow cannot
 * have capital to return, and probing the chain for each of thousands of non-funded
 * agreements would be pure cost. The filter is `status ∈ LIVE`, not "status is bad" —
 * an agreement that is merely unexecuted has nothing to protect.
 */
export function selectDueTargets(
  agreements: readonly Agreement[],
  intendedFor: (agreement: Agreement) => EscrowTerms,
): KeeperTarget[] {
  return agreements
    .filter(a => LIVE_STATUSES.has(a.status))
    // Only agreements that actually located their escrow (F97) and recorded a deadline.
    // An agreement without either cannot be judged overdue from the repository, and
    // guessing a timeout would either refund early or never.
    .filter(a => Boolean(a.escrowRef) && a.escrowTimeout !== undefined)
    .map(agreement => ({ agreement, intended: intendedFor(agreement) }));
}

/**
 * One pass. Pure with respect to the clock and the rail, so a test can drive it directly.
 *
 * `now` is injected rather than read from `Date.now()` here, because the deadline is on
 * chain: a keeper whose clock is wrong could refuse a genuinely overdue refund, or (worse,
 * if it trusted its own clock over the chain's) act early. The caller passes chain time when
 * it can get it.
 */
export async function runKeeperPass(targets: readonly KeeperTarget[], rail: EscrowRail, now: number): Promise<KeeperPassResult> {
  const result: KeeperPassResult = { scanned: targets.length, due: 0, refunded: 0, observed: 0, refused: 0, outcomes: [] };

  for (const target of targets) {
    const outcome = await reconcileAgreementEscrow({ agreement: target.agreement, rail, intended: target.intended, now });

    if (outcome.action === "refunded") {
      result.refunded += 1;
      result.due += 1;
      result.outcomes.push({ agreementId: target.agreement.agreementId, action: "refunded", txHash: outcome.txHash });
      continue;
    }

    if (outcome.action === "refused") {
      result.refused += 1;
      result.outcomes.push({ agreementId: target.agreement.agreementId, action: "refused", reason: outcome.reason });
      continue;
    }

    // "observed" is the common, healthy case: not due yet, or already settled by someone else.
    if (Number(target.intended.timeout) <= now) result.due += 1;
    result.observed += 1;
    result.outcomes.push({ agreementId: target.agreement.agreementId, action: "observed", reason: outcome.reason });
  }

  return result;
}

function report(result: KeeperPassResult): void {
  if (QUIET) return;
  const parts = [
    `scanned ${result.scanned}`,
    `${result.due} due`,
    `${result.refunded} refunded`,
    `${result.observed} observed`,
  ];
  if (result.refused) parts.push(`${result.refused} REFUSED`);
  process.stdout.write(`[keeper] ${parts.join(" · ")}\n`);
  for (const o of result.outcomes) {
    if (o.action === "observed") continue;
    process.stdout.write(`[keeper]   ${o.agreementId}: ${o.action}${o.txHash ? ` ${o.txHash}` : ""}${o.reason ? ` (${o.reason})` : ""}\n`);
  }
}

/**
 * Chain time, not wall-clock time.
 *
 * The deadline is enforced by the contract against `block.timestamp`. A keeper that used its
 * own clock could be ahead of the chain and try to refund a job the chain still considers
 * live — it would simply revert, but the standing loop would fill a log with doomed
 * broadcasts. Reading the latest block is one RPC call per pass, and it makes the local
 * check agree with the authority that actually decides.
 */
function chainNow(): number {
  // TODO(F97): when the rail exposes a block reader, take `block.timestamp` from the latest
  // block so the local check agrees with the authority that enforces it. Until then the
  // clock is only ever used for an early exit — the contract's own `require` remains the
  // decision, so a wrong clock costs a reverted broadcast, never an early refund.
  return Math.floor(Date.now() / 1000);
}

async function main(): Promise<number> {
  const { resolveEscrowRail } = await import("@/lib/commerce/escrow-rail");
  const { getStore } = await import("@/lib/store/provider");

  const chain = process.env.MITRA_CHAIN ?? "baseSepolia";
  const rail = resolveEscrowRail(chain);
  // `resolveEscrowRail` returning null is a refusal, never "nothing to do".
  if (!rail) {
    // Refuse loudly. A keeper with no chain is not a keeper that found nothing to do —
    // it is a keeper that cannot see, and reporting "scanned 0" would be a lie.
    process.stderr.write(
      `[keeper] no escrow rail for "${chain}". Set MITRA_EVM_SETTLEMENT_KEY(_FILE) and the RPC, or MITRA_CHAIN=local with MITRA_LOCAL_EVM_RPC + MITRA_LOCAL_JOB_ESCROW.\n`,
    );
    return 2;
  }

  const store = await getStore();
  const agreements = await store.repo.listAgreements();
  const targets = selectDueTargets(agreements, agreement => ({
    amount: BigInt(Math.round(Number(agreement.price ?? 0) * 1e6)),
    provider: agreement.payTo?.address ?? "",
    client: agreement.client,
    // `escrowTimeout` is the deadline written at fund time (F97). An agreement with an
    // escrow but no recorded timeout cannot be judged overdue from here — the chain still
    // enforces it, so it is simply skipped rather than guessed at.
    timeout: BigInt(Math.floor(agreement.escrowTimeout ?? 0)),
  }));

  const result = await runKeeperPass(targets, rail, chainNow());
  report(result);

  // Persist any healing, so a reader is not still told the capital is escrowed.
  // Persist the healing, so a reader is not still told the capital is escrowed. `saveAgreement`
  // is optional on the repository interface (F100's F79 cousin — some backends lack it), so
  // this is a reported gap rather than an assumption that it worked.
  if (result.refunded > 0) {
    if (!store.repo.saveAgreement) {
      process.stderr.write(`[keeper] ${result.refunded} refunded but this backend cannot persist agreement updates; the read path will disagree with the chain.\n`);
    } else {
      for (const event of result.outcomes) {
        if (event.action !== "refunded") continue;
        const healed = targets.find(t => t.agreement.agreementId === event.agreementId);
        if (healed) {
          await store.repo.saveAgreement({
            ...healed.agreement, status: "REFUNDED", escrowReleased: true, version: healed.agreement.version + 1,
          });
        }
      }
    }
  }

  return result.refused > 0 ? 3 : 0;
}

if (process.argv[1]?.endsWith("keeper-daemon.ts")) {
  if (ONCE) {
    process.exit(await main());
  } else {
    const pollMs = Number(process.env.KEEPER_POLL_MS ?? 5000);
    process.stdout.write(`[keeper] standing loop, every ${pollMs}ms. Set --once for a single pass.\n`);
    let running = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => { running = false; });
    }
    let lastCode = 0;
    while (running) {
      try {
        lastCode = await main();
      } catch (e) {
        // A standing daemon that dies on one bad pass is worse than useless: it looks alive in
        // the process table while refunding nothing.
        lastCode = 3;
        process.stderr.write(`[keeper] pass failed: ${(e as Error).message}\n`);
      }
      if (!running) break;
      await new Promise(r => setTimeout(r, pollMs));
    }
    process.exit(lastCode);
  }
}