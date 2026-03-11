# Agent Paymaster Monorepo

Monorepo scaffold for the Taiko-focused ERC-4337 paymaster and bundler stack.

## Packages

- `@agent-paymaster/api`: Hono API service.
- `@agent-paymaster/bundler`: bundler worker/service skeleton.
- `@agent-paymaster/sdk`: TypeScript client for unified RPC + paymaster quote APIs.
- `@agent-paymaster/shared`: shared types and helpers.
- `@agent-paymaster/paymaster-contracts`: Hardhat contracts and tests.

## Requirements

- Node.js 22+
- pnpm 10+

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

## API gateway endpoints

`@agent-paymaster/api` exposes:

- `POST /rpc`: unified JSON-RPC endpoint (`eth_*` proxied to bundler, `pm_*` handled by paymaster quote service).
- `POST /v1/paymaster/quote`: returns paymaster data + USDC-denominated max gas cost.
- `GET /health`: aggregate service health.
- `GET /status`: runtime dependency/config status.
- `GET /metrics`: Prometheus metrics.
- `GET /openapi.json`: OpenAPI document.

Static OpenAPI file: `docs/api-openapi.yaml`.

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

## Networks

Hardhat is configured for:

- `taikoMainnet`
- `taikoHoodi`
