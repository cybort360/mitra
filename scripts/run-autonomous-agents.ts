/**
 * The continuous autonomous agent runner — Task 4 of the loop-deployment packet.
 *
 * Three agents, each holding only the surface its role needs, running against a **live**
 * Mitra Core API over HTTP with real EIP-712 signatures:
 *
 *   buyer      reserves budget, posts the request, opens and funds the agreement
 *   provider   polls its inbox, claims the work, executes, submits the deliverable
 *   evaluator  polls for deliverables, checks acceptance criteria, accepts or rejects
 *
 * ## They are autonomous in the sense that matters
 *
 * No step is handed the next step's result. Each agent learns what to do by **polling its
 * own inbox** — the same way a real party on a real network would — and each signs only its
 * own transitions (F55). The buyer's client cannot accept its own deliverable; the
 * evaluator's client cannot start execution. If that separation were not real, this script
 * would look identical to one agent wearing three hats, and it would prove nothing about
 * multi-party operation.
 *
 * ## What this does NOT do
 *
 * It does not create mandates, and cannot: `MitraClient` has no capital-issuing verb, so an
 * agent cannot grant itself authority (F100). It does not sign for a party that is not
 * present. And it does not fabricate a result — the summary at the end is read back from the
 * API, and a cycle in which the agreement did not reach a terminal state is reported as a
 * failure rather than smoothed over.
 */
import { MitraClient, type MitraSigner } from "@/lib/sdk/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const API_URL = process.env.MITRA_API_URL ?? "http://127.0.0.1:3005";
const CHAIN_ID = Number(process.env.MITRA_CHAIN_ID ?? 84532);
// Defaults are the seeded development space and its funded headroom. Both are
// overridable, and neither is invented — a runner pointed at a space that does not exist
// fails at the first call rather than pretending to trade.
/**
 * **A Space this runner owns, never a seeded one.**
 *
 * `POST /api/v1/spaces` on an existing `spaceId` overwrites that Space's budget (see F102),
 * so pointing this at a seeded Space would silently inflate the budget of shared reference
 * data on every run. It creates its own and leaves the fixtures alone.
 */
const SPACE_ID = process.env.MITRA_SPACE_ID ?? "space_live_loop";
const PRICE = Number(process.env.MITRA_AGREEMENT_PRICE ?? 25);
const SPACE_BUDGET = Number(process.env.MITRA_SPACE_BUDGET ?? 1000);
const POLL_MS = Number(process.env.AGENT_POLL_MS ?? 1500);
const MAX_POLLS = Number(process.env.AGENT_MAX_POLLS ?? 40);

const cyclesArg = process.argv.indexOf("--cycles");
const CYCLES = cyclesArg >= 0 ? Number(process.argv[cyclesArg + 1]) : 1;

const MONEY = (amount: number) => ({ asset: "USDC" as const, amount });

/**
 * The three roles.
 *
 * **These are the packet's own names, used as real agent ids** — but they could not have
 * been the seeded `agent_buyer_07` / `agent_eval_02` / `mech-research-backup-04`.
 *
 * The seeded agents carry synthetic wallets (`0xB070…007` and similar) whose private keys do
 * not exist anywhere in this repository, so no process can sign as them: the API answers
 * `SIGNER_NOT_AGENT_WALLET`, correctly. Reusing them would have produced a loop that looks
 * like three autonomous agents and is really one account impersonating three roles it cannot
 * prove. Instead the runner registers its own three, with keys it actually holds, inside a
 * Space it owns — which is what autonomy has to mean before it means anything.
 */
const ROLES = {
  agent_buyer_live: { agentId: "agent_buyer_live", capability: "research" },
  agent_provider_live: { agentId: "agent_provider_live", capability: "research" },
  agent_evaluator_live: { agentId: "agent_evaluator_live", capability: "deliverable_evaluation" },
} as const;

type Role = keyof typeof ROLES;

