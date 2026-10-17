# Deploying the engine on Fly (dashboard only)

The engine runs as **one Fly machine** holding all four processes (`scripts/serve-all.mjs`):
the Core API, the MCP gateway, the webhook worker and the keeper. Its database is the
Supabase project `mitra` (the same one the customer app uses for accounts; the engine's
tables live in their own `mitra` schema, the app's in `public`). Testnets only.

Files: `Dockerfile`, `.dockerignore`, `fly.toml`, `scripts/serve-all.mjs`,
`certs/supabase-prod-ca-2021.crt`.

## What it costs

`shared-cpu-1x` with 1 GB, always on: about $6.70 a month (Fly's price for its cheapest
regions; London is slightly more). Fly has no free tier for new organisations. 1 GB because
the four processes measured about 420 MB before the webhook worker and database pools,
which puts a 512 MB machine at risk of being killed for memory. The shared IPv4 address is free;
do not buy a dedicated one.

## Secrets

Set these in the Fly dashboard: your app, then **Secrets**. A secret is never in the image or the repo.

| Name | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://postgres.tjlnxnirtltczjruymnl:<PASSWORD>@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/app/certs/supabase-prod-ca-2021.crt` |
| `MITRA_OPERATOR_TOKEN` | yes | 40+ random characters. Guards `/api/v1/admin/*`, webhooks and mandate creation |
| `MCP_TOKEN` | to serve agents | 40+ random characters. Without it the MCP gateway stays private to the machine |
| `MITRA_EVM_SETTLEMENT_KEY` | to settle and run the keeper | the engine's testnet key (hex). Its address must be the policy engine the cards name (`0x7823d6be…8116` today) |
| `MITRA_RECEIPT_SIGNER_KEY` | optional | a separate key that signs receipts |

`<PASSWORD>` is the Supabase database password. The project was created from a tool, so
nobody has seen it yet: in Supabase open the project, then **Project Settings → Database →
Reset database password**, and keep the new one in a password manager. If it has characters like `@`, `:`, `/` or `#`, percent-encode them.

The connection goes through Supabase's session pooler (the direct host is IPv6-only) and
**verifies** Supabase's certificate against the bundled root CA; checked 2026-10-12 against
this project (the TLS check passed; a wrong password was then refused).

Not set on purpose: `MITRA_BASE_SETTLEMENT_ACCOUNT=vault`, `MITRA_TEMPO_SETTLEMENT_ACCOUNT=vault`
and `MITRA_EVM_VAULT_HOLDER`. Those configure the single-principal vault rail, which pays
from the engine's own position; paying from each customer's vault is the next change
(see shared context, "The engine will pay from the vault owner's position").

## Steps

1. Sign in at fly.io with the account that should own the engine and add a payment card
   (Billing). Fly will not start a machine without one.
2. Dashboard, then **Launch an App** (or "Deploy from GitHub"). Connect GitHub when asked and
   allow Fly's GitHub app to see the repository. If the repository is not listed, the Fly
   GitHub app needs access to it, which only a repository admin can grant.
3. Pick the repository and the branch holding these files. Fly should read `fly.toml` and the
   `Dockerfile`. If it offers to generate its own `fly.toml` or a pull request, decline: the
   one in the repo is the configuration.
4. Settings to confirm on the launch screen: app name `mitra-engine` (if you choose another,
   change `app` in `fly.toml`), region London (`lhr`), machine `shared-cpu-1x` / 1 GB. Do **not**
   add Fly Postgres, Redis or Tigris: the database is Supabase.
5. Add the secrets above, at least `DATABASE_URL` and `MITRA_OPERATOR_TOKEN`, before the first
   machine starts. Without `DATABASE_URL` the machine refuses to start on purpose (an
   in-memory engine would lose everything on restart) and you will see that line in the logs.
6. Deploy. The build takes a few minutes. Then open `https://mitra-engine.fly.dev/api/v1/health`:
   it answers `{"service":"mitra",...}`.
7. Logs (app, then **Monitoring**) show each process prefixed: `[core-api]`, `[mcp-gateway]`,
   `[webhook-worker]`, `[keeper-daemon]`, and `[serve-all]` for the runner. A line saying a process
   was NOT started names the secret that turns it on.

Agents reach the MCP gateway at `https://mitra-engine.fly.dev:8443/mcp` with
`Authorization: Bearer <MCP_TOKEN>`.

## What was checked, and what was not

Checked locally on 2026-10-12: `npm ci` and `npm run build` (the Dockerfile's two steps);
the runner refusing to start without `DATABASE_URL`; health 200; the MCP gateway answering 401
without the token and 200 with it; key secrets written to 0600 files and never logged;
killing any process stops the runner and frees both ports, so Fly restarts the machine whole.

Not checked: the Docker image itself (no Docker on the machine this was written on), and the
Fly dashboard flow, which may differ from the steps above.
