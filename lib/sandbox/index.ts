/**
 * The Mitra sandbox (PP-7, PRD §28): a whole commerce loop on one machine, in seconds.
 *
 * What is real: Mitra's API route code, kernel and signature checks, run in-process on
 * the in-memory store; the compiled MitraJobEscrow on a throwaway anvil chain; every
 * party's EIP-712 signature. What is scripted: the counterparties' DECISIONS (a provider
 * that delivers, withholds or delivers garbage; an evaluator that checks criteria) and
 * the keeper that calls the contract's timeout refund. What moves: anvil's clock, so a
 * 2-hour escrow timeout passes in one call.
 *
 * It announces itself (`SANDBOX_BANNER`), refuses any chain but anvil's 31337, and
 * refuses to start with DATABASE_URL set, so it cannot write to a real store or a real
 * network. Nothing it reports is a settlement on any public chain.
 *
 * Both earlier workarounds are gone, and their absence is the point:
 *  - F94: the evaluator reads the deliverable from the AGREEMENT now. It used to receive it
 *    through an in-process `handover` map, which meant the sandbox judged work Mitra had
 *    never stored — so a real deployment, where no such map exists, was never exercised.
 *  - F96: the route resolves an agent-id evaluator to the relayer's own address, so the
 *    sandbox no longer has to name the evaluator by its on-chain address.
 */
