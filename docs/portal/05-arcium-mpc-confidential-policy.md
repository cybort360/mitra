# Confidential Policy Evaluation with Arcium MPC

> *"A counterparty who knows your exact budget ceiling will always price their work at your maximum limit."*  
> — [PRD §11: Confidential Policy Evaluation](../product/MITRA_PRD.md)

In autonomous agent commerce, financial privacy is not merely an aesthetic preference; it is a vital competitive necessity. If an enterprise agent's treasury headroom, remaining balance, and internal transaction caps were exposed in cleartext on public blockchains, counterparties could front-run bids, engage in dynamic price gouging, and reverse-engineer sensitive commercial strategy.

Mitra resolves this through **Confidential Multiparty Computation (MPC)** powered by **Arcium**.

---

## 1. Why MPC Over Zero-Knowledge Proofs (ZKP)?

A frequent architectural question is why Mitra employs Multi-Party Computation rather than Zero-Knowledge Proofs:

| Dimension | Zero-Knowledge Proofs (ZK) | Multi-Party Computation (Arcium MPC) |
|---|---|---|
| **Private State Sharing** | Single prover knows the secret in cleartext | Secrets are split into encrypted shares across independent nodes |
| **Multi-Party Secrets** | Complex recursive proofs needed to combine buyer and seller secrets | Native support for multi-party private inputs |
| **On-Chain Footprint** | Computationally heavy SNARK/STARK verifiers | Lean cryptographic threshold signatures |
| **Threshold Security** | If the prover's machine is compromised, the secret leaks | Requires corrupting a threshold quorum ($t$-of-$n$) of independent nodes |

In multi-agent commerce, neither the buyer, the seller, nor the blockchain validator should see the enterprise's private balance or maximum willingness to pay. Arcium MPC computes policy decisions directly over encrypted shares, emitting only a verified boolean verdict (`ALLOW` / `DENY`).

---

## 2. Arcium Multiparty Execution Environment (MXE)

The confidential policy evaluation runs on a 4-node Arcium MPC cluster ([`programs/arcium-policy-circuit`](../../programs/arcium-policy-circuit)):

```
                                ┌──────────────────────────────┐
                                │   BUYER AGENT ENCRYPTED INTENT│
                                │  • Intended Amount           │
                                └──────────────┬───────────────┘
                                               │
                                   Secret Sharing (x = [s1, s2, s3, s4])
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        ARCIUM 4-NODE CONFIDENTIAL MPC CLUSTER                          │
│                                                                                        │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐      │
│   │  MPC Node 1  │◄───►│  MPC Node 2  │◄───►│  MPC Node 3  │◄───►│  MPC Node 4  │      │
│   │  Share [s1]  │     │  Share [s2]  │     │  Share [s3]  │     │  Share [s4]  │      │
│   └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘      │
│                                                                                        │
│   CONFIDENTIAL EVALUATION OVER ENCRYPTED SHARES:                                       │
│   1. [amount] <= [max_transaction]                                                    │
│   2. [amount] <= [available_headroom]                                                 │
│   3. [capability_hash] in [approved_capabilities_merkle_root]                         │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                         Threshold Attestation Signature
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        ON-CHAIN SOLANA / EVM EXECUTION GUARD                           │
│                                                                                        │
│   • Public Binding Digest: `hash(policyVersion, actionDigest, vaultId, expiresAt)`     │
│   • Cleartext Headroom: NEVER EXPOSED ON-CHAIN                                         │
│   • Verified Result: `ALLOW` or `DENY`                                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Secret vs. Public State Segregation

To achieve both mathematical verification and confidential execution, Mitra strictly partitions transaction fields:

### Secret Inputs (Encrypted Inside Arcium MXE):
- **`amount`:** The exact micro-payment or escrow value.
- **`max_transaction`:** The maximum per-transaction cap configured by the principal.
- **`budget`:** The total capital allocated to the mandate.
- **`available_headroom`:** The remaining uncommitted spending limit.

### Public Binding Fields (Recorded On-Chain):
- **`policyVersion`:** Version identifier of the compiled MPC circuit.
- **`actionDigest`:** Cryptographic commitment of the operation (`keccak256(intent)`).
- **`vaultId`:** Identifier of the backing treasury vault PDA / contract.
- **`mandateId`:** Identifier of the governing mandate.
- **`expiresAt`:** Expiration timestamp bounding the validity of the proof.
- **`executionGuard`:** Verification contract / PDA validating the threshold signature.

---

## 4. The Policy Circuit Logic

The Arcium policy circuit evaluates the following mathematical relations inside the confidential execution domain:

```rust
// Arcium MPC Policy Evaluation Kernel
pub fn evaluate_policy_mxe(
    encrypted_amount: Secret<u64>,
    encrypted_max_tx: Secret<u64>,
    encrypted_headroom: Secret<u64>,
    public_deadline: u64,
    current_timestamp: u64,
) -> Secret<bool> {
    // 1. Transaction limit check
    let within_tx_limit = encrypted_amount.le(&encrypted_max_tx);

    // 2. Headroom availability check
    let within_headroom = encrypted_amount.le(&encrypted_headroom);

    // 3. Expiration validity check
    let not_expired = current_timestamp <= public_deadline;

    // Conjunction of all invariants
    within_tx_limit & within_headroom & not_expired
}
```

The output of the circuit is a cryptographically signed threshold certificate:
- If `true`, the policy engine outputs an `ALLOW` authorization token.
- If `false`, the policy engine outputs `DENY` with specific privacy-preserving failure flags (`EXCEEDS_CAP` or `EXPIRED`) without revealing the exact numerical difference.

---

## Next Steps

- Review how the on-chain settlement layer protects capital in [The Execution Guard Invariant: ALLOW != DISBURSEMENT](./06-execution-guard-and-allow-invariant.md).
- Learn about bilateral contract structures in [Bilateral Agreements & Programmatic DvP Escrow](./07-bilateral-agreements-and-escrow.md).
