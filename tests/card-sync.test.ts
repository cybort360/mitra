/**
 * Card sync (lib/kernel/card-sync.ts): the engine learns a customer's spend card from the
 * chain, on the vault owner's signature. Each refusal is paired with the path that works,
 * and every money-shaped value in the result is asserted to come from the chain read,
 * never from the request.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mitraRequestTypedData } from "@/lib/identity/signed-request";
import { cardIds, syncCard, syncRequest, type Card, type CardNetwork, type CardReader, type ChainMandate, type ChainPosition } from "@/lib/kernel/card-sync";
import { getStore } from "@/lib/store/provider";
import type { SignatureVerifier } from "@/lib/evm/eip712";
import { prepareStore } from "./fixtures";

const owner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const agentKey = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const ENGINE = privateKeyToAccount(`0x${"d4".repeat(32)}`).address;

const NETWORK: CardNetwork = {
  chainId: 84532,
  vault: "0x92dcee6acbfcf50f32a3e9c689d7f2ceef9ee489",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  asset: "USDC",
  decimals: 6,
};
/** EOAs only here: a contract-wallet verdict is never needed and must not be faked as valid. */
const NO_CONTRACT_WALLETS: SignatureVerifier = { isValidSignature: async () => "NOT_A_CONTRACT" as never };

const now = () => Math.floor(Date.now() / 1000);
const USD = (n: number) => BigInt(Math.round(n * 1e6));

function chain(over: Partial<ChainMandate> = {}, pos: Partial<ChainPosition> = {}): CardReader {
  return {
    mandate: async () => ({
      principal: owner.address, limit: USD(5), ceiling: USD(20), spent: USD(3),
      expiresAt: BigInt(now() + 30 * 86400), version: 2, policyEngine: ENGINE, revoked: false, ...over,
    }),
    position: async () => ({
      total: USD(25), available: USD(25), reserved: 0n, escrowed: 0n, encumbered: 0n, settling: 0n, frozen: 0n,
      emergencyFreeze: false, ...pos,
    }),
  };
}

const card = (over: Partial<Card> = {}): Card => ({
  chain: "base", principal: owner.address, holder: agentKey.address, agentId: "agent_card_01",
  capabilities: ["research", "seo-audit"], counterparties: ["*"], issuedAt: now(), ...over,
});

async function signed(c: Card, by: PrivateKeyAccount = owner, chainId = 84532) {
  const signature = await by.signTypedData(mitraRequestTypedData(syncRequest(c), chainId));
  return { signer: by.address, chainId, signature };
}

async function run(c: Card, opts: { auth?: Awaited<ReturnType<typeof signed>>; reader?: CardReader; engine?: `0x${string}` | null; at?: number } = {}) {
  const { repo } = await getStore();
  return syncCard({
    repo, network: NETWORK, reader: opts.reader ?? chain(), engine: opts.engine === undefined ? ENGINE : opts.engine,
    card: c, auth: opts.auth ?? (await signed(c)), verifier: NO_CONTRACT_WALLETS, now: opts.at ?? now(),
  });
}

async function registerAgent(wallets = [{ chain: "base" as const, address: agentKey.address }]) {
  const { repo } = await getStore();
  await repo.insertAgent({
    agentId: "agent_card_01", name: "Research agent", owner: owner.address, status: "REGISTERED", wallets,
    capabilities: ["research"], marketplaceRefs: [], protocols: ["mcp"], activeMandates: [], activeRuns: [],
    exposure: 0, createdAt: new Date().toISOString(), version: 1,
  });
}

beforeEach(async () => {
  await prepareStore();
});

