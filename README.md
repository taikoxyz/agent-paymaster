# Servo — Agent-Native Paymaster for Taiko

An ERC-4337 paymaster and bundler that lets AI agents and dApps pay for gas in USDC on [Taiko](https://taiko.xyz). No ETH needed, no wallet setup, no API keys.

Traditional ERC-4337 paymasters require upfront registration, API keys, or manual deposit flows. Servo removes all of that. Any smart account with USDC can fund its undeployed counterfactual address, then deploy and transact in a single sponsored UserOperation. The client signs a standard [EIP-2612 permit](https://eips.ethereum.org/EIPS/eip-2612), batches it into the account `callData`, Servo signs the final Pimlico ERC-20 paymaster quote with `personal_sign`, and settlement happens atomically on-chain.

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
3. Build an action-only UserOperation with `initCode` pointing to the factory and call `pm_getPaymasterStubData` to learn the paymaster address, token address, and `maxTokenCost`
4. If the account does not already have enough USDC allowance, sign an EIP-2612 permit and rebuild the account `callData` as `executeBatch([permit, ...realCalls])`
5. Call `pm_getPaymasterData` for that exact final UserOperation
6. Sign and submit via `eth_sendUserOperation` — the account is funded, deployed, approved, and used with no ETH ever touching the smart account

All methods go through the single `/rpc` endpoint using standard [ERC-7677](https://eips.ethereum.org/EIPS/eip-7677) JSON-RPC.

## How it works

The agent holds USDC but no ETH. The entire gas payment happens in USDC through four phases:

**1. Estimate** — The agent calls `pm_getPaymasterStubData` with a draft UserOperation. The API estimates gas via the bundler, using `eth_estimateGas` when the account is already deployed and conservative heuristics for undeployed-account paths. The API then converts the ETH cost to USDC using a composite price oracle (Chainlink primary, Coinbase + Kraken fallback), applies a surcharge (default 5%), and returns the paymaster address, token address, gas limits, and a USDC cost ceiling.

**2. Build + quote** — If the sender lacks sufficient allowance, the agent signs an [EIP-2612 USDC permit](https://eips.ethereum.org/EIPS/eip-2612) and prepends it to the account `callData` in the same UserOperation. It then calls `pm_getPaymasterData` for that exact final UserOperation. The API returns `personal_sign`-signed Pimlico ERC-20 mode paymaster fields that are bound to the final `callData`; Servo keeps the outer paymaster gas caps conservative for execution safety, but signs smaller inner billing fields so token settlement tracks real `postOp` costs more closely.

**3. Submission** — The agent signs the final UserOperation and submits it via `eth_sendUserOperation`. The bundler validates it, stores it in the mempool, and a background submitter loop simulates and forwards it to `handleOps` on-chain. Finalized operation metadata, including emitted receipt logs, is persisted so `eth_getUserOperationByHash` / `eth_getUserOperationReceipt` survive restarts, and exact-hash retries are requeued after failed attempts. The bundler pays ETH gas upfront and emits estimate-vs-actual gas drift events when operations finalize.

**4. On-chain settlement** — The EntryPoint calls the paymaster contract, which verifies the quote signature during validation. The account callData runs first, so a batched permit can create allowance for a fresh counterfactual account during the same UserOperation. After the agent's transaction executes, `postOp` pulls the actual gas cost in USDC from the sender and leaves the remainder in the account. Servo explicitly disables Pimlico's extra unused-gas penalty overlay, so users only bear EntryPoint's native unused-gas penalty.

> **Why does the paymaster hold ETH?** The EntryPoint requires paymasters to maintain an ETH deposit to reimburse bundlers for gas. The paymaster converts between USDC (what agents pay) and ETH (what the network charges).

## Packages

| Package                                | Description                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `@agent-paymaster/api`                 | Hono API — quotes, RPC gateway, rate limiting                                      |
| `@agent-paymaster/bundler`             | ERC-4337 bundler — simulation-backed gas estimation, mempool, automatic submission |
| `@agent-paymaster/shared`              | Shared types + Pimlico ERC-20 paymaster encoding/hashing helpers                   |
| `@agent-paymaster/paymaster-contracts` | ServoPaymaster (Pimlico SingletonPaymasterV7) + ServoAccount + ServoAccountFactory |
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

Optional bundler tuning:

- `BUNDLER_CHAIN_ID` selects the target Taiko chain for bundler hashing + viem chain context (default `167000`).
- `BUNDLER_CHAIN_RPC_URL` overrides the Taiko RPC used for `eth_estimateGas`, `simulateValidation`, and `handleOps` submission.
- `BUNDLER_BENEFICIARY_ADDRESS` overrides the fee recipient; by default the bundler uses the submitter address.
- `BUNDLER_CALL_GAS_BUFFER_PERCENT` adds extra headroom to simulated `callGasLimit` values (default `15`).
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

| Method                        | Description                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| `pm_getPaymasterStubData`     | Gas estimate + USDC cost quote (stub)                                    |
| `pm_getPaymasterData`         | Signed Pimlico ERC-20 mode paymaster fields                              |
| `eth_sendUserOperation`       | Submit UserOp (proxied to bundler)                                       |
| `eth_getUserOperationReceipt` | Finalized UserOp receipt with top-level `logs` and nested `receipt.logs` |
| `eth_supportedEntryPoints`    | List supported EntryPoints                                               |

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

- `ServoPaymaster.sol` — wrapper around Pimlico's `SingletonPaymasterV7` (vendored under `src/pimlico/`) that adds an admin-gated `withdrawToken` sweep for the pooled USDC treasury and disables Pimlico's extra unused-gas penalty overlay. Servo signs ERC-20 mode quotes off-chain with a `personal_sign`-compatible Pimlico hash; the 5% surcharge is baked into the signed `exchangeRate`.
- `Permit4337Account.sol` — minimal ERC-4337 account with ERC-1271 permit support (smoke-test helper).
- `ServoAccount.sol` — canonical Servo single-owner ERC-4337 account with `execute`, `executeBatch`, ERC-1271 validation, and ERC-721 safe-receive support via OpenZeppelin `ERC721Holder`.
- `ServoAccountFactory.sol` — deterministic CREATE2 factory for ServoAccount deployment and address derivation. New Taiko mainnet deployments should use `0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716`.

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

The workflow validates versions, re-runs CI, deploys the bundler and API to Railway, smoke tests the live API/quote flow, and publishes the GitHub Release. Vercel web deploy is currently commented out pending token refresh.

Release helpers:

```bash
pnpm release:validate-version vX.Y.Z
pnpm release:notes vX.Y.Z
SMOKE_API_BASE_URL=https://api.example.com pnpm smoke:deploy
```

<details>
<summary>Required GitHub Actions configuration</summary>

**Variables**: `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_BUNDLER_SERVICE_ID`, `RAILWAY_API_BASE_URL`

**Secrets**: `RAILWAY_API_TOKEN`

</details>
