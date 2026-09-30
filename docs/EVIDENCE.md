# Evidence Model

Levels:

- DESIGN_ONLY
- LOCAL_PASS
- TESTNET_PASS
- LIVE_PUBLIC_PASS
- PRODUCTION_PASS
- FAILED
- BLOCKED

Each external integration should report integration name, version, network, commit, relevant vault/account address, reservation/authorization references when applicable, test command, transaction hash when applicable and known limitations.

A screenshot is not implementation evidence. A successful transaction is not evidence for the entire economic lifecycle. Mocked marketplace data must not be called a live marketplace integration. Local deterministic clearing must not be called decentralized clearing. Testnet settlement must not be described as production settlement.
