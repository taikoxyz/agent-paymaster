# Agents.md — Servo

> ERC-4337 paymaster + bundler for Taiko. Agents pay gas in USDC, no ETH needed.

**Keep this file and README.md updated when you make architectural, API, config, or deployment changes.** If you add a package, endpoint, env var, or change a core flow — update both files.

## Quick Reference

```
pnpm install          # install all deps
pnpm check            # release verification gate
pnpm build            # build everything (except contracts)
pnpm dev              # run api + bundler + shared in watch mode
pnpm test             # build workspace packages, then run all TypeScript tests
pnpm test:contracts   # Solidity tests (Forge)
pnpm lint             # lint all packages
pnpm release:notes    # print a tagged CHANGELOG.md section
pnpm smoke:deploy     # smoke-test a live API and/or web deployment
pnpm format:write     # auto-format
```

## Monorepo Layout

```
packages/
  api/           → Hono HTTP gateway (quotes, RPC proxy, metrics)  :3000
  bundler/       → ERC-4337 bundler (mempool, auto-submitter, receipts)  :3001
  shared/        → Types, EIP-712 helpers, paymaster data packing
  paymaster-contracts/ → Solidity (Foundry): TaikoUsdcPaymaster, ServoAccount, ServoAccountFactory
  web/           → Next.js 15 landing page (Tailwind 4)
```

**Dependency flow**: `shared` ← `api`, `bundler`. No circular deps. `web` is standalone.

## Architecture (How It Works)

1. Agent builds a partial UserOp with USDC but no ETH
2. `pm_getPaymasterData` via `POST /rpc` → API prices gas via oracle, returns EIP-712 signed `paymasterAndData`
3. Agent submits full UserOp via `POST /rpc` (`eth_sendUserOperation`)
4. Bundler queues the UserOp, the submitter loop simulates it, then submits `handleOps` to EntryPoint
5. Contract validates quote signature in `_validatePaymasterUserOp`
6. UserOp executes
7. Contract settles actual USDC cost in `_postOp`, refunds surplus

**Key design decision**: pricing is off-chain (API signs bounded quotes), validation is on-chain (contract checks signature, never calls external oracles).

## API Endpoints

| Method | Path            | Purpose                                    |
| ------ | --------------- | ------------------------------------------ |
| POST   | `/rpc`          | JSON-RPC gateway (`eth_*`, `pm_*` methods) |
| GET    | `/health`       | Aggregate health check                     |
| GET    | `/status`       | Runtime config + dependency status         |
| GET    | `/metrics`      | Prometheus metrics                         |
| GET    | `/openapi.json` | OpenAPI 3.1 spec                           |

## Contracts

**Solidity 0.8.24** with Foundry (optimizer 200 runs, via-ir, Cancun EVM).

- `TaikoUsdcPaymaster.sol` — main paymaster: quote validation, permit support, USDC settlement
- `Permit4337Account.sol` — account-side permit helper
- `ServoAccount.sol` — canonical single-owner ERC-4337 account with ERC-1271 permit validation
- `ServoAccountFactory.sol` — deterministic CREATE2 factory for ServoAccount deployment and address derivation
- `PaymasterStub.sol` — testing stub

Contract tests: `cd packages/paymaster-contracts && forge test -vvv`
Gas report: `forge test --gas-report`
Factory deployment script: `script/DeployServoAccountFactory.s.sol`

Submodules: `account-abstraction`, `openzeppelin-contracts`, `forge-std`. Clone with `--recurse-submodules`.

## Environment

Copy `.env.example` → `.env`. Three vars are required to start the API and quote flow:

- `PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY` — signs EIP-712 quotes
- `PAYMASTER_ADDRESS` — deployed contract address
- `ETHEREUM_MAINNET_RPC_URL` — optional override for Chainlink oracle pricing (defaults to PublicNode public Ethereum RPC if unset)

For live `eth_sendUserOperation` support, the bundler also needs:

- `BUNDLER_SUBMITTER_PRIVATE_KEY` — funded Taiko EOA used to submit `handleOps`

Optional bundler submission tuning:

- `BUNDLER_CHAIN_RPC_URL` — Taiko RPC used for submission (defaults to `TAIKO_RPC_URL`, then `TAIKO_MAINNET_RPC_URL`, then public Taiko RPC)
- `BUNDLER_BENEFICIARY_ADDRESS` — alternate fee recipient; defaults to the submitter address
- `BUNDLER_BUNDLE_POLL_INTERVAL_MS` — submission loop interval
- `BUNDLER_MAX_OPERATIONS_PER_BUNDLE` — max claimed UserOps per bundle, default `1`
- `BUNDLER_MAX_INFLIGHT_TRANSACTIONS` — max unconfirmed submitter txs, default `1`
- `BUNDLER_TX_TIMEOUT_MS` — how long to keep tracking an unconfirmed tx before releasing its UserOps back to pending

Contract deployment env vars/scripts:

- `DEPLOYER_PRIVATE_KEY` — required by `forge script` deployments
- `ENTRYPOINT_ADDRESS` — EntryPoint used by paymaster/factory deploy scripts
- `TAIKO_HEKLA_RPC_URL` — RPC endpoint for Hekla deploy scripts (`deploy:taiko-hekla`, `deploy:factory:taiko-hekla`)

## Tech Stack

