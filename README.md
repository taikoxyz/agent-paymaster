# Servo — Agent-Native Paymaster for Taiko

An ERC-4337 paymaster and bundler that lets AI agents and dApps pay for gas in USDC on [Taiko](https://taiko.xyz). No ETH needed, no wallet setup, no API keys.

Traditional ERC-4337 paymasters require upfront registration, API keys, or manual deposit flows. Servo removes all of that. Any smart account with USDC can submit transactions immediately — the paymaster prices gas in real time via a composite oracle (Chainlink + Coinbase + Kraken) and settles costs atomically on-chain. The agent signs a standard [EIP-2612 permit](https://eips.ethereum.org/EIPS/eip-2612), the paymaster verifies an EIP-712 quote, and settlement happens in a single UserOperation.

[Landing page](https://web-ggonzalez94s-projects.vercel.app) · [API status](https://api-production-cdfe.up.railway.app/status) · [OpenAPI spec](docs/api-openapi.yaml) · [Deployment reference](docs/deployment.md)

## Use it with your agent

Point your agent at the production RPC endpoint and let it transact with USDC only:

```
POST https://api-production-cdfe.up.railway.app/rpc
```

Key addresses on Taiko Alethia (chain 167000):

| Contract            | Address                                      |
| ------------------- | -------------------------------------------- |
| ServoAccountFactory | `0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716` |
| EntryPoint v0.7     | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| USDC                | `0x07d83526730c7438048D55A4fc0b850e2aaB6f0b` |

See [docs/deployment.md](docs/deployment.md) for the full deployment reference (all contracts, accounts, infrastructure).

The flow for an agent is:

1. Derive a counterfactual wallet address from the ServoAccountFactory (`getAddress(owner, salt)`)
2. Fund it with USDC on Taiko (the wallet doesn't need to be deployed yet)
3. Build a UserOperation with `initCode` pointing to the factory and call `pm_getPaymasterStubData` to get a gas estimate
4. Sign a USDC permit for the quoted cost
5. Call `pm_getPaymasterData` with the permit to get signed paymaster fields
6. Submit via `eth_sendUserOperation` — the account is deployed and the transaction executes in one step, no ETH ever touched

All methods go through the single `/rpc` endpoint using standard [ERC-7677](https://eips.ethereum.org/EIPS/eip-7677) JSON-RPC.

## How it works

The agent holds USDC but no ETH. The entire gas payment happens in USDC through four phases:

**1. Estimate** — The agent calls `pm_getPaymasterStubData` with a draft UserOperation. The API estimates gas via the bundler, and the bundler combines heuristic sizing with EntryPoint `simulateValidation` pre-op gas (against the configured Taiko RPC + EntryPoint). The API then converts the ETH cost to USDC using a composite price oracle (Chainlink primary, Coinbase + Kraken fallback), applies a surcharge (default 5%), and returns a USDC cost estimate.

**2. Quote** — The agent signs an [EIP-2612 USDC permit](https://eips.ethereum.org/EIPS/eip-2612) for the quoted amount and calls `pm_getPaymasterData` with the permit attached. The API returns EIP-712 signed paymaster fields that the agent attaches to the UserOperation.

**3. Submission** — The agent signs the final UserOperation and submits it via `eth_sendUserOperation`. The bundler validates it, stores it in the mempool, and a background submitter loop simulates and forwards it to `handleOps` on-chain. Finalized operation metadata is persisted so `eth_getUserOperationByHash` / `eth_getUserOperationReceipt` survive restarts, and exact-hash retries are requeued after failed attempts. The bundler pays ETH gas upfront and emits estimate-vs-actual gas drift events when operations finalize.

**4. On-chain settlement** — The EntryPoint calls the paymaster contract, which verifies the quote signature, executes the USDC permit, and locks `maxTokenCost` USDC from the agent. After the agent's transaction executes, the contract settles the actual gas cost in USDC and refunds any surplus back to the agent.

> **Why does the paymaster hold ETH?** The EntryPoint requires paymasters to maintain an ETH deposit to reimburse bundlers for gas. The paymaster converts between USDC (what agents pay) and ETH (what the network charges).

## Packages

| Package                                | Description                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `@agent-paymaster/api`                 | Hono API — quotes, RPC gateway, rate limiting                                      |
| `@agent-paymaster/bundler`             | ERC-4337 bundler — simulation-backed gas estimation, mempool, automatic submission |
| `@agent-paymaster/shared`              | Shared types and EIP-712 helpers                                                   |
| `@agent-paymaster/sdk`                 | TypeScript SDK for counterfactual account + permit + UserOp flow                   |
| `@agent-paymaster/paymaster-contracts` | TaikoUsdcPaymaster + ServoAccount + ServoAccountFactory (Solidity / Foundry)       |
| `@agent-paymaster/web`                 | Next.js landing page                                                               |

## Quick start

```bash
cp .env.example .env    # fill in required vars
pnpm install
pnpm check              # lint + format + build + test
```

Run services locally:

```bash
pnpm dev
```

For write-capable bundler behavior, set `BUNDLER_SUBMITTER_PRIVATE_KEY`. If it is unset, the bundler starts in read-only mode and rejects `eth_sendUserOperation` instead of silently queueing UserOps it cannot submit.

Optional submission tuning:

- `BUNDLER_CHAIN_ID` selects the target Taiko chain for bundler hashing + viem chain context (default `167000`).
- `BUNDLER_CHAIN_RPC_URL` overrides the Taiko RPC used for both `simulateValidation` gas estimation and `handleOps` submission.
- `BUNDLER_MAX_OPERATIONS_PER_BUNDLE` defaults to `1` for conservative single-op bundles.
- `BUNDLER_MAX_INFLIGHT_TRANSACTIONS` defaults to `1` to keep nonce management simple and predictable.
- `BUNDLER_BUNDLE_POLL_INTERVAL_MS` defaults to `5000`.
- `BUNDLER_TX_TIMEOUT_MS` defaults to `180000`.
- `BUNDLER_MAX_FINALIZED_OPERATIONS` defaults to `10000` and bounds retained finalized UserOp records.

## API

All paymaster and bundler methods go through a single JSON-RPC endpoint:

```
POST /rpc
```

| Method                     | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `pm_getPaymasterStubData`  | Gas estimate + USDC cost quote (stub)          |
| `pm_getPaymasterData`      | Signed paymaster fields (with optional permit) |
| `eth_sendUserOperation`    | Submit UserOp (proxied to bundler)             |
| `eth_supportedEntryPoints` | List supported EntryPoints                     |

Other routes: `GET /health`, `GET /status`, `GET /metrics`, `GET /openapi.json`. Bundler `/health` now includes submitter status, mempool depth/age distribution, and UserOp lifecycle monitoring counters.

`GET /metrics` now exports production monitoring gauges alongside API request counters, including:

- submitter ETH balance (`api_bundler_submitter_balance_wei`)
- mempool depth and age buckets (`api_bundler_mempool_depth`, `api_bundler_mempool_age_bucket`)
- acceptance-to-inclusion and quote-to-submission ratios
- simulation failure and revert reason distributions

Static OpenAPI spec: [`docs/api-openapi.yaml`](docs/api-openapi.yaml).

## Contracts

```bash
pnpm --filter @agent-paymaster/paymaster-contracts test                     # run tests
pnpm --filter @agent-paymaster/paymaster-contracts test:gas                 # gas report
pnpm --filter @agent-paymaster/paymaster-contracts deploy:taiko-mainnet
pnpm --filter @agent-paymaster/paymaster-contracts deploy:taiko-hoodi
pnpm --filter @agent-paymaster/paymaster-contracts deploy:factory:taiko-mainnet
pnpm --filter @agent-paymaster/paymaster-contracts deploy:factory:taiko-hoodi
```

Key contracts in `packages/paymaster-contracts/src`:

- `TaikoUsdcPaymaster.sol` — paymaster quote verification and USDC settlement.
- `Permit4337Account.sol` — minimal ERC-4337 account with ERC-1271 permit support (smoke-test helper).
- `ServoAccount.sol` — canonical Servo single-owner ERC-4337 account with `execute`, `executeBatch`, ERC-1271 validation, and ERC-721 safe-receive support via OpenZeppelin `ERC721Holder`.
- `ServoAccountFactory.sol` — deterministic CREATE2 factory for ServoAccount deployment and address derivation. New Taiko mainnet deployments should use `0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716`.

SDK package:

- `@agent-paymaster/sdk` exports `getCounterfactualAddress`, `buildInitCode`, `buildUserOp`, `buildDummySignature`, `signPermit`, `signUserOp`, and `createAndExecute`.

## Docker

```bash
docker compose up --build
```

Two Dockerfiles: `Dockerfile` (API, port 3000) and `Dockerfile.bundler` (bundler, port 3001). Both share a persistent SQLite volume at `/app/data`.

## Networks

| Network                 | Chain ID | Status           |
| ----------------------- | -------- | ---------------- |
| Taiko Alethia (mainnet) | 167000   | Production       |
| Taiko Hoodi (testnet)   | 167013   | Not yet deployed |

## Development

### Requirements

- Node.js 22+
- pnpm 10+
- Foundry (for contract development)

### Commands

```bash
pnpm lint             # lint all packages
pnpm format:write     # auto-format
pnpm test             # build + run all TypeScript tests
pnpm test:contracts   # Solidity tests (Forge)
pnpm build            # build everything (except contracts)
pnpm check            # full verification gate
```

### Releases

Releases are tag-driven via `.github/workflows/release.yml`:

1. Update version in `package.json`, `packages/api/src/openapi.ts`, and `docs/api-openapi.yaml`
2. Add a `## [vX.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`
3. Commit, tag, and push:

```bash
git commit -am "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
```

The workflow validates versions, re-runs CI, deploys API + bundler to Railway, deploys web to Vercel, smoke tests everything, and publishes the GitHub Release.

Release helpers:

```bash
pnpm release:validate-version vX.Y.Z
pnpm release:notes vX.Y.Z
SMOKE_API_BASE_URL=https://api.example.com pnpm smoke:deploy
```

<details>
<summary>Required GitHub Actions configuration</summary>

**Variables**: `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_BUNDLER_SERVICE_ID`, `RAILWAY_API_BASE_URL`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_PRODUCTION_URL`

**Secrets**: `RAILWAY_API_TOKEN`, `VERCEL_TOKEN`

</details>
