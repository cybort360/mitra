/**
 * F55 — caller identity. Seam C: POST /api/v1/agents (registration).
 *
 * Every EVM wallet a registration lists must sign it, so no one can attach a
 * wallet they do not control, and an existing agentId cannot be taken over.
 * Decision: shared context ctx_d236086bde9601ee.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GET, POST } from "@/app/api/v1/agents/route";
import { mitraRequestTypedData, registrationRequest } from "@/lib/identity/signed-request";
import { prepareStore } from "./fixtures";

const baseKey = privateKeyToAccount(`0x${"d4".repeat(32)}`);
const tempoKey = privateKeyToAccount(`0x${"e5".repeat(32)}`);

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/v1/agents", { method: "POST", body: JSON.stringify(body) }));
const getAgent = (agentId: string) => GET(new Request(`http://localhost/api/v1/agents?agentId=${agentId}`));

const draft = (agentId: string) => ({
  agentId,
  name: "Research Agent",
  owner: "Mitra Labs",
  wallets: [
    { chain: "base", address: baseKey.address },
    { chain: "tempo", address: tempoKey.address },
  ],
  capabilities: ["research"],
  protocols: ["mcp"],
});

/** A proof from `account` over the registration, under `chainId`. */
async function proof(account: PrivateKeyAccount, chainId: number, agent: ReturnType<typeof draft>, expiresAt: number) {
  const signature = await account.signTypedData(mitraRequestTypedData(registrationRequest(agent, expiresAt), chainId));
  return { signer: account.address, chainId, signature };
}

const expiresAt = () => Math.floor(Date.now() / 1000) + 300;

beforeEach(async () => {
  await prepareStore();
});

describe("agent registration requires every wallet to sign", () => {
  it("registers an agent whose every EVM wallet signed", async () => {
    const agent = draft("agent_new_01");
    const exp = expiresAt();
    const res = await post({ agent, expiresAt: exp, proofs: [await proof(baseKey, 84532, agent, exp), await proof(tempoKey, 42431, agent, exp)] });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const stored = await (await getAgent("agent_new_01")).json();
    expect(stored.data.wallets).toEqual(agent.wallets);
    expect(stored.data.status).toBe("REGISTERED");
  });

  it("refuses a registration listing a wallet that did not sign, and stores nothing", async () => {
    // The victim's tempo wallet is attached, but only the attacker's base key signs.
    const agent = draft("agent_new_02");
    const exp = expiresAt();
    const res = await post({ agent, expiresAt: exp, proofs: [await proof(baseKey, 84532, agent, exp)] });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "WALLET_NOT_PROVEN", wallet: { chain: "tempo", address: tempoKey.address } });
    expect((await getAgent("agent_new_02")).status).toBe(404);
  });

  it("refuses to re-register an existing agentId, even with every wallet signed", async () => {
    const takeover = { ...draft("agent_buyer_07"), wallets: [{ chain: "base", address: baseKey.address }] };
    const before = await (await getAgent("agent_buyer_07")).json();
    const exp = expiresAt();
    const res = await post({ agent: takeover, expiresAt: exp, proofs: [await proof(baseKey, 84532, takeover as ReturnType<typeof draft>, exp)] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("AGENT_EXISTS");
    expect((await (await getAgent("agent_buyer_07")).json()).data.wallets).toEqual(before.data.wallets);
  });

  it("refuses a Solana wallet until an ed25519 proof exists", async () => {
    const agent = { ...draft("agent_new_03"), wallets: [{ chain: "solana", address: "69P6furryqiLh4QzusKKxQftFJFsSADiGzGE2XdYYeU7" }] };
    const res = await post({ agent, expiresAt: expiresAt(), proofs: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("WALLET_CHAIN_UNPROVABLE");
    expect((await getAgent("agent_new_03")).status).toBe(404);
  });
});