- **Runtime**: Node.js 22, TypeScript (strict), ES2022 target
- **HTTP**: Hono
- **Ethereum**: viem
- **DB**: SQLite (better-sqlite3, WAL mode) at `./data/servo.db`
- **Contracts**: Solidity 0.8.24 + Foundry
- **Package manager**: pnpm 10.32.1 (workspaces)
- **Tests**: Vitest (TS), Forge (Solidity)
- **CI**: GitHub Actions — lint, format, build, test (TS + Solidity)
- **Release**: semver tag push (`vX.Y.Z`) deploys Railway + Vercel, runs live smoke tests, then publishes the GitHub Release from `CHANGELOG.md`

## Releases & Deployment

Servo uses a tag-driven release workflow at `.github/workflows/release.yml`.

Release contract:

- Update `package.json`, `packages/api/src/openapi.ts`, and `docs/api-openapi.yaml` to the release version.
- Add a non-empty `## [vX.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- Push the release tag with `git push origin main --follow-tags`.

Workflow behavior:

- Re-runs lint, format, TypeScript tests, builds, Solidity tests, and both Docker image builds.
- Deploys the bundler with `railway.bundler.json`, then the API with `railway.api.json`.
- Waits for API `/health`, then smoke tests `/status`, `/rpc`, and `pm_getPaymasterData`.
- Deploys `packages/web` to Vercel production, waits for the public production URL, and smoke tests the live site over anonymous HTTP.
- Creates or updates the GitHub Release from the matching `CHANGELOG.md` section.
- Opts GitHub JavaScript actions into Node 24 and uses the current official action majors so release runs stay ahead of the June 2026 runner default.

Required GitHub Actions variables:

- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_API_SERVICE_ID`
- `RAILWAY_BUNDLER_SERVICE_ID`
- `RAILWAY_API_BASE_URL`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_PRODUCTION_URL`

Required GitHub Actions secrets:

- `RAILWAY_API_TOKEN`
- `VERCEL_TOKEN`

Vercel should use standard deployment protection (`prod_deployment_urls_and_all_previews`) so preview deployments stay protected while the production URL stays public.

## Conventions

- **Formatting**: Biome or project formatter — always run `pnpm format:write` before committing
- **Lint**: `pnpm lint` must pass. CI checks both lint and format
- **Web linting**: the monorepo root `eslint.config.mjs` applies `@next/eslint-plugin-next` to `packages/web`; run it through `pnpm --filter @agent-paymaster/web lint`
- **Tests**: co-located with source (`*.test.ts`). Every new module needs tests
- **Imports**: use workspace aliases (`@agent-paymaster/shared`, etc.)
- **Logging**: structured JSON with `requestId`, `method`, `path`, `status`, `duration`
- **Paymaster data**: always use `packPaymasterAndData()` / `normalizePaymasterAndData()` from shared — never hand-encode

## Common Pitfalls

- **Build order matters**: `shared` must build before `api` or `bundler`. The root `pnpm build` and `pnpm test` commands handle this, but if you run package scripts directly on a fresh clone, build dependencies first.
- **Submodules**: contract tests fail without submodules. Use `git submodule update --init --recursive` if you didn't clone with `--recurse-submodules`.
- **SQLite WAL**: the bundler and API share a SQLite volume. Don't delete `./data/` while services are running.
- **Bundler read-only mode**: if `BUNDLER_SUBMITTER_PRIVATE_KEY` is unset, the bundler rejects `eth_sendUserOperation` instead of accepting UserOps it cannot submit.
- **Quote TTL**: quotes expire (default 90s). Tests that hold quotes too long will fail on-chain.
- **Packed format**: ERC-4337 v0.8 uses packed UserOp format. Don't confuse with v0.7 struct layout.
- **Docker**: two separate Dockerfiles — `Dockerfile` (API) and `Dockerfile.bundler`. Both expose `/health`.
- **Railway config**: `railway.api.json` and `railway.bundler.json` are the in-repo service manifests used by the release workflow

## Config Defaults Worth Knowing

| Var                                 | Default | What                                      |
| ----------------------------------- | ------- | ----------------------------------------- |
| `PAYMASTER_SURCHARGE_BPS`           | 500     | 5% surcharge on gas cost                  |
| `PAYMASTER_QUOTE_TTL_SECONDS`       | 90      | Quote validity window                     |
| `RATE_LIMIT_MAX_REQUESTS`           | 60      | Requests per window per sender            |
| `RATE_LIMIT_WINDOW_MS`              | 60000   | Rate limit window (1 min)                 |
| `REQUEST_TIMEOUT_MS`                | 2500    | Upstream request timeout                  |
| `BUNDLER_MAX_OPERATIONS_PER_BUNDLE` | 1       | Safe default bundle size                  |
| `BUNDLER_MAX_INFLIGHT_TRANSACTIONS` | 1       | Max submitter txs awaiting confirmation   |
| `BUNDLER_BUNDLE_POLL_INTERVAL_MS`   | 5000    | Submission loop cadence                   |
| `BUNDLER_TX_TIMEOUT_MS`             | 180000  | Release stale unconfirmed txs after 3 min |

## Networks

| Name                    | Chain ID | Status     |
| ----------------------- | -------- | ---------- |
| Taiko Alethia (mainnet) | 167000   | Production |
| Taiko Hoodi             | 167013   | Testnet    |
| Taiko Hekla             | 167009   | Testnet    |
