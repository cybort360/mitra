# Security and Invariants

This repository is production-shaped but is not production-safe custody software. No independent smart-contract audit, signer review, live key management review or incident-response validation is bundled.

## Cross-state invariants

- A financial action cannot execute without an active mandate and valid authorization.
- The executed action references the exact mandate version evaluated.
- Released escrow cannot be released twice.
- An agreement cannot settle against a different provider without explicit reassignment/amendment.
- A rejected deliverable cannot trigger normal payment release.
- A non-idempotent compensation route cannot execute twice.
- An obligation may enter at most one finalized clearing epoch unless explicit roll-forward rules apply.
- A settlement receipt binds to the exact cleared obligation or transfer set.
- External identities cannot be silently remapped to another wallet/agent record.
- Settlement chain and asset must match authorized terms unless an explicit conversion route was authorized.
- Available vault capital must reflect reservations, escrow, encumbrances, settling funds and freezes.
- A reservation belongs to one vault and one intent and cannot be consumed twice.
- Concurrent intents cannot consume the same available capital.
- Authorization for action A cannot authorize action B.
- Confidential policy decisions must bind to policy version, vault, mandate, action digest and expiry.
- Agent execution authority does not imply principal withdrawal authority.

## Required production gates

Security: independent contract audit, vault-controller review, authorization-to-execution review, key-management review, threat-model review, adversarial integration corpus and incident-response plan.

Reliability: durable event storage, indexer replay, reconciliation, backup/restore, HA services and chaos testing.

Financial correctness: invariant coverage, capital conservation, reservation correctness, vault/onchain reconciliation, settlement verification, clearing review and dispute handling.
