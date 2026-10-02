# Architecture Decision Records

One file per decision that constrains the design. Each is immutable once
accepted; changing a decision means a new record that supersedes the old one and
leaves it in place. A deleted ADR loses the reasoning, which is usually the only
part that was hard to recover.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-repository-scope.md) | Keep dev instrumentation in the product repo | Accepted |
| [0002](0002-vault-capital-is-positional-not-stateful.md) | Vault capital is positional, not a state machine | Accepted |
| [0003](0003-store-abstraction-and-fallback.md) | One repository interface, explicit in-memory fallback | Accepted |
| [0004](0004-phase-exit-conditions-require-live-networks.md) | Phase exit conditions need live networks; abstractions alone cannot satisfy them | Accepted |
| [0005](0005-evidence-levels-untested-through-verified.md) | Five evidence levels; `PARTIAL` is not `VERIFIED` | Accepted |
| [0006](0006-tempo-balances-require-tip20.md) | Tempo balances come from TIP-20 `balanceOf`, never `eth_getBalance`; assert chain ID 42431 | Accepted |
| [0007](0007-phase2-builds-a-real-solana-program.md) | Phase 2 builds a real Solana program; capital is six positions (ADR-0002), not a status | Accepted |
| [0008](0008-evidence-two-fields-union-vocabulary.md) | Evidence is two fields (`evidence` + `blocker`); the union of both vocabularies supersedes ADR-0005 | Accepted |

## Format

`# NNNN. Title`, then **Status**, **Context**, **Decision**, **Consequences**.

The Context section is the part that matters later. Write down what forced the
decision, because "we tried the other thing" is only useful if it is written down
at the time rather than reconstructed from a diff six months afterwards.
