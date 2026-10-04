# 0012. Sagas are distributed state machines over local vault primitives, not monolithic contracts

**Status:** Proposed — Submitted for Principal Review
**Related:** F45, F47, F50a, PRD §4.5, §15, §21, ADR-0002, ADR-0006, ADR-0009

> **Core Principle:** An autonomous agent commercial workflow spanning multiple chains and off-chain compute
> cannot be coordinated by a single, monolithic smart contract. Sagas are distributed, off-chain state
> machines orchestrating sovereign, on-chain capital primitives.

---

## Context

Commercial agent workflows in Mitra routinely cross execution and trust boundaries:
- **Off-chain / AI compute boundary:** Submitting prompts, executing LLM inference, validating evaluation digests, verifying content hashes.
- **Heterogeneous chain environments:** Reserving USDC on Solana Devnet, locking commercial escrow on Base Sepolia (EVM), micro-settling on Tempo Moderato (TIP-20).

Attempting to implement a commercial Saga as a single smart contract introduces three critical failure modes:

1. **The Cross-Chain Synchrony Trap:**
   Smart contracts on EVM cannot directly or synchronously inspect or invoke state on Solana or Tempo. A single "cross-chain saga contract" would require either centralized relayer bridges, complex multi-sig oracles, or custodial intermediaries. This directly violates PRD §3.2 (Mitra is not a custodian) and PRD §21 (no claim of atomic cross-chain settlement unless implemented and verified).

2. **The Off-Chain / Evaluation Blindspot:**
   Smart contracts cannot evaluate whether an AI agent performed research satisfactorily or generated a valid artifact. In Mitra, evaluation is bound by cryptographic digests and participant attestations (`evaluator` in `Agreement`). A monolithic contract would either over-simplify evaluation to arbitrary caller signals or freeze if an off-chain API fails.

3. **Violation of Positional Capital Separation (ADR-0002):**
   Vault capital must remain positional (`available`, `reserved`, `escrowed`, `encumbered`, `settling`, `frozen`) within each local chain's native custody model. Coupling capital custody with complex multi-step workflow logic in one contract inflates attack surface and breaks the load-bearing invariant:
   *An ALLOW decision is never itself permission to move value.*

---

## Decision

We separate the commercial recovery architecture into two decoupled, rigorously bounded layers:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DISTRIBUTED SAGA ORCHESTRATOR                         │
│   (Off-Chain Deterministic Kernel — lib/kernel/recovery.ts & commerce.ts)   │
│                                                                             │
│   DECLARED ──► ARMED ──► EXECUTING ──► STEP_FAILURE ──► COMPENSATING ──► RECOVERED
│                  │                                            │             │
│                  └────────── Pre-committed Route ─────────────┘             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Dispatches Leg Instructions
                                       ▼
 ┌─────────────────────────┬─────────────────────────┬─────────────────────────┐
 │   EVM Primitive (Base)  │  EVM Primitive (Tempo)  │    Solana Primitive     │
 │     MitraVault.sol      │     MitraVault.sol      │    programs/mitra-vault │
 ├─────────────────────────┼─────────────────────────┼─────────────────────────┤
 │ • lockEscrow(jobId)     │ • lockEscrow(jobId)     │ • reserve(amount)       │
 │ • releaseEscrow(jobId)  │ • releaseEscrow(jobId)  │ • spend_authorized()    │
 │ • refundEscrow(jobId)   │ • refundEscrow(jobId)   │ • release(amount)       │
 └─────────────────────────┴─────────────────────────┴─────────────────────────┘
