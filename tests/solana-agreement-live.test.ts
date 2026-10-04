/**
 * Backlog #3: an ACCEPTED agreement settles on Solana devnet through the Mitra route —
 * reservation → POST /api/v1/settlements → the rail `railsFromEnv` builds → the deployed
 * `mitra-vault` (authorize + spend_authorized in one transaction) — then evidence is
 * re-observed from the cluster. Gated on SOLANA_LIVE=1.
 *
 * Provisioning mirrors tests/solana-transport.test.ts: the principal is the funded
 * devnet key; engine, holder and payee are derived from it, so reruns reuse one vault
 * and one mandate. The engine key is written to a temp file because the rail reads it
 * from one (MITRA_SOLANA_ENGINE_KEY_FILE) — a devnet key derived from a devnet key.
 *
 * On feat/vault-reseed-security-txt this targets the RESEEDED program: it passes only
 * after the lead's redeploy (docs/HANDOFF_CODEVELOPER.md, "Redeploy runbook").
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { Agreement, Mandate, Space } from "@/lib/domain/types";
import { CapitalLedger } from "@/lib/store/ledger";
import { InMemoryRepository } from "@/lib/store/provider";
import { vaults as seedVaults } from "@/lib/store/seed";
import { depositIx, initializeVaultIx, mandatePda, openMandateIx, vaultPda, decodeMandate } from "@/lib/solana/vault-program";
import { __setRailsForTests, railsFromEnv } from "@/lib/settlement/rails";
import { AGREEMENT_PAYMENT_CAPABILITY, settlementIdFor } from "@/lib/kernel/settlement";
import { POST as reservationsPOST } from "@/app/api/v1/reservations/route";
import { POST as settlementsPOST } from "@/app/api/v1/settlements/route";
import { GET as evidenceGET } from "@/app/api/v1/settlements/evidence/route";

const KEY = ".dev-keys/solana-testnet.json";

class LiveRepo extends InMemoryRepository {
  mandate!: Mandate;
  async getMandate(id: string) { return id === this.mandate?.mandateId ? this.mandate : super.getMandate(id); }
}

afterEach(() => { __setRailsForTests(null); globalThis.__mitraStore = undefined; });

describe.skipIf(!(process.env.SOLANA_LIVE === "1" && existsSync(KEY)))("live: an ACCEPTED agreement settles on Solana devnet through the route (SOLANA_LIVE=1)", () => {
  it("settles through /api/v1/settlements, confirms from the cluster, and the evidence verifies", async () => {
    const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
    const conn = new Connection(rpc, "confirmed");
    const principal = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
    const derive = (role: string) => Keypair.fromSeed(createHash("sha256").update(`mitra-solana-settlement:${role}:${principal.publicKey.toBase58()}`).digest());
    const engine = derive("engine");
    const holder = derive("holder").publicKey;
    const payee = derive("payee").publicKey;
    const [vault] = vaultPda(principal.publicKey);
    const send = (tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(conn, tx, signers);

    // One-time, conditional provisioning (same world as the transport's live test).
    if (!(await conn.getAccountInfo(vault))) await send(new Transaction().add(initializeVaultIx(principal.publicKey)), [principal]);
    if ((await conn.getBalance(engine.publicKey)) < 0.01 * LAMPORTS_PER_SOL || (await conn.getBalance(payee)) < 1_000_000) {
      await send(new Transaction().add(
        SystemProgram.transfer({ fromPubkey: principal.publicKey, toPubkey: engine.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
        SystemProgram.transfer({ fromPubkey: principal.publicKey, toPubkey: payee, lamports: 1_000_000 }),
      ), [principal]);
    }
    await send(new Transaction().add(depositIx(principal.publicKey, vault, 100_000n)), [principal]);
    const m = await conn.getAccountInfo(mandatePda(principal.publicKey, holder)[0]);
    if (!m) {
      await send(new Transaction().add(openMandateIx({
        principal: principal.publicKey, holder, limit: 1_000_000n, ceiling: 10_000_000n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400), policyEngine: engine.publicKey,
      })), [principal]);
    } else {
      expect(decodeMandate(Buffer.from(m.data)).binding, "mandate must be bound (F51 layout)").not.toBeNull();
    }

    const dir = mkdtempSync(join(tmpdir(), "mitra-sol-"));
    const engineFile = join(dir, "engine.json");
    writeFileSync(engineFile, JSON.stringify(Array.from(engine.secretKey)), { mode: 0o600 });
    const rails = await railsFromEnv({
      SOLANA_RPC_URL: rpc, MITRA_SOLANA_ENGINE_KEY_FILE: engineFile, MITRA_SOLANA_PRINCIPAL: principal.publicKey.toBase58(),
      MITRA_SOLANA_HOLDER: holder.toBase58(), MITRA_SOLANA_VAULT: vault.toBase58(),
    });
    expect(rails.solana, "railsFromEnv builds the Solana rail").toBeDefined();
    __setRailsForTests(rails);

    // Mitra: the vault record names the vault PDA the rail debits.
    const repo = new LiveRepo(new CapitalLedger(seedVaults.map((v) => (v.vaultId === "vault_sol_primary"
      ? { ...v, address: vault.toBase58(), asset: "SOL" as const, available: 1, total: 1, reserved: 0, escrowed: 0, encumbered: 0, settling: 0, frozen: 0 }
      : v)), []));
    repo.mandate = {
      mandateId: "m_sol_live", name: "pay providers on solana", version: 1, principal: "P", agentId: "agent_buyer_07",
      vaultId: "vault_sol_primary", asset: "SOL", budget: 1, maxTransaction: 0.1, allowedCounterparties: ["provider_alpha"],
      allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY], prohibitedCapabilities: [], approvedChains: ["solana"],
      policyVersion: "t", expiresAt: "2030-01-01T00:00:00Z", nonce: 1, status: "ACTIVE", confidentialPolicy: false,
    };
    await repo.updateSpace({ spaceId: "space_sol_live", owner: "agent_buyer_07", status: "ACTIVE", participants: ["agent_buyer_07", "provider_alpha"],
      allowedCapabilities: [AGREEMENT_PAYMENT_CAPABILITY], settlementChains: ["solana"], budget: { asset: "SOL", amount: 1 },
      committed: { asset: "SOL", amount: 0 }, version: 1, createdAt: new Date().toISOString() } as unknown as Space);
    globalThis.__mitraStore = Promise.resolve({ repo, backend: "memory" as const, close: async () => {} });

    const id = `ag_sol_${Date.now()}`;
    const agreement: Agreement = {
      agreementId: id, spaceIds: ["space_sol_live"], runId: `run_${id}`, intentId: "i", client: "agent_buyer_07", provider: "provider_alpha",
      externalJobRefs: [], price: { asset: "SOL", amount: 0.000003 }, deadline: "2030-01-01T00:00:00Z", acceptanceCriteria: [],
      failurePolicy: "refund", status: "ACCEPTED", escrowReleased: true, payTo: { chain: "solana", address: payee.toBase58() }, version: 5,
    };
    await repo.saveAgreement(agreement);
    const now = new Date().toISOString();
    const post = (h: (r: Request) => Promise<Response>, body: unknown) => h(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
    const rr = await post(reservationsPOST, { mandateId: "m_sol_live", vaultId: "vault_sol_primary", amount: 0.000003, asset: "SOL", chain: "solana",
      counterparty: "provider_alpha", capability: AGREEMENT_PAYMENT_CAPABILITY, intentId: "i", runId: agreement.runId, agreementId: id, now });
    const r = await rr.json();
    expect(rr.status, JSON.stringify(r)).toBe(201);

    let body = await (await post(settlementsPOST, { op: "settle", agreementId: id, reservationId: r.data.reservationId, now })).json();
    for (let i = 0; i < 30 && body.data?.settlement?.status !== "CONFIRMED"; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      body = await (await post(settlementsPOST, { op: "confirm", settlementId: settlementIdFor(id), now: new Date().toISOString() })).json();
    }
    const s = body.data?.settlement;
    console.log(`live solana agreement: ${s?.settlementId} tx ${s?.txHash} status ${s?.status} ${JSON.stringify(body.error ?? "")}`);
    expect(s.status).toBe("CONFIRMED");

    const ev = await (await evidenceGET(new Request(`http://localhost/api/v1/settlements/evidence?settlementId=${s.settlementId}`))).json();
    console.log(`live solana agreement evidence: ${JSON.stringify(ev.data?.verdict ?? ev)} slot ${ev.data?.bundle?.confirmation?.blockNumber}`);
    expect(ev.data.verdict).toEqual({ ok: true, evidenceLevel: "TESTNET_PASS" });
    const v = (await repo.getVault("vault_sol_primary"))!;
    expect(v.total).toBeCloseTo(1 - 0.000003, 9);
    expect(v.reserved).toBe(0);
  }, 240_000);
});
