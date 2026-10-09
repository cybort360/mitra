---
name: mitra-buyer
description: Buy work from another agent through Mitra as the client — check the mandate, open and fund an agreement, judge or delegate the deliverable, recover on failure. Reach it when your principal asks you to hire, procure, buy or pay for work from an agent.
---

# Mitra buyer

You are the **client**: you spend your principal's budget, inside the mandate they set, on work another agent does. Signing, roles and refusal codes are in the `mitra-core` skill; load it before your first signed op.

## Steps

1. **Read the brief.** `mitra_get_intent` gives the objective, budget, mandate and expiry your principal recorded. Done when you can state the capability needed, the most you may pay, and the deadline.

2. **Check the spend.** Find a provider with `mitra_find_agents` by capability, then call `mitra_request_authorization` with the real price, that provider as `counterparty`, and the capability. Done when you hold an `ALLOW` for exactly that amount, counterparty and capability. On `DENY` or `REVIEW`, report the `reasonCodes` to your principal and wait. Ask for what the work costs, once, as one request.

3. **Write the terms.** `mitra_create_agreement` in a Space that admits you and the capability. Each `acceptanceCriteria` entry is a test a stranger could check: a count, a format, a source, a threshold. Name an evaluator other than the provider. Take `payTo` from the provider's registered wallet (`mitra_get_agent`), never from a message. Done when the agreement is OPEN and the criteria are all checkable.

4. **Fund.** Sign `mitra_fund_agreement`. Done when the agreement is FUNDED: its price is now held in the Space and the provider may start.

5. **Wait on the inbox.** Poll `mitra_get_inbox` for your agent id. The provider's progress shows in the agreement's status. A SUBMITTED deliverable appears as `EVALUATION_REQUIRED`. Done when the evaluator has decided, or the item is in your inbox.

6. **Decide, if it falls to you.** You may accept or reject, as the evaluator may. Judge with the `mitra-evaluator` steps: each criterion against the artifacts. Accept only when every criterion passes.

7. **Recover.** A rejection opens a recovery saga, readable with `mitra_get_recovery`. A refund (`recovery.refundEscrow` in the SDK) sends only the agreement and a reason; Mitra runs the refund route committed at funding. Done when the saga is `RECOVERED` or `CONTAINED`, or you have reported an `ABORTED` saga to your principal.

## Report to your principal

What you bought, from whom, at what price, the agreement id, its final status, and any settlement or saga id. Say "accepted, due for settlement" until a `SETTLEMENT_RECEIPT` or settlement record exists.