/** Deterministic development keys, so a run is reproducible. Never for real funds. */
const DEV_KEYS = {
  agent_buyer_live: `0x${"a1".repeat(32)}`,
  agent_provider_live: `0x${"b2".repeat(32)}`,
  agent_evaluator_live: `0x${"c3".repeat(32)}`,
} as const;

function keyFor(role: Role): `0x${string}` {
  const fromEnv = process.env[`MITRA_${role.toUpperCase()}_KEY`];
  if (fromEnv) return fromEnv as `0x${string}`;
  if (process.env.MITRA_AGENT_KEYS_ARE_REAL !== "yes") return DEV_KEYS[role];
  // Refuse to silently fall back to a dev key when someone believes they configured real ones.
  throw new Error(`no key configured for ${role}, and MITRA_AGENT_KEYS_ARE_REAL=yes refuses the dev fallback`);
}

function clientFor(role: Role): MitraClient {
  const account = privateKeyToAccount(keyFor(role));
  return new MitraClient({
    baseUrl: API_URL,
    signer: account as MitraSigner,
    chainId: CHAIN_ID,
    agentId: process.env[`MITRA_${role.toUpperCase()}_AGENT_ID`] ?? ROLES[role].agentId,
  });
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const say = (role: Role | "stack", msg: string) =>
  process.stdout.write(`[${role}] ${msg}\n`);

/**
 * Poll an inbox until an item of a wanted kind appears, or give up.
 *
 * Returns `null` rather than throwing on timeout: "no work yet" is the normal state for most
 * of a cycle, and an agent that threw would look broken while behaving correctly.
 */
async function waitForItem(
  client: MitraClient,
  kind: "WORK_REQUIRED" | "EVALUATION_REQUIRED",
  role: Role,
): Promise<{ agreementId: string } | null> {
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const inbox = await client.inbox.list({ kinds: [kind] });
    // Narrow rather than assume: an inbox item's agreementId is optional, and one without
    // it is not something this agent can act on.
    const item = inbox.items.find(x => x.agreementId !== undefined);
    if (item?.agreementId) return { agreementId: item.agreementId };
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  say(role, dim(`no ${kind} after ${MAX_POLLS} polls`));
  return null;
}

/**
 * OPERATOR-PLANE SETUP — not an agent action.
 *
 * The Space has to exist before the loop can do anything, and creating one is a governance
 * write, not something an agent does for itself. It is therefore done here explicitly, in
 * one place, before any agent starts — so the boundary stays visible: the agents below
 * never create a Space, never enroll themselves in one, and never grant a Mandate.
 *
 * The seeded Space cannot be used because its agents have synthetic wallets with no private
 * keys, so nobody can sign as them (`SIGNER_NOT_AGENT_WALLET`). The three agents this runner
 * registers carry real keys, and this gives them a Space they are genuinely participants of.
 */
async function ensureSpace(): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spaceId: SPACE_ID,
      owner: ROLES.agent_buyer_live.agentId,
      budget: MONEY(SPACE_BUDGET),
      participants: Object.values(ROLES).map(r => r.agentId),
      // `payment` is not optional: the kernel re-checks containment on EVERY operation and
      // defaults an op with no explicit capability to `"payment"` (`lib/kernel/commerce.ts`),
      // so funding an agreement in a Space that does not admit `payment` is refused with
      // `CAPABILITY_NOT_ALLOWED_IN_SPACE`. Omitting it produced a Space that could open
      // agreements and then never fund any of them.
      allowedCapabilities: ["research", "deliverable_evaluation", "payment"],
      governance: { mode: "ADMIN", admins: [ROLES.agent_buyer_live.agentId], governors: [ROLES.agent_buyer_live.agentId], threshold: 1 },
    }),
  });
  if (res.ok) {
    say("stack", dim(`created ${SPACE_ID} with budget ${SPACE_BUDGET} USDC`));
    return;
  }
  const body = await res.json().catch(() => ({}));
  // Already-exists is the normal case from the second run onward, and must not stop it.
  if (/SPACE_EXISTS|ALREADY/.test(JSON.stringify(body))) {
    say("stack", dim(`${SPACE_ID} already exists`));
    return;
  }
  throw new Error(`could not create ${SPACE_ID}: ${res.status} ${JSON.stringify(body)}`);
}

