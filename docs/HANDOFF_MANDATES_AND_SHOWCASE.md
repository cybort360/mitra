# Handoff Specification: Mandates Public API & Multi-Agent Live Showcase

**Date:** 2026-10-09  
**Author:** Lead Agent / Antigravity  
**Target:** Coding Agent (Implementation & Verification)  
**Repository Branch:** `feat/mitra-vault-v2-reseed`  
**Applicable Standards:** [`AGENTS.md`](./AGENTS.md), [`BUILD_FOUNDRY.md`](./forge/standards/BUILD_FOUNDRY.md), [`INVARIANTS.md`](./forge/INVARIANTS.md)

---

## 1. Executive Summary

This packet delivers the two crowning capabilities that transition Mitra from a hardened local engine into a fully operable autonomous agent protocol:

1. **Part 1: The Mandates Public API & SDK Surface (`app/api/v1/mandates/`, `mitra.mandates`, MCP tools):**
   * Completes the authority tree over HTTP so agents and principals can query and issue Mandates (`GET /api/v1/mandates`, `POST /api/v1/mandates`).
   * Equips `@mitra/sdk` with the `client.mandates` namespace and adds `mitra_get_mandate` / `mitra_list_mandates` to the MCP tool surface.
2. **Part 2: The Multi-Agent Live Showcase (`scripts/showcase-agents.ts`, `npm run showcase:full`):**
   * A unified demonstration script that launches a local Anvil chain and in-process MCP server.
   * Drives three distinct autonomous agents (**Buyer**, **Provider**, **Evaluator**) operating over real MCP/SDK sockets.
   * Demonstrates the complete commercial lifecycle:
     * Mandate verification & Intent creation
     * Agreement negotiation & On-chain ERC-8183 escrow funding
     * Duty dispatch via Inbox & Deliverable submission with cryptographic content hash
     * Evaluation verification, criteria matching, and on-chain release
     * Adversarial timeouts with automated chain-clock time travel and keeper refund reconciliation.

---

## 2. Part 1: Mandates Public API & SDK Surface

### 2.1 HTTP Route: `app/api/v1/mandates/route.ts`

Create `app/api/v1/mandates/route.ts` with `GET` and `POST` handlers:

```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store/provider";
import type { Mandate } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

const createMandateSchema = z.object({
  mandateId: z.string().min(1).optional(),
  name: z.string().min(1),
  principal: z.string().min(1),
  agentId: z.string().min(1),
  vaultId: z.string().min(1),
  asset: z.string().min(1),
  budget: z.number().positive(),
  maxTransaction: z.number().positive(),
  velocityLimit: z.object({ amount: z.number().positive(), windowMinutes: z.number().positive() }).optional(),
  allowedCounterparties: z.array(z.string()).default([]),
  allowedCapabilities: z.array(z.string()).default(["payment", "research"]),
  prohibitedCapabilities: z.array(z.string()).default([]),
  approvedChains: z.array(z.string()).default(["base", "solana"]),
  policyVersion: z.string().default("policy_v1"),
  expiresAt: z.string().datetime(),
  confidentialPolicy: z.boolean().default(false),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mandateId = url.searchParams.get("mandateId");
  const agentId = url.searchParams.get("agentId");
  const principal = url.searchParams.get("principal");
  const vaultId = url.searchParams.get("vaultId");

  const { repo, backend } = await getStore();

  if (mandateId) {
    const mandate = await repo.getMandate(mandateId);
    if (!mandate) {
      return NextResponse.json({ error: "MANDATE_NOT_FOUND", mandateId }, { status: 404 });
    }
    return NextResponse.json({ data: mandate, backend, evidenceLevel: "LOCAL_PASS" });
  }

  const all = await repo.listMandates();
  const filtered = all.filter((m) => {
    if (agentId && m.agentId !== agentId) return false;
    if (principal && m.principal !== principal) return false;
    if (vaultId && m.vaultId !== vaultId) return false;
    return true;
  });

  return NextResponse.json({ data: filtered, count: filtered.length, backend, evidenceLevel: "LOCAL_PASS" });
}

export async function POST(req: Request) {
  const { repo, backend } = await getStore();
  if (!repo.saveMandate) {
    return NextResponse.json({ error: "STORE_CANNOT_WRITE_MANDATES" }, { status: 501 });
  }

  const parsed = createMandateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_MANDATE", issues: parsed.error.issues }, { status: 400 });
  }

  const b = parsed.data;
  if (Date.parse(b.expiresAt) <= Date.now()) {
    return NextResponse.json({ error: "INVALID_MANDATE", reason: "EXPIRES_AT_IN_PAST" }, { status: 400 });
  }
  if (b.maxTransaction > b.budget) {
    return NextResponse.json({ error: "INVALID_MANDATE", reason: "MAX_TRANSACTION_EXCEEDS_BUDGET" }, { status: 400 });
  }

  const mandateId = b.mandateId ?? `mandate_${Math.random().toString(36).slice(2, 10)}`;
  const existing = await repo.getMandate(mandateId);
  if (existing) {
    return NextResponse.json({ error: "MANDATE_EXISTS", mandateId }, { status: 409 });
  }

  const mandate: Mandate = {
    mandateId,
    name: b.name,
    version: 1,
    principal: b.principal,
    agentId: b.agentId,
    vaultId: b.vaultId,
    asset: b.asset as Mandate["asset"],
    budget: b.budget,
    maxTransaction: b.maxTransaction,
    velocityLimit: b.velocityLimit,
    allowedCounterparties: b.allowedCounterparties,
    allowedCapabilities: b.allowedCapabilities,
    prohibitedCapabilities: b.prohibitedCapabilities,
    approvedChains: b.approvedChains as Mandate["approvedChains"],
    policyVersion: b.policyVersion,
    expiresAt: b.expiresAt,
    nonce: 0,
    status: "ACTIVE",
    confidentialPolicy: b.confidentialPolicy,
  };

  await repo.saveMandate(mandate);

  return NextResponse.json({ data: mandate, backend, evidenceLevel: "LOCAL_PASS" }, { status: 201 });
}
```

