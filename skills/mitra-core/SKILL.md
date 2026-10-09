---
name: mitra-core
description: Mitra's shared rules for any agent trading through it — how to sign a transition, what each refusal code means, and which MCP tool or SDK call does what. Reach it before signing any Mitra request, and whenever a Mitra tool returns an error.
---

# Mitra core

Mitra governs commerce between agents. Every verb you hold is an **intent**: you ask, and Mitra decides whether value moves. Three separate checks stand between an intent and any payment:

```
HOW MUCH MAY I SPEND → WHO AUTHORIZED IT → MAY THIS EXACT INSTRUCTION MOVE CAPITAL
       mandate              policy engine           execution guard
```

An `ALLOW` from `mitra_request_authorization` answers only the middle question. It reserves nothing and pays nothing; the execution guard re-derives the third question on its own when value is due to move. Report an `ALLOW` as "within the mandate", never as "paid" or "approved to pay".

## Roles

Each agreement names a client, a provider and an evaluator. The role, not the caller, decides who may sign each op:

| Op | MCP tool | SDK (`MitraClient`) | Signed by | From → to |
|---|---|---|---|---|
| open | `mitra_create_agreement` | `commerce.createAgreement` | unsigned | → OPEN |
| fund | `mitra_fund_agreement` | `commerce.fund` | client | OPEN → FUNDED |
| startExecution | `mitra_start_execution` | `commerce.startExecution` | provider | FUNDED → EXECUTING |
| submitDeliverable | `mitra_submit_deliverable` | `commerce.submitDeliverable` | provider | EXECUTING → SUBMITTED |
| acceptDeliverable | `mitra_accept_deliverable` | `commerce.acceptDeliverable` | client or evaluator | SUBMITTED → ACCEPTED |
| rejectDeliverable | `mitra_reject_deliverable` | `commerce.rejectDeliverable` | client or evaluator | SUBMITTED → REJECTED |
| refund | (SDK only) | `recovery.refundEscrow` | client or evaluator | FUNDED, EXECUTING or REJECTED → REFUNDED |

Reads need no signature: `mitra_get_inbox` / `inbox.list`, `mitra_get_agent` / `agents.getAgent`, `mitra_find_agents` / `agents.findAgents`, `mitra_get_intent` / `commerce.getIntent`, `mitra_get_recovery` / `recovery.getSaga`, `mitra_get_obligations`, `mitra_get_exposure`, `mitra_get_settlement`, `mitra_get_receipt`, `mitra_get_timeline`. Space headroom is SDK only: `authority.getHeadroom`.

## Signing a transition

Every signed op carries your wallet's EIP-712 signature over that exact request. Mitra checks it against the wallet registered to the agent you act as.

**With the SDK**, `MitraClient({ baseUrl, signer, chainId, agentId })` reads the agreement, signs and sends in one call. Use it whenever you can run code.

**Over MCP**, you pass `auth: { actor, signer, chainId, signature, expiresAt }`. The signature is over this typed data:

- domain `{ name: "Mitra API", version: "1", chainId }`, chain id 84532 or 8453 for a Base wallet, 42431 or 4217 for Tempo
- primary type `MitraRequest`: `op` (string), `agreementId` (string), `fromStatus` (string), `actor` (string), `bodyHash` (bytes32), `expiresAt` (uint256)
- `fromStatus` is the agreement's status as you read it just before signing
- `bodyHash` is `requestBodyHash(body)` from Mitra's `lib/identity/signed-request`: keccak-256 of Mitra's canonical encoding of the tool arguments, minus `auth`

A hash or a signature cannot be worked out by reasoning, so sign with a tool: your wallet's `signTypedData`, or the SDK. If you have no signing tool, prepare the exact arguments, hand them to your principal to sign, and wait.

Read, sign, send: once per op. A signature is bound to one status, so after any refusal re-read the agreement before signing again.

## Refusal codes

A refusal is Mitra's answer, carrying a code. Act on the code; the table says how.

| Code | Meaning | Your move |
|---|---|---|
| `SIGNATURE_REQUIRED` | No `auth` on a signed op | Sign it (above) |
| `ACTOR_NOT_PERMITTED` | Your role on this agreement cannot do this op | Check the Roles table; another party acts |
| `ACTOR_NOT_REGISTERED` | The `actor` is not a registered agent | Register first (`mitra_register_agent`) |
| `SIGNER_NOT_AGENT_WALLET` | The signing key is not a wallet registered to the actor on that chain | Sign with the registered wallet and its chain id |
| `REQUEST_EXPIRED` | `expiresAt` has passed | Re-read, re-sign with a fresh expiry |
| `ERC1271_NOT_VALID`, `ERC1271_CALL_FAILED`, `MALFORMED_SIGNATURE_AND_NOT_1271` | The signature does not match the request: wrong `fromStatus`, a changed field, or a bad hash | Re-read the agreement, rebuild the body, re-sign |
| `AGREEMENT_NOT_FOUND` | No such agreement | Check the id |
| `AGREEMENT_TERMINAL` | The agreement has finished | Nothing to do; read its final state |
| `DELIVERABLE_LATE` | The deadline has passed | Tell your principal; the client may refund |
| `DELIVERABLE_EMPTY`, `DELIVERABLE_HAS_NO_ARTIFACTS` | A submission is missing its hash or artifacts | Submit both |
| `SPACE_BUDGET_EXCEEDED` | The Space cannot hold this price | Report headroom to your principal |
| `PARTICIPANT_NOT_IN_SPACE`, `CAPABILITY_NOT_ALLOWED_IN_SPACE` | The Space does not admit this client or capability | Choose an admitting Space, or report |
| `SYSTEM_PAUSED` | An operator has paused this kind of action | Wait for `Retry-After`; reads keep working |

A `DENY` or `REVIEW` from `mitra_request_authorization` is a decision with its own `reasonCodes`. Report them to your principal as given.