```

### 2.1 The Two-Layer Model

1. **Layer 1: Sovereign On-Chain Vault Primitives**
   - Each chain runs a minimal, isolated, non-custodial capital vault.
   - On EVM (`MitraVault.sol`): Implements ADR-0002 positional balances with PRD §15 commercial escrow:
     - `lockEscrow(jobId, provider, token, amount, timeout)` moves `available -> escrowed`.
     - `releaseEscrow(jobId)` moves `escrowed -> total` (leaves vault to provider upon buyer acceptance).
     - `refundEscrow(jobId)` moves `escrowed -> available` (returns capital to buyer upon timeout or rejection).
   - On Solana (`mitra-vault`): Implements positional accounting (`available`, `reserved`, `total`) with mandate-governed permits and `reserve` / `release`.
   - Neither contract knows anything about sagas, other chains, or workflow graphs. They only enforce local accounting invariants and authorization gates.

2. **Layer 2: The Distributed Saga Orchestrator**
   - Implemented as a pure, deterministic state machine (`lib/kernel/recovery.ts`).
   - Governed by PRD §4.5 ("Failure is a state transition, not an exception") and PRD §15.5 ("A compensation route must be committed before execution. Never let the recovery engine invent arbitrary compensation calldata after failure").
   - Maintains the complete lifecycle across steps, retries, and compensation routes.

### 2.2 The Compensation Pre-Commitment Protocol (PRD §15.5)

Before execution can begin, the saga MUST be `ARMED`:
1. When an agreement is funded, a deterministic `jobId` is derived:
   $$\text{jobId} = \text{keccak256}(\text{abi.encode}(\text{agreementId}, \text{runId}, \text{client}, \text{provider}, \text{amount}, \text{timeout}))$$
2. The exact compensation route is committed into the saga's immutable declaration:
   ```ts
   export const REFUND_ROUTE: CompensationRoute = {
     routeId: "route_refund",
     action: "REFUND",
     route: `evm:refundEscrow:${jobId}`,
     maxAttempts: 1,
   };
   ```
3. Entering `EXECUTING` is refused unless the saga is `ARMED` with at least one usable route (`maxAttempts > 0`).
4. If an execution step fails or deliverable is rejected:
   - State advances: `EXECUTING -> STEP_FAILURE -> COMPENSATING`.
   - The engine looks up the pre-committed `routeId`. It **never synthesises new calldata** at failure time.
   - The adapter executes the exact on-chain remedy (`refundEscrow(jobId)` on EVM, or `release` on Solana).
   - Once executed and confirmed, `compensate()` advances the state to `RECOVERED` (or `CONTAINED`).
   - `routeAttempts` is decremented on the saga record (F47 guard against replay loops).

### 2.3 Asset and Chain Honesty (F45 & ADR-0006)

In distributed sagas, multi-token, multi-chain operations must not fall into the F45 trap:
- "Deposit, spend, replay refused" is satisfied by *any* valid ERC-20 / TIP-20 token.
- A saga step must assert on-chain identity:
  - On Tempo Moderato (Chain ID 42431): Verify `mint.name() == "PathUSD"` (`0x20c0...0000`), explicitly rejecting `AlphaUSD` (`0x20c0...0001`).
  - On Base Sepolia (Chain ID 84532): Verify `mint.symbol() == "USDC"` (`0x036C...6c32`).
- No leg may claim execution against an asset without live cryptographic / RPC confirmation.

---

## 3. Concrete State Transitions

```
[DECLARED]
    │  armSaga(declaration with pre-committed route)
    ▼
 [ARMED]
    │  startSaga()
    ▼
[EXECUTING] ──────────────────────────┐
    │                                 │
    │ step succeeds                   │ step fails / rejected
    ▼                                 ▼
[ALL STEPS SUCCEEDED]          [STEP_FAILURE]
    │                                 │
    │                                 │ beginCompensation()
    ▼                                 ▼
[RECOVERED (Success)]          [COMPENSATING]
                                      │
                                      │ execute pre-committed route (refundEscrow)
                                      ▼
                                [RECOVERED (Compensated)]
                                (or CONTAINED / ABORTED)
```

---

## Consequences

### What This Architecture Guarantees
1. **Zero Orphaned Capital:** If an agent crashes, gets rate-limited, or fails evaluation, capital is locked in an on-chain escrow with a hard timestamp expiry. The client can always reclaim funds via `refundEscrow`.
2. **Deterministic Unwinding:** Calldata is never synthesized under panic or error handling; it was hashed and locked at agreement funding time.
3. **Cross-Chain Extensibility:** A swarm can coordinate 10 sub-agents across Solana, Base, and Tempo; each sub-agreement has its own local vault primitive and pre-committed compensation route.
4. **No Bridge Risk:** No cross-chain message-passing bridges are required. Each chain's security model is self-contained.

### What This Architecture Forbids
- Monolithic "god contracts" claiming cross-chain atomicity.
- Post-failure calldata generation.
- Re-executing non-idempotent compensation routes (F47).
- Unhandled exceptions escaping the recovery loop (F50a).
