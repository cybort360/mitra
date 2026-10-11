# Base Substrate: EVM ERC-8183 Escrows & Account Abstraction

> *"Standardizing autonomous agent trade on Ethereum Layer-2 via ERC-8183 and EIP-712 typed-data commitments."*  
> — [`contracts/MitraVault.sol`](../../contracts/MitraVault.sol) · [`contracts/MitraClearing.sol`](../../contracts/MitraClearing.sol)

On Base (Coinbase's Ethereum L2), Mitra deploys audited Solidity contracts adhering to the emerging **ERC-8183 (Agentic Commerce Escrows)** specification and Ethereum's **EIP-712** typed-data signing standard.

---

## 1. The ERC-8183 Escrow Standard

**ERC-8183** defines a universal smart contract standard for autonomous agent commerce on EVM chains. It standardizes:
- **Tri-Party Roles:** Explicit segregation of `client`, `provider`, and `evaluator`.
- **Milestone & Delivery Hash Commitments:** On-chain storage of deliverable hashes (`contentHash`) and verification criteria.
- **Autonomous Expiration Sweeps:** Permissionless refund triggers executable by any party or keeper daemon after the job deadline expires.

Mitra implements ERC-8183 natively in [`contracts/MitraVault.sol`](../../contracts/MitraVault.sol), allowing any ERC-8183 compliant agent framework (such as Virtuals ACP, Autonolas, or custom EVM agents) to compose seamlessly with Mitra.

---

## 2. EIP-712 Cryptographic Authorization

Every state transition signed by an agent on Base is validated against an **EIP-712 Domain Separator**:

```typescript
export const MITRA_EIP712_DOMAIN = {
  name: "Mitra API",
  version: "1",
  chainId: 84532, // Base Sepolia (or 8453 for Base Mainnet)
};

export const MITRA_REQUEST_TYPES = {
  MitraRequest: [
    { name: "op", type: "string" },            // e.g. "fund", "accept", "reject"
    { name: "agreementId", type: "string" },   // Canonical agreement ID
    { name: "fromStatus", type: "string" },    // Status read before signing
    { name: "actor", type: "string" },         // Registered agentId
    { name: "bodyHash", type: "bytes32" },     // Keccak256 of canonical arguments
    { name: "expiresAt", type: "uint256" },    // Signature expiry epoch
  ],
};
```

### Why State-Bound Signatures Matter:
Notice the inclusion of `fromStatus`. An agent signs a transition *from a specific known state*. If a concurrent transaction mutates the agreement while a request is in flight, the signature is invalidated, preventing state-race vulnerabilities.

---

## 3. Solidity Contract Suite

Mitra's EVM contracts are validated with 63 comprehensive Foundry unit and invariant tests (`forge test`):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMitraVault {
    struct Mandate {
        address principal;
        address agentWallet;
        uint256 totalBudget;
        uint256 availableHeadroom;
        uint256 maxTransaction;
        uint256 expiresAt;
        bool isPaused;
    }

    event MandateCreated(bytes32 indexed mandateId, address indexed principal, address indexed agent);
    event EscrowFunded(bytes32 indexed agreementId, uint256 amount);
    event SettlementExecuted(bytes32 indexed agreementId, address recipient, uint256 amount);
    event EscrowRefunded(bytes32 indexed agreementId, address recipient, uint256 amount);

    function fundAgreement(bytes32 agreementId, bytes32 mandateId, uint256 amount) external;
    function releaseSettlement(bytes32 agreementId, address to, uint256 amount, bytes calldata proof) external;
    function refundOverdue(bytes32 agreementId) external;
}
```

---

## 4. Live Base Sepolia Verification

- **Live Settlement Hash:** Verified live settlement recorded in [`forge/PROOF_LEDGER.md`](../../forge/PROOF_LEDGER.md) at hash:  
  `0x75dbc7429188d30e38a2e1d7cf92f025d57b0fb928`
- **Two-Second Health Probe:** `npm run doctor` probes Base Sepolia and Base Mainnet chain heads in real time.

---

## Next Steps

- Explore micro-payment streaming in [Tempo Substrate: TIP-20](./14-tempo-substrate.md).
- Learn how agents integrate over MCP in [Model Context Protocol Gateway](./15-mcp-gateway.md).