import { createHash } from "node:crypto";
import { getStore } from "@/lib/store/provider";
import type { Mandate } from "@/lib/domain/types";
import { createWalletClient, http, toHex, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { MITRA_JOB_ESCROW_ABI } from "@/lib/adapters/erc8183-transport";
import { escrowIdFor } from "@/lib/commerce/onchain-escrow";
import { MitraClient, type OnChainEscrow } from "@/lib/sdk";
import { startLocalChain, type LocalChain, type SandboxClock } from "./chain";
import { SANDBOX_BASE_URL, sandboxFetch } from "./api";

export { anvilAvailable, SANDBOX_CHAIN_ID } from "./chain";

export const SANDBOX_BANNER =
  "MITRA SANDBOX: a simulation on a throwaway anvil chain (id 31337) with an in-memory store. " +
  "Counterparties are scripted. Nothing here is a settlement on any real network.";

/** Mitra signs requests under a Base chain id; it is an EIP-712 domain value, not the anvil chain. */
const SIGNING_CHAIN_ID = 84532;
const SPACE_ID = "space_sandbox";
/** 100,000 sandbox USDC (6 decimals) for the client. */
const CLIENT_FUNDS = 100_000n * 10n ** 6n;

export type ProviderBehaviour = "deliver" | "withhold" | "garbage";

export interface SandboxParty {
  agentId: string;
  account: HDAccount;
  mitra: MitraClient;
}

export interface Handover { artifactRefs: string[]; contentHash: string }

export interface OpenOptions {
  agreementId: string;
  /** Which scripted party provides: the honest provider, or the adversary. */
  provider?: "provider" | "adversary";
  /** In sandbox USDC. */
  price?: number;
  acceptanceCriteria?: string[];
  /** Seconds from the CHAIN's now until the escrow may be refunded by anyone. Default 2 hours. */
  timeoutSeconds?: number;
}

export interface Sandbox {
  banner: string;
  chain: LocalChain;
  clock: SandboxClock;
  /** The developer's agent: the client, holding 100,000 sandbox USDC. */
  client: SandboxParty;
  provider: SandboxParty;
  adversary: SandboxParty & { behaviour: ProviderBehaviour };
  evaluator: SandboxParty;
  /** F94 workaround: what each provider submitted, so the evaluator can judge it. */
  /** Kept for test introspection of what a provider submitted, NOT for the evaluator. */
  handover: Map<string, Handover>;
  /** Artifact bytes by ref, as a provider published them. */
  artifacts: Map<string, Uint8Array>;
  /** Opens an agreement in the sandbox Space, the client paying, the chosen provider working. */
  openAgreement(opts: OpenOptions): Promise<void>;
  /** Moves the price into the escrow contract and signs `fund` with the on-chain escrow. */
  fund(agreementId: string): Promise<void>;
  /** Runs each scripted counterparty once over its inbox. Returns what each did. */
  tick(): Promise<string[]>;
  keeper: {
    /** The contract's own timeout refund, called by an account with no role. Reverts before the timeout. */
    refundTimedOut(agreementId: string): Promise<Hex>;
  };
  /** The escrow's on-chain status: 0 none, 1 funded, 2 completed, 3 refunded. */
  escrowStatus(agreementId: string): Promise<number>;
  escrowRef(agreementId: string): OnChainEscrow;
  /**
   * The Mandates seeded for the client (F99).
   *
   * The authority tree is Mandate → Authorization → Intent → Agreement, and until F99 the
   * sandbox exercised only the last of those: it seeded 100,000 USDC but **zero** Mandates,
   * so nothing in the sandbox ever had to prove that a spend was authorised — the root of
   * the tree was assumed. A Mandate is now seeded and exposed so the hierarchy is reachable.
   */
  mandates: Mandate[];
  stop(): Promise<void>;
}

const ENV_KEYS = ["MITRA_LOCAL_EVM_RPC", "MITRA_LOCAL_JOB_ESCROW", "MITRA_EVM_SETTLEMENT_KEY", "MITRA_ESCROW_TOKEN_ADDRESS"] as const;

export async function startSandbox(opts: { adversary?: ProviderBehaviour } = {}): Promise<Sandbox> {
  if (process.env.DATABASE_URL) {
    throw new Error("startSandbox: DATABASE_URL is set. The sandbox runs only on the in-memory store; unset it.");
  }
  const chain = await startLocalChain();
  const [relayer, clientKey, providerKey, adversaryKey, , , , , , keeperKey] = chain.accounts;

  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MITRA_LOCAL_EVM_RPC = chain.rpcUrl;
  process.env.MITRA_LOCAL_JOB_ESCROW = chain.escrow;
  process.env.MITRA_EVM_SETTLEMENT_KEY = toHex(relayer.getHdKey().privateKey!);
  process.env.MITRA_ESCROW_TOKEN_ADDRESS = chain.token;

  const party = (agentId: string, account: HDAccount): SandboxParty => ({
    agentId, account,
    mitra: new MitraClient({ baseUrl: SANDBOX_BASE_URL, signer: account, chainId: SIGNING_CHAIN_ID, agentId, fetch: sandboxFetch }),
  });
  const client = party("sandbox_client", clientKey);
  const provider = party("sandbox_provider", providerKey);
  const adversary = { ...party("sandbox_adversary", adversaryKey), behaviour: opts.adversary ?? "withhold" as ProviderBehaviour };
  const evaluator = party(relayer.address, relayer); // F96 workaround, see the module comment

  try {
    for (const [p, caps] of [[client, ["procurement"]], [provider, ["research"]], [adversary, ["research"]], [evaluator, ["deliverable_evaluation"]]] as const) {
      await p.mitra.agents.register({ name: `Sandbox ${p.agentId}`, owner: "org:sandbox", capabilities: [...caps] });
    }
    const res = await sandboxFetch(`${SANDBOX_BASE_URL}/api/v1/spaces`, {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE_ID, owner: client.agentId, participants: [client.agentId],
        budget: { asset: "USDC", amount: 100_000 }, allowedCapabilities: ["research", "payment"], settlementChains: ["base"],
      }),
    });
    if (res.status !== 201) throw new Error(`sandbox Space refused: ${res.status} ${await res.text()}`);
    await chain.transferToken(relayer, clientKey.address, CLIENT_FUNDS);
  } catch (e) {
    await chain.stop();
    restoreEnv(savedEnv);
    throw e;
  }

  const handover = new Map<string, Handover>();
  const artifacts = new Map<string, Uint8Array>();
  /**
   * Seeds the client's Mandate so the authority tree has a root (F99).
   *
   * `maxTransaction` is well above the sandbox's largest agreement price and `budget` well
   * above the total, so the guards are exercised as PASSING rather than as refusals — a
   * seeded Mandate too small would make every sandbox agreement fail at the ceiling, which
   * would look like a product bug.
   */
  async function seedMandates(): Promise<Mandate[]> {
    const { repo } = await getStore();
    const mandate: Mandate = {
      mandateId: `mandate_sandbox_${client.agentId}`,
      name: "Sandbox trading mandate",
      version: 1,
      principal: "Mitra Labs (sandbox)",
      agentId: client.agentId,
      vaultId: "vault_1",
      asset: "USDC",
      budget: 100_000,
      maxTransaction: 10_000,
      velocityLimit: { amount: 50_000, windowMinutes: 60 },
      allowedCounterparties: [],
      allowedCapabilities: ["research", "payment", "deliverable_evaluation"],
      prohibitedCapabilities: ["internal_dispute_adjudication"],
      approvedChains: ["base", "solana"],
      policyVersion: "sandbox-v1",
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      // A fresh nonce, so the seeded mandate cannot replay a spent one, and `ACTIVE` so the
      // guards below it are exercised as PASSING rather than as refusals.
      nonce: 1,
      status: "ACTIVE",
      confidentialPolicy: false,
    };
    await repo.saveMandate!(mandate);
    // Read back rather than trusting the object we just wrote, so a store that silently
    // dropped the write would fail here instead of surfacing as a later "not found".
    const stored = await repo.getMandate(mandate.mandateId);
    if (!stored) throw new Error("sandbox: the Mandate did not persist");
    return [stored];
  }

  const escrowRefs = new Map<string, OnChainEscrow>();
  const prices = new Map<string, number>();

  const escrowRef = (agreementId: string): OnChainEscrow => {
    const ref = escrowRefs.get(agreementId);
    if (!ref) throw new Error(`no escrow for ${agreementId}: open it with sandbox.openAgreement`);
    return ref;
  };

  /** A scripted provider's turn: start funded work, then deliver, withhold or deliver garbage. */
  async function providerTurn(p: SandboxParty, behaviour: ProviderBehaviour): Promise<string[]> {
    const log: string[] = [];
    for (const item of (await p.mitra.inbox.list({ kinds: ["WORK_REQUIRED"] })).items) {
      if (item.kind !== "WORK_REQUIRED") continue;
      if (item.actions.includes("startExecution")) {
        await p.mitra.commerce.startExecution(item.agreementId);
        log.push(`${p.agentId}: started ${item.agreementId}`);
      } else if (item.actions.includes("submitDeliverable")) {
        if (behaviour === "withhold") { log.push(`${p.agentId}: withholding ${item.agreementId}`); continue; }
        const body = new TextEncoder().encode(JSON.stringify({
          agreementId: item.agreementId,
          criteria: Object.fromEntries(item.acceptanceCriteria.map((c) => [c, behaviour === "deliver"])),
        }));
        const ref = `sandbox://artifact/${item.agreementId}`;
        const contentHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
        artifacts.set(ref, body);
        await p.mitra.commerce.submitDeliverable(item.agreementId, { artifactRefs: [ref], contentHash });
        log.push(`${p.agentId}: submitted ${item.agreementId} (${behaviour})`);
      }
    }
    return log;
  }

  /** The scripted evaluator: verify the hash, then every criterion, then accept or reject on chain. */
  async function evaluatorTurn(): Promise<string[]> {
    const log: string[] = [];
    for (const item of (await evaluator.mitra.inbox.list({ kinds: ["EVALUATION_REQUIRED"] })).items) {
      if (item.kind !== "EVALUATION_REQUIRED") continue;
      const id = item.agreementId;
      // Read from the AGREEMENT, not from a side channel (F94). The deliverable is what the
      // provider signed and Mitra kept, and it is what an evaluator in a real deployment
      // would see — so the sandbox now judges the same thing a production evaluator would.
      const agreement = await evaluator.mitra.commerce.getAgreement(id);
      const given = agreement.deliverables?.[agreement.deliverables.length - 1];
      const bytes = given && artifacts.get(given.artifactRefs[0]);
      let failure: string | undefined;
      if (!given) failure = "NO_DELIVERABLE_RECORDED";
      else if (!bytes) failure = "ARTIFACT_NOT_READABLE";
      else if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== given.contentHash) failure = "CONTENT_HASH_MISMATCH";
      else {
        const verdicts = (JSON.parse(new TextDecoder().decode(bytes)) as { criteria?: Record<string, boolean> }).criteria ?? {};
        const failed = item.acceptanceCriteria.find((c) => verdicts[c] !== true);
        if (failed) failure = `CRITERION_FAILED: ${failed}`;
      }
      if (failure) {
        await evaluator.mitra.commerce.rejectDeliverable(id, { failureReason: failure, onChainEscrow: escrowRef(id) });
        log.push(`evaluator: rejected ${id} (${failure}); escrow refunded on chain`);
      } else {
        await evaluator.mitra.commerce.acceptDeliverable(id, { onChainEscrow: escrowRef(id) });
        log.push(`evaluator: accepted ${id}; escrow released to the provider on chain`);
      }
    }
    return log;
  }

  return {
    banner: SANDBOX_BANNER, chain, clock: chain.clock, client, provider, adversary, evaluator, handover, artifacts,
    mandates: await seedMandates(),

    async openAgreement(o) {
      const who = o.provider === "adversary" ? adversary : provider;
      const price = o.price ?? 25;
      await client.mitra.commerce.createAgreement({
        spaceId: SPACE_ID,
        draft: {
          agreementId: o.agreementId, runId: `run_${o.agreementId}`, intentId: `intent_${o.agreementId}`,
          client: client.agentId, provider: who.agentId, evaluator: evaluator.agentId,
          price: { asset: "USDC", amount: price },
          // The off-chain deadline is wall-clock; the escrow's timeout below is chain time.
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
          acceptanceCriteria: o.acceptanceCriteria ?? ["covers 100 companies", "cites a source for each"],
          payTo: { chain: "base", address: who.account.address },
        },
        proposal: { capability: "research", amount: { asset: "USDC", amount: price } },
      });
      escrowRefs.set(o.agreementId, {
        chain: "local",
        // The escrow's client vault: refunds return here. The client's own address.
        contractAddress: client.account.address,
        jobId: escrowIdFor(o.agreementId),
        timeout: (await chain.clock.now()) + (o.timeoutSeconds ?? 7200),
      });
      prices.set(o.agreementId, price);
    },

    async fund(agreementId) {
      // MitraJobEscrow.depositToEscrow records tokens the contract already holds; the
      // route moves none. So the client sends the price first, as the live suite does.
      const units = BigInt(Math.round((prices.get(agreementId) ?? 0) * 1e6));
      await chain.transferToken(clientKey, chain.escrow, units);
      await client.mitra.commerce.fund(agreementId, { onChainEscrow: escrowRef(agreementId) });
    },

    async tick() {
      return [
        ...(await providerTurn(provider, "deliver")),
        ...(await providerTurn(adversary, adversary.behaviour)),
        ...(await evaluatorTurn()),
      ];
    },

    keeper: {
      async refundTimedOut(agreementId) {
        const wallet = createWalletClient({ account: keeperKey, transport: http(chain.rpcUrl) });
        const hash = await wallet.writeContract({
          address: chain.escrow, abi: MITRA_JOB_ESCROW_ABI, functionName: "refundJob",
          args: [escrowIdFor(agreementId) as Hex], chain: null,
        });
        const rc = await chain.publicClient.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`refundJob reverted: ${hash}`);
        return hash;
      },
    },

    async escrowStatus(agreementId) {
      const row = await chain.publicClient.readContract({
        address: chain.escrow, abi: MITRA_JOB_ESCROW_ABI, functionName: "jobs", args: [escrowIdFor(agreementId) as Hex],
      }) as readonly unknown[];
      return Number(row[7]);
    },

    escrowRef,

    async stop() {
      await chain.stop();
      restoreEnv(savedEnv);
    },
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