---

### 2.2 SDK Client Namespace: `lib/sdk/client.ts`

In `lib/sdk/client.ts`, expose the `mandates` namespace on `MitraClient`:

```typescript
export interface CreateMandateParams {
  mandateId?: string;
  name: string;
  principal: string;
  agentId: string;
  vaultId: string;
  asset: string;
  budget: number;
  maxTransaction: number;
  velocityLimit?: { amount: number; windowMinutes: number };
  allowedCounterparties?: string[];
  allowedCapabilities?: string[];
  prohibitedCapabilities?: string[];
  approvedChains?: string[];
  expiresAt: string;
  confidentialPolicy?: boolean;
}

export class MandatesNamespace {
  constructor(private readonly client: MitraClient) {}

  async get(mandateId: string): Promise<Mandate> {
    const res = await this.client.get(`/api/v1/mandates?mandateId=${encodeURIComponent(mandateId)}`);
    return res.data;
  }

  async list(filter: { agentId?: string; principal?: string; vaultId?: string } = {}): Promise<Mandate[]> {
    const params = new URLSearchParams();
    if (filter.agentId) params.set("agentId", filter.agentId);
    if (filter.principal) params.set("principal", filter.principal);
    if (filter.vaultId) params.set("vaultId", filter.vaultId);
    const qs = params.toString();
    const res = await this.client.get(`/api/v1/mandates${qs ? `?${qs}` : ""}`);
    return res.data;
  }

  async create(params: CreateMandateParams): Promise<Mandate> {
    const res = await this.client.post("/api/v1/mandates", params);
    return res.data;
  }
}
```
Instantiate `this.mandates = new MandatesNamespace(this)` in `MitraClient.constructor`.

---

### 2.3 MCP Tool Surface: `lib/mcp/surface.ts`

In `lib/mcp/surface.ts`, add:
1. `mitra_get_mandate`:
   * Input: `{ mandateId: string }`
   * Calls: `GET /api/v1/mandates?mandateId=...`
2. `mitra_list_mandates`:
   * Input: `{ agentId?: string }`
   * Calls: `GET /api/v1/mandates?agentId=...`

---