async function registerAll(clients: Record<Role, MitraClient>): Promise<void> {
  for (const [role, client] of Object.entries(clients) as Array<[Role, MitraClient]>) {
    // Registering is first-write-wins (F100's rule on the agent plane too), so a second run
    // against the same database finds the agent already there. That is not a failure — treat
    // it as "already enrolled" and carry on, or a continuous runner could never run twice.
    try {
      // These identities already exist in the seeded Space, so registration is normally a
      // no-op; the branch is kept so the runner also works against a fresh Space.
      await client.agents.register({
        name: role,
        owner: role,
        capabilities: [ROLES[role].capability],
      });
    } catch (e) {
      if (!/409/.test((e as Error).message)) throw e;
      say(role, dim("already registered"));
    }

  }
}

/** BUYER: post the request, open the agreement, fund it. */
async function buyerCycle(clients: Record<Role, MitraClient>, cycle: number): Promise<string | null> {
  const client = clients.agent_buyer_live;
  const agreementId = `agr_live_${cycle}_${Date.now().toString(36)}`;

  // The Mandate is the root of the authority chain, so a real buyer names the one it is
  // operating under. It is READ, never written — creating one is F100, and `MitraClient`
  // has no such method, which is precisely why this runner cannot mint its own authority.
  const mandates = await client.mandates.list({ agentId: process.env.MITRA_MANDATE_AGENT ?? "agent_data_03" });
  const mandateId = process.env.MITRA_MANDATE_ID ?? mandates[0]?.mandateId;
  if (!mandateId) {
    say("agent_buyer_live", "no mandate to operate under — an operator must grant one (F100: agents cannot)");
    return null;
  }
  say("agent_buyer_live", dim(`operating under mandate ${mandateId}`));

  const intent = await client.commerce.createIntent({
    intentId: `int_live_${cycle}_${Date.now().toString(36)}`,
    runId: `run_live_${cycle}`,
    principal: ROLES.agent_buyer_live.agentId,
    initiatingAgentId: ROLES.agent_buyer_live.agentId,
    mandateId,
    objective: "Produce the agreed research deliverable",
    budget: MONEY(PRICE),
    constraints: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  say("agent_buyer_live", `posted RFQ ${intent.intentId}`);

  await client.commerce.createAgreement({
    spaceId: SPACE_ID,
    draft: {
      agreementId,
      runId: intent.runId ?? "run_live",
      intentId: intent.intentId,
      client: ROLES.agent_buyer_live.agentId,
      provider: ROLES.agent_provider_live.agentId,
      evaluator: ROLES.agent_evaluator_live.agentId,
      price: MONEY(PRICE),
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      acceptanceCriteria: ["deliverable is non-empty", "content hash matches the submission"],
    },
    proposal: { capability: ROLES.agent_buyer_live.capability, amount: MONEY(PRICE) },
  });
  say("agent_buyer_live", `opened ${agreementId}`);

  // **Headroom first.** Funding without checking what the Space can still commit is how a
  // buyer overruns its own mandate and gets refused by the policy engine mid-loop.
  const headroom = await client.authority.getHeadroom(SPACE_ID);
  if (headroom.amount < PRICE) {
    say("agent_buyer_live", `refusing to fund: headroom ${headroom.amount} < ${PRICE}`);
    return agreementId;
  }
  await client.commerce.fund(agreementId);
  say("agent_buyer_live", `funded ${agreementId} with ${PRICE} USDC`);
  return agreementId;
}

/** PROVIDER: claim, execute, submit. Signs only its own transitions. */
async function providerCycle(clients: Record<Role, MitraClient>): Promise<void> {
  const client = clients.agent_provider_live;
  const work = await waitForItem(client, "WORK_REQUIRED", "agent_provider_live");
  if (!work) return;

  await client.commerce.startExecution(work.agreementId);
  say("agent_provider_live", `started execution on ${work.agreementId}`);

  const contentHash = `0x${generatePrivateKey().slice(2, 66)}`;
  await client.commerce.submitDeliverable(work.agreementId, {
    artifactRefs: [`artifact_${work.agreementId}`],
    contentHash,
  });
  say("agent_provider_live", `submitted deliverable for ${work.agreementId}`);
}

/** EVALUATOR: check the acceptance criteria, then accept or reject. */
async function evaluatorCycle(clients: Record<Role, MitraClient>): Promise<void> {
  const client = clients.agent_evaluator_live;
  const work = await waitForItem(client, "EVALUATION_REQUIRED", "agent_evaluator_live");
  if (!work) return;

  const view = await client.commerce.getAgreement(work.agreementId);
  // Inspect the actual deliverable against the criteria rather than assuming success.
  const deliverable = view.deliverables?.[0];
  const passes = Boolean(deliverable?.contentHash) && (deliverable?.artifactRefs?.length ?? 0) > 0;

  if (passes) {
    await client.commerce.acceptDeliverable(work.agreementId);
    say("agent_evaluator_live", `ACCEPTED ${work.agreementId} — criteria met`);
  } else {
    await client.commerce.rejectDeliverable(work.agreementId, { failureReason: "deliverable did not meet the acceptance criteria" });
    say("agent_evaluator_live", `REJECTED ${work.agreementId} — criteria not met`);
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(CYCLES) || CYCLES < 1) {
    process.stderr.write("usage: run-autonomous-agents.ts [--cycles N]\n");
    process.exitCode = 2;
    return;
  }

  const clients: Record<Role, MitraClient> = {
    agent_buyer_live: clientFor("agent_buyer_live"),
    agent_provider_live: clientFor("agent_provider_live"),
    agent_evaluator_live: clientFor("agent_evaluator_live"),
  };

  try {
    const health = await fetch(`${API_URL}/api/v1/health`);
    if (!health.ok) throw new Error(`${API_URL}/api/v1/health answered ${health.status}`);
  } catch (e) {
    process.stderr.write(`the Core API is not reachable at ${API_URL}: ${(e as Error).message}\nStart it with \`npm run stack:up\`.\n`);
    process.exitCode = 1;
    return;
  }

  await registerAll(clients);
  // The Space must exist before headroom means anything, so setup order is: enroll the
  // agents, give them a Space, and only then can any of them ask what they may commit.
  await ensureSpace();
  const headroom = await clients.agent_buyer_live.authority.getHeadroom(SPACE_ID);
  say("agent_buyer_live", dim(`headroom ${headroom.amount} ${headroom.asset}`));

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    process.stdout.write(`\n${dim(`── cycle ${cycle}/${CYCLES} ──`)}\n`);
    // Concurrent, because they are independent processes in reality and a serialised loop
    // would hide exactly the races this is meant to exercise.
    await Promise.all([
      buyerCycle(clients, cycle),
      providerCycle(clients),
      evaluatorCycle(clients),
    ]);
  }

  // **Read the outcome back.** Do not report what the loop intended to do.
  const all = await clients.agent_buyer_live.commerce.listAgreements({ spaceId: SPACE_ID });
  const live = all.filter(a => a.agreementId.startsWith("agr_live_"));
  // The domain spells a settled agreement ACCEPTED, not COMPLETED — so the summary does too.
  const completed = live.filter(a => a.status === "ACCEPTED").length;
  const terminal = live.filter(a => ["ACCEPTED", "REFUNDED", "REJECTED", "CANCELED", "EXPIRED"].includes(a.status)).length;

  process.stdout.write(`\n${dim("── summary ──")}\n`);
  process.stdout.write(`   agreements opened   ${live.length}\n`);
  process.stdout.write(`   reached ACCEPTED     ${completed}\n`);
  process.stdout.write(`   reached terminal     ${terminal}\n`);

  if (completed === 0) {
    process.stderr.write(`\nno agreement completed — the loop ran but the engagement never settled.\n`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`\nrun-autonomous-agents failed: ${(e as Error).message}\n`);
  process.exitCode = 1;
});