# contracts

`MitraVault.sol` — the EVM capital boundary (sprint item 6), the counterpart of
`programs/mitra-vault` with the F51 binding built in. See the contract header for
what differs from the sketch in `docs/HANDOFF_SOLANA_VERIFICATION_AND_EVM_VAULTS.md`.

```bash
npm run contracts:setup     # forge-std into contracts/lib (gitignored)
npm run contracts:test      # Foundry suite
(cd contracts && forge build) && node scripts/deploy-evm-vault.mjs base|tempo
BASE_VAULT_LIVE=1 npx vitest run tests/evm-vault.test.ts   # exercise the deployment
```

Deployments are recorded in `lib/evm/deployments.json`; evidence in `forge/PROOF_LEDGER.md`.
