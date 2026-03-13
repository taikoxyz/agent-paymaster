# Servo — Agent-Native Paymaster for Taiko

ERC-4337 paymaster and bundler that lets agents and dApps pay gas in USDC on Taiko Alethia. No ETH required, no wallet setup, no API keys.

Releases are tag-driven. Pushing `vX.Y.Z` runs the release workflow, deploys the API and bundler to Railway, deploys the web app to Vercel, smoke tests the live stack, and then creates or updates the matching GitHub Release from `CHANGELOG.md`.

## How it works

Servo implements the standard ERC-4337 paymaster flow. An agent that holds USDC but no ETH can submit transactions on Taiko without ever touching the native gas token.

```
Agent (has USDC, no ETH)
  |
  1. POST /v1/paymaster/quote  { userOp, token: USDC }
  |
  v
Servo API
  |  calls bundler: eth_estimateUserOperationGas
  |  prices: gasCost_in_ETH x oracle ETH/USDC price x surcharge
  |  oracle policy: Chainlink mainnet primary, Coinbase + Kraken fallback, fail-closed on quorum/deviation issues
  |  surcharge is configurable; 5% is the default reference in this repo
  |  signs full sponsorship terms with EIP-712 (quote signer key)
  |  returns: { packed paymasterAndData, paymasterData, gas fields, maxTokenCost: "2.37 USDC", quoteId }
  |
  v
Agent
  |  attaches the returned gas fields to the UserOp
  |  uses the packed paymasterAndData directly for on-chain handleOps flows
  |  if needed, can also approve USDC beforehand or attach an ERC-2612 permit
  |  signs the full UserOp
  |
  2. POST /rpc  { method: "eth_sendUserOperation", params: [userOp, entryPoint] }
  |
  v
Servo API --> forwards to Bundler
  |  bundler validates, adds to mempool
  |  bundler batches UserOps into a bundle transaction
  |
  3. Bundler submits bundle TX on-chain (bundler pays ETH gas)
  |
  v
EntryPoint contract (on-chain)
  |
  |  for each UserOp in the bundle:
  |
  |-- _validatePaymasterUserOp() on TaikoUsdcPaymaster:
  |     - verifies quote signature against the full sponsorship-relevant UserOp fields
  |     - uses existing allowance, or executes a USDC permit if one was attached
  |     - checks agent has enough USDC balance
  |     - transfers maxTokenCost USDC from agent -> paymaster (pre-fund lock)
  |     - returns validation data (validAfter/validUntil window)
  |
  |-- Executes the agent's actual callData (the thing they wanted to do)
  |
  |-- _postOp() on TaikoUsdcPaymaster:
  |     - calculates actual gas used + signed postOp overhead
  |     - converts that native cost using the signed exchange rate and signed surcharge
  |     - if actual < pre-funded: refunds surplus USDC to agent
  |     - if actual > pre-funded and the op succeeded: pulls additional USDC from agent
  |     - if the op reverted: caps charges at the pre-funded amount
  |     - emits UserOperationSponsored event
  |
  v
EntryPoint reimburses the bundler in ETH for gas spent
```

**Why the paymaster holds ETH**: The EntryPoint requires every paymaster to maintain an ETH deposit. When a bundler submits a transaction, it pays gas in ETH upfront. The EntryPoint then reimburses the bundler from the paymaster's deposit. Without this deposit, the EntryPoint rejects the UserOp. The paymaster effectively converts between USDC (what the agent pays) and ETH (what the network charges). In this repo, 5% is the default surcharge reference, but the signed quote is authoritative and the surcharge is configurable.

## Packages