describe("card sync writes what the chain says, on the owner's signature", () => {
  it("creates the vault and mandate from the chain read; only capabilities and counterparties come from the request", async () => {
    await registerAgent();
    const out = await run(card());
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const { vaultId, mandateId } = cardIds(card());
    expect(out.vaultWrite).toBe("created");
    expect(out.vault).toMatchObject({ vaultId, address: owner.address, chain: "base", asset: "USDC", total: 25, available: 25 });
    expect(out.mandate).toMatchObject({
      mandateId, vaultId, agentId: "agent_card_01", version: 2,
      budget: 17, // ceiling 20 − spent 3, from the chain
      maxTransaction: 5,
      allowedCapabilities: ["research", "seo-audit"], allowedCounterparties: ["*"], approvedChains: ["base"], status: "ACTIVE",
    });
    const { repo } = await getStore();
    expect((await repo.getMandate(mandateId))?.maxTransaction).toBe(5);
  });

  it("a newer sync updates the policy; replaying the same or an older one is refused", async () => {
    await registerAgent();
    const first = card();
    expect((await run(first)).ok).toBe(true);
    expect(await run(first)).toMatchObject({ ok: false, reason: "SYNC_IS_NOT_NEWER" });
    const newer = card({ issuedAt: first.issuedAt + 5, capabilities: ["research"] });
    const out = await run(newer, { at: newer.issuedAt });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.mandate.allowedCapabilities).toEqual(["research"]);
      expect(out.vaultWrite).toBe("refreshed");
    }
  });
});

describe("who may sync", () => {
  it("refuses a request signed by anyone but the vault owner", async () => {
    await registerAgent();
    expect(await run(card(), { auth: await signed(card(), stranger) })).toMatchObject({ ok: false, reason: "SIGNER_IS_NOT_THE_VAULT_OWNER" });
  });

  it("refuses a stranger's signature presented as the owner's", async () => {
    await registerAgent();
    const forged = { ...(await signed(card(), stranger)), signer: owner.address };
    expect(await run(card(), { auth: forged })).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses capabilities changed after signing", async () => {
    await registerAgent();
    const c = card();
    const auth = await signed(c);
    expect(await run({ ...c, capabilities: ["*"] }, { auth })).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("refuses a signature for another chain, and one that has expired", async () => {
    await registerAgent();
    expect(await run(card(), { auth: await signed(card(), owner, 42431) })).toMatchObject({ ok: false, reason: "SIGNED_FOR_ANOTHER_CHAIN" });
    const old = card({ issuedAt: now() - 3600 });
    expect(await run(old)).toMatchObject({ ok: false, reason: "REQUEST_EXPIRED" });
  });
});

describe("what the engine will not do", () => {
  it("does not register the agent (F55): an unregistered agent, or one that does not hold the card, is refused", async () => {
    expect(await run(card())).toMatchObject({ ok: false, httpStatus: 404, reason: "AGENT_NOT_REGISTERED" });
    await registerAgent([{ chain: "base", address: stranger.address }]);
    expect(await run(card())).toMatchObject({ ok: false, reason: "AGENT_WALLET_IS_NOT_THE_CARD_HOLDER" });
  });

  it("refuses a card that names another engine, is revoked, has expired, or is not on chain", async () => {
    await registerAgent();
    expect(await run(card(), { reader: chain({ policyEngine: stranger.address }) })).toMatchObject({ ok: false, reason: "CARD_NAMES_ANOTHER_ENGINE" });
    expect(await run(card(), { reader: chain({ revoked: true }) })).toMatchObject({ ok: false, reason: "CARD_REVOKED" });
    expect(await run(card(), { reader: chain({ expiresAt: BigInt(now() - 1) }) })).toMatchObject({ ok: false, reason: "CARD_EXPIRED" });
    expect(await run(card(), { reader: chain({ version: 0 }) })).toMatchObject({ ok: false, reason: "CARD_NOT_ON_CHAIN" });
    expect(await run(card(), { reader: chain({ principal: stranger.address }) })).toMatchObject({ ok: false, reason: "CARD_NOT_ON_CHAIN" });
  });

  it("says plainly when it has no signing key, and writes nothing", async () => {
    await registerAgent();
    expect(await run(card(), { engine: null })).toMatchObject({ ok: false, httpStatus: 503, reason: "ENGINE_KEY_NOT_CONFIGURED" });
    const { repo } = await getStore();
    expect(await repo.getVault(cardIds(card()).vaultId)).toBeNull();
  });
});
