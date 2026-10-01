# 0006. Tempo balances come from TIP-20, never from native balance

**Status:** Accepted

## Context

PRD §34 lists Tempo as the payment-specialized settlement chain, and PRD §52
Phase 9 requires a Tempo settlement adapter behind the common
`SettlementAdapter` interface. The PRD specifies no chain ID, no RPC endpoint,
and no balance semantics for Tempo, so those had to be established externally
(vendor documentation, then direct probes).

Established facts:

| | Mainnet | Testnet |
|---|---|---|
| Network | Tempo Mainnet | Tempo Testnet (**Moderato**) |
| Chain ID | `4217` | `42431` |
| HTTP RPC | `https://rpc.tempo.xyz` | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.tempo.xyz` | `https://explore.testnet.tempo.xyz` |

Tempo is EVM-compatible targeting the **Osaka** hard fork, and it has **no
native gas token** — fees are paid in TIP-20 stablecoins.

The vendor's EVM-compatibility documentation states that native token balance
"is always returning zero balances", and that the `BALANCE` and `SELFBALANCE`
opcodes return 0.

Direct probing of Moderato contradicts that. `eth_getBalance` returns

```
0x9612084f0316e0ebd5182f398e5195a51b5ca47667d4c9b26c9b26c9b2
```

identically for three unrelated addresses — our dev key, `0x…dEaD`, and
`0x1111…1111` — and at both `latest` and `earliest` tags. The low bytes are a
repeating `4242` pattern. This is the "unusually high balance" the docs
attribute to wallet display, seen at the RPC layer. Recorded as F12.

So the documented answer (0) and the observed answer (a large constant) are
*both* unusable, and the observed one is the more dangerous of the two: a
zero-balance check fails safe, whereas a large constant passes a naive
`> 0` funding check.

## Decision

1. **A Tempo balance is a TIP-20 token balance, read via `balanceOf` or the
   Tempo API** (`GET /v1/addresses/{address}/balances`). Never
   `eth_getBalance`.
2. **A funding check on Tempo is `false` until it has read a specific token's
   `balanceOf` for the specific address.** Absence of a balance read is not an
   absence of funds, and must never be treated as one.
3. **Every Tempo adapter asserts `eth_chainId === 42431`** before performing any
   operation. Mainnet (`4217`) must cause a hard failure, not a warning.
4. Faucet funding is browser-only; there is no programmatic faucet endpoint.
   `POST /v1/faucet` returns `not_found`.

## Consequences

- `scripts/phase2-readiness.mjs` asserts the chain ID and reports
  `chainId 4217 = TEMPO MAINNET — refusing to treat production as a testnet`.
  Verified by running it against mainnet and observing the BLOCKED result.
- `tests/dev-scripts.test.ts` probes `eth_getBalance` live and asserts
  address-independence. The assertion is written so it *fails* if Tempo ever
  implements a real native balance, which is the signal to revisit this ADR
  rather than leave a stale warning behind.
- This is F12 in spirit: a claim about a dependency's behaviour that was
  cheaper to read from documentation than to measure. The measurement found the
  documentation wrong, and in the direction that would have passed a funding
  check.

## Alternatives considered

- **Trust the documented behaviour of 0.** Rejected: contradicted by
  measurement, and the observed value is the dangerous one.
- **Special-case Tempo in the kernel.** Rejected: the kernel is chain-neutral
  by PRD §21.3. The constraint belongs in the adapter, where a future Tempo
  with a native token is a one-file change.