| Package                                | Description                                                   |
| -------------------------------------- | ------------------------------------------------------------- |
| `@agent-paymaster/api`                 | Hono API service (quotes, RPC gateway, rate limiting)         |
| `@agent-paymaster/bundler`             | ERC-4337 bundler (gas estimation, mempool, bundle submission) |
| `@agent-paymaster/sdk`                 | TypeScript client for agents                                  |
| `@agent-paymaster/shared`              | Shared types and helpers                                      |
| `@agent-paymaster/paymaster-contracts` | TaikoUsdcPaymaster Solidity contract (Foundry)                |
| `@agent-paymaster/web`                 | Next.js landing page                                          |

## Requirements

- Node.js 22+
- pnpm 10+
- Foundry (for contract development)

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm check
```

Cut a release:

```bash
# 1. Update package.json, packages/api/src/openapi.ts, and docs/api-openapi.yaml
# 2. Add a matching section to CHANGELOG.md
git commit -am "chore(release): cut vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
```

Common release helpers:

```bash
pnpm release:validate-version vX.Y.Z
pnpm release:notes vX.Y.Z
SMOKE_API_BASE_URL=https://api.example.com pnpm smoke:deploy
SMOKE_WEB_URL=https://servo.example.com pnpm smoke:deploy
```

Local verification:

```bash
pnpm lint
pnpm format
pnpm test
pnpm build
pnpm test:contracts
```

`pnpm test` builds the workspace packages first so a fresh clone exercises the same module resolution path as GitHub Actions.

Run services locally:

```bash
pnpm dev
```

## API endpoints

`@agent-paymaster/api` exposes:

- `POST /rpc`: unified JSON-RPC endpoint (`eth_*` proxied to bundler, `pm_*` handled by paymaster quote service).
- `POST /v1/paymaster/quote`: returns paymaster data + USDC-denominated max gas cost.
- `GET /health`: aggregate service health.
- `GET /status`: runtime dependency/config status.
- `GET /metrics`: Prometheus metrics.
- `GET /openapi.json`: OpenAPI document.

Static OpenAPI file: `docs/api-openapi.yaml`.

## Contracts

Run contract tests:

```bash
pnpm --filter @agent-paymaster/paymaster-contracts test
```

Deploy paymaster contract:

```bash
pnpm --filter @agent-paymaster/paymaster-contracts deploy:taiko-mainnet
pnpm --filter @agent-paymaster/paymaster-contracts deploy:taiko-hoodi
```

## Docker

```bash
docker compose up --build
```

The API uses `Dockerfile` (default CMD: API server on port 3000). The bundler uses `Dockerfile.bundler` (CMD: bundler on port 3001). Both share a persistent volume at `/app/data` for SQLite.

## Releases and deployment

The release workflow lives in `.github/workflows/release.yml`. It is intentionally simple:

1. Validate that the pushed tag matches `package.json`, `packages/api/src/openapi.ts`, and `docs/api-openapi.yaml`.
2. Validate that `CHANGELOG.md` contains a non-empty `## [vX.Y.Z] - YYYY-MM-DD` section.
3. Re-run lint, format, tests, build, contract tests, and both Docker builds.
4. Deploy `railway.bundler.json` to the Railway bundler service, then `railway.api.json` to the Railway API service.
5. Wait for Railway `/health`, then smoke test `/status`, `/rpc`, and `/v1/paymaster/quote`.
6. Deploy `packages/web` to Vercel production, wait for the public production URL, and smoke test the live site over anonymous HTTP.
7. Create or update the GitHub Release using the matching changelog section.

Required GitHub repository variables:

- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_API_SERVICE_ID`
- `RAILWAY_BUNDLER_SERVICE_ID`
- `RAILWAY_API_BASE_URL`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_PRODUCTION_URL`

Required GitHub repository secrets:

- `RAILWAY_API_TOKEN`
- `VERCEL_TOKEN`

Vercel production should use standard deployment protection (`prod_deployment_urls_and_all_previews`) so preview deployments stay protected while `VERCEL_PRODUCTION_URL` remains publicly reachable.

## Networks

Configured for:

- `taikoMainnet` (Chain ID: 167000)
- `taikoHoodi` (Chain ID: 167013)