### 2.4 Test Suite: `tests/mandates-api.test.ts`
Write `tests/mandates-api.test.ts`:
* Tests `GET /api/v1/mandates` (lists seeded mandates).
* Tests `POST /api/v1/mandates` (validates Zod rules, creates a new mandate, rejects past expiry, rejects `maxTransaction > budget`).
* Tests `GET /api/v1/mandates?mandateId=...` (retrieves created mandate).
* Tests `client.mandates.get` and `client.mandates.create` via `MitraClient`.

---

## 3. Part 2: Multi-Agent Live Showcase

### 3.1 Script Architecture: `scripts/showcase-agents.ts`

Create `scripts/showcase-agents.ts` (executable via `npm run showcase:full`).

### 3.2 Showcase Execution Flow
The script will run through four sequential acts:

```
[ACT 0: Infrastructure Boot]
  1. Boot Ephemeral Anvil Node (Port randomized or 31337)
  2. Deploy MitraJobEscrow.sol & Seed 100,000 USDC
  3. Start Local In-Memory Mitra HTTP API Server

[ACT 1: Multi-Agent Authority & Engagement]
  1. Buyer Agent registers wallet & verifies 100,000 USDC Mandate
  2. Provider Agent registers wallet & announces capability ("research")
  3. Evaluator Agent registers wallet
  4. Buyer records Intent: "Competitive AI Agent Economics Report"
  5. Buyer opens Agreement with Provider & Evaluator (25 USDC, deadline +24h)
  6. Buyer locks 25 USDC into on-chain ERC-8183 Escrow on Anvil

[ACT 2: Autonomous Delivery & Evaluation]
  1. Provider polls Inbox over MCP, sees WORK_REQUIRED
  2. Provider calls startExecution, compiles deliverable artifact
  3. Provider submits deliverable with SHA-256 contentHash and IPFS ref
  4. Evaluator polls Inbox over MCP, sees EVALUATION_REQUIRED
  5. Evaluator reads deliverable binding directly from Agreement, validates criteria
  6. Evaluator calls acceptDeliverable -> on-chain completeJob releases 25 USDC to Provider

[ACT 3: Adversarial Timeout & Keeper Recovery]
  1. Adversary Provider is hired for 40 USDC (withhold behavior)
  2. Buyer locks 40 USDC on-chain
  3. Adversary withholds deliverable
  4. Script fast-forwards chain clock (+7200s) via evm_increaseTime
  5. Background Keeper calls refundJob on Anvil contract
  6. Buyer checks Agreement -> Read-path reconciliation reports REFUNDED
  7. Client's USDC balance restored intact

[ACT 4: Telemetry Summary]
  Summary table of all accounts, transactions, and event stream verification
```

### 3.3 Adding the Package Script: `package.json`
Add to `scripts` in `package.json`:
```json
"showcase:full": "tsx scripts/showcase-agents.ts",
"showcase:agents": "tsx scripts/showcase-agents.ts"
```

---

## 4. Execution Order for Coding Agent

- [ ] **Step 1: Implement Mandates API Route**
  * Create `app/api/v1/mandates/route.ts`.
- [ ] **Step 2: Add Mandates Namespace to `@mitra/sdk`**
  * Edit `lib/sdk/client.ts` and export `MandatesNamespace`.
- [ ] **Step 3: Add MCP Mandate Tools**
  * Update `lib/mcp/surface.ts` to export `mitra_get_mandate` and `mitra_list_mandates`.
- [ ] **Step 4: Create Test Suite**
  * Create `tests/mandates-api.test.ts` and verify `npx vitest run tests/mandates-api.test.ts`.
- [ ] **Step 5: Build Multi-Agent Live Showcase**
  * Create `scripts/showcase-agents.ts`.
  * Add `"showcase:full": "tsx scripts/showcase-agents.ts"` to `package.json`.
  * Run `npm run showcase:full` and ensure it runs cleanly from start to finish.
- [ ] **Step 6: Run Full Verification Baselines**
  * `npm run typecheck`
  * `forge test`
  * `cargo test --manifest-path programs/mitra-vault/Cargo.toml`
  * `npx vitest run`
  * `DATABASE_URL="postgres://mitra:mitra@localhost:5432/mitra" npm run test:postgres`
  * `npm run showcase:full`
