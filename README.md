# Servo — Agent-Native Paymaster for Taiko

ERC-4337 paymaster and bundler that lets agents and dApps pay gas in USDC on Taiko Alethia. No ETH required, no wallet setup, no API keys.

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
  |  prices: gasCost_in_ETH x signed exchangeRate x surcharge
  |  surcharge is configurable; 5% is the default reference in this repo
  |  signs full sponsorship terms with EIP-712 (quote signer key)
  |  returns: { paymasterAndData, gas fields, maxTokenCost: "2.37 USDC", quoteId }
  |
  v
Agent
  |  attaches the returned paymasterAndData + gas fields to the UserOp
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

| Package | Description |
|---|---|
| `@agent-paymaster/api` | Hono API service (quotes, RPC gateway, rate limiting) |
| `@agent-paymaster/bundler` | ERC-4337 bundler (gas estimation, mempool, bundle submission) |
| `@agent-paymaster/sdk` | TypeScript client for agents |
| `@agent-paymaster/shared` | Shared types and helpers |
| `@agent-paymaster/paymaster-contracts` | TaikoUsdcPaymaster Solidity contract (Foundry) |
| `@agent-paymaster/web` | Next.js landing page |

## Requirements

- Node.js 22+
- pnpm 10+
- Foundry (for contract development)

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm lint
pnpm test
pnpm build
```

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

## Networks

Configured for:

- `taikoMainnet` (Chain ID: 167000)
- `taikoHoodi` (Chain ID: 167013)
