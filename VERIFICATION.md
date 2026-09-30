# Verification status

Date: 2026-09-30

## Passed in this environment

- TypeScript source sanity pass over the Next.js app using local declaration stubs because package installation is unavailable in the execution environment.
- Economic-kernel executable verification:
  - overspend rejection
  - vault reconciliation / conservation
  - action-digest tamper rejection
  - unauthorized counterparty denial
  - net residual <= gross obligation volume
  - deterministic net-position output independent of input order
- Zero-dependency static console preview included under `preview-static/`.

## Not claimed

The environment could not complete `npm install`, so the repository has not been run through the real installed Next.js/React/Vitest toolchain here. Run the following on a connected machine before deployment:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

No live Solana/Base/Tempo program, signer credentials, marketplace credentials, x402 facilitator, MPP provider or Arcium environment was supplied. Accordingly, external integrations remain explicitly `DESIGN_ONLY` or local adapter proofs and are not presented as live/testnet/production evidence.

## Static preview

Without installing dependencies:

```bash
cd preview-static
python3 -m http.server 4173
```

Open `http://localhost:4173`.
