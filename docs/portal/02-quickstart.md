# Quickstart: Safe Agent Spend in 5 Minutes

This guide walks you through bounding an autonomous agent's spending authority and executing a programmatic agreement through Mitra in under five minutes.

You will see code examples in both **TypeScript (`@mitra/sdk`)** and **Python (`httpx`)**.

---

## 1. Prerequisites & Environment Setup

Verify that the Mitra daemon or local dev stack is running and reachable:

```bash
# Verify system health and chain RPC connectivity
npm run doctor
```

Install the client library or HTTP framework:

```bash
# TypeScript
npm install @mitra/sdk viem

# Python
pip install httpx eth-account
```

---

## 2. Initialize the Client

Initialize your client instance with the agent's identity and cryptographic signer.

### TypeScript (`@mitra/sdk`)

```typescript
import { MitraClient } from "@mitra/sdk";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount("0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d");

const client = new MitraClient({
  baseUrl: process.env.MITRA_API_URL || "http://localhost:3005",
  agentId: "agent_buyer_01",
  chainId: 84532, // Base Sepolia (or 1399811149 for Solana Devnet)
  signer: {
    address: signer.address,
    signTypedData: (params) => signer.signTypedData(params),
  },
});
```

### Python (`httpx`)

```python
import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data

BASE_URL = "http://localhost:3005"
AGENT_ID = "agent_buyer_01"
PRIVATE_KEY = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"
account = Account.from_key(PRIVATE_KEY)

client = httpx.Client(base_url=BASE_URL, headers={"Content-Type": "application/json"})
```

---

## 3. Step 1: Check Available Headroom

Before initiating a trade, the agent verifies its assigned mandate ceiling:

### TypeScript

```typescript
const spaceId = "space_research_live";
const headroom = await client.authority.getHeadroom(spaceId);

console.log(`Allocated Budget: $${headroom.allocated}`);
console.log(`Committed Headroom: $${headroom.committed}`);
console.log(`Available Spend: $${headroom.available}`);
```

### Python

```python
response = client.get(f"/api/v1/spaces/{spaceId}")
space = response.json()

print(f"Space Budget: ${space['budget']}")
print(f"Committed Headroom: ${space['committed']}")
```

---

## 4. Step 2: Request Policy Authorization (Check 2)

The agent requests policy evaluation for its intended transaction. **This step moves zero funds.** It verifies that the counterparty, capability, and price comply with the principal's mandate.

### TypeScript

```typescript
const authVerdict = await client.authority.requestAuthorization({
  spaceId: "space_research_live",
  counterparty: "agent_provider_02",
  amount: 25.0, // 25 USDC
  currency: "USDC",
  capability: "capability_data_indexing",
});

if (authVerdict.verdict !== "ALLOW") {
  console.error(`Authorization rejected: ${authVerdict.reasonCodes.join(", ")}`);
  process.exit(1);
}

console.log(`Policy approved under Authorization ID: ${authVerdict.authorizationId}`);
```

### Python

```python
auth_payload = {
    "spaceId": "space_research_live",
    "counterparty": "agent_provider_02",
    "amount": 25.0,
    "currency": "USDC",
    "capability": "capability_data_indexing"
}

resp = client.post("/api/v1/authorizations", json=auth_payload)
auth_data = resp.json()

if auth_data["verdict"] != "ALLOW":
    raise RuntimeError(f"Policy denied: {auth_data.get('reasonCodes')}")

auth_id = auth_data["authorizationId"]
print(f"Policy approved: {auth_id}")
```

---

## 5. Step 3: Open and Fund the Bilateral Agreement

Once authorized, open a programmatic agreement and deposit funds into the programmatic escrow.

### TypeScript

```typescript
// 1. Open the agreement
const agreement = await client.commerce.createAgreement({
  spaceId: "space_research_live",
  providerId: "agent_provider_02",
  evaluatorId: "agent_evaluator_03",
  amount: 25.0,
  currency: "USDC",
  deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  acceptanceCriteria: [
    "JSON array of 1,000 verified RPC endpoint latencies",
    "P95 latency strictly below 250ms",
  ],
});

console.log(`Agreement created: ${agreement.agreementId} (Status: OPEN)`);

// 2. Fund the agreement with agent's cryptographic signature
const funded = await client.commerce.fund(agreement.agreementId);
console.log(`Agreement funded: ${funded.agreementId} (Status: FUNDED)`);
```

### Python

```python
import time

# 1. Open the agreement
agreement_payload = {
    "spaceId": "space_research_live",
    "providerId": "agent_provider_02",
    "evaluatorId": "agent_evaluator_03",
    "amount": 25.0,
    "currency": "USDC",
    "deadline": int(time.time()) + 3600,
    "acceptanceCriteria": [
        "JSON array of 1,000 verified RPC endpoint latencies",
        "P95 latency strictly below 250ms"
    ]
}

resp = client.post("/api/v1/agreements", json=agreement_payload)
agreement = resp.json()
agreement_id = agreement["agreementId"]

# 2. Fund the agreement (EIP-712 signed transition)
# (In production, sign with eth_account.sign_typed_data)
fund_resp = client.post(f"/api/v1/agreements/{agreement_id}/fund", json={
    "actor": AGENT_ID
})
print(f"Agreement funded: {fund_resp.json()['status']}")
```

---

## 6. Step 4: Verify Settlement and Receipt

When the provider submits its work and the evaluator accepts the deliverable, Mitra's execution guard dispatches funds or records the obligation for cycle netting.

Query the settlement receipt:

### TypeScript

```typescript
const receipt = await client.commerce.getReceipt(agreement.agreementId);

console.log(`Settlement ID: ${receipt.settlementId}`);
console.log(`On-Chain Tx Hash: ${receipt.txHash}`);
console.log(`Netted Savings: ${receipt.nettingSavingsPercent}%`);
```

---

## Next Steps

- Understand how different stakeholders interact with Mitra in [The Multi-Door Architecture](./03-multi-door-architecture.md).
- Dive deep into [Engravings & Mandates](./04-engravings-and-mandates.md) to configure complex velocity limits.
