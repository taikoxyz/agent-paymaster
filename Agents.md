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
  shared/        → Types + Pimlico ERC-20 paymaster encoding/hashing helpers
  paymaster-contracts/ → Solidity (Foundry): ServoPaymaster (Pimlico SingletonPaymasterV7) + ServoAccount + ServoAccountFactory
  web/           → Next.js 15 landing page (Tailwind 4)
```

**Dependency flow**: `shared` ← `api`, `bundler`. No circular deps.

## Architecture (How It Works)

1. Agent builds a partial UserOp with USDC but no ETH
2. `pm_getPaymasterStubData` via `POST /rpc` → API asks the bundler for best-effort gas limits (`eth_estimateGas` when the sender is already deployed, conservative heuristics otherwise), prices via Chainlink oracle, and returns the paymaster address, token address, and `maxTokenCost`
3. If allowance is insufficient, the client signs an EIP-2612 `permit(MAX_UINT256)` and prepends it to the account `callData` in the same cold-start UserOp
4. `pm_getPaymasterData` via `POST /rpc` → API encodes a Pimlico ERC-20 mode paymaster config for the exact final UserOp and returns the `personal_sign`-signed `paymasterAndData` (the 5% Servo surcharge is baked into the signed `exchangeRate`; outer paymaster gas caps stay conservative while the inner billed `postOpGas` is intentionally lower)
5. Agent submits the final UserOp via `POST /rpc` (`eth_sendUserOperation`)
6. Bundler queues the UserOp, the submitter loop simulates it, then submits `handleOps` to EntryPoint (and logs estimate-vs-actual drift when finalized)
7. Pimlico's `SingletonPaymasterV7._validateERC20Mode` verifies the signer and returns a postOp context; no funds are pulled in validation (`preFundInToken = 0`)
8. UserOp executes. Fresh accounts can be funded at the counterfactual address, deployed via `initCode`, approve USDC, and perform the real action in this same operation
9. `_postOp` pulls the final USDC cost from the sender to the treasury (the paymaster contract itself); Servo disables Pimlico's extra penalty overlay so users only keep EntryPoint's native unused-gas penalty, and the operator sweeps accumulated USDC via `ServoPaymaster.withdrawToken`

Bundler lifecycle notes: pending and finalized UserOps are persisted in SQLite so receipt lookups survive restarts, finalized receipt logs remain available via `eth_getUserOperationReceipt`, failed hash-identical retries are requeued, and finalized retention is capped to keep memory bounded.

**Key design decision**: pricing is off-chain (API signs bounded quotes), validation is on-chain (contract checks signature, never calls external oracles). The paymaster contract is Pimlico's audited `SingletonPaymasterV7` vendored under `packages/paymaster-contracts/src/pimlico/`, wrapped by a `ServoPaymaster.sol` that adds a treasury sweep and disables Pimlico's extra penalty overlay. Signatures are EIP-191 `personal_sign` over Pimlico's custom UserOp hash (not EIP-712).

## API Endpoints

| Method | Path            | Purpose                                    |
| ------ | --------------- | ------------------------------------------ |
| POST   | `/rpc`          | JSON-RPC gateway (`eth_*`, `pm_*` methods) |
| GET    | `/health`       | Aggregate health check                     |
| GET    | `/status`       | Runtime config + dependency status         |
| GET    | `/metrics`      | Prometheus metrics                         |
| GET    | `/openapi.json` | OpenAPI 3.1 spec                           |

Monitoring signals exposed in `/metrics` include submitter ETH balance, mempool depth and age buckets, acceptance-to-inclusion success/latency, quote-to-submission conversion, and failure reason distributions.

`eth_getUserOperationReceipt` returns receipt logs at both the top level (`logs`) and inside the nested transaction receipt (`receipt.logs`) so viem-compatible clients can parse emitted events directly.

## Contracts

**Solidity 0.8.24** with Foundry (optimizer 200 runs, via-ir, Cancun EVM).

- `ServoPaymaster.sol` — wraps `pimlico/SingletonPaymasterV7.sol`, adds an admin-gated `withdrawToken` sweep, and overrides Pimlico's extra unused-gas penalty hook to zero. ERC-20 mode only; off-chain signer sets `treasury = address(this)` so USDC accumulates on the contract.
- `pimlico/` — vendored Pimlico base contracts (`SingletonPaymasterV7`, `BaseSingletonPaymaster`, `BasePaymaster`, `MultiSigner`, `ManagerAccessControl`, `interfaces/*`). Pragma lowered to `^0.8.24`; `solady` `SafeTransferLib` replaced with OZ `SafeERC20`; v0.6 `UserOperation` overload removed.
- `ServoAccount.sol` — canonical single-owner ERC-4337 account with `execute`/`executeBatch`, ERC-1271 validation, and ERC-721 safe-receive. Fresh-account clients use `executeBatch([USDC.permit(...), ...realCalls])` so allowance setup and the real action happen in one UserOp.
- `ServoAccountFactory.sol` — deterministic CREATE2 factory for ServoAccount deployment and address derivation
- `PaymasterStub.sol` — testing stub (in `test/`)
- `Permit4337Account.sol` — smoke-test account (in `test/`)

Contract tests: `cd packages/paymaster-contracts && forge test -vvv`
Gas report: `forge test --gas-report`
Factory deployment script: `script/DeployServoAccountFactory.s.sol`

Submodules: `account-abstraction`, `openzeppelin-contracts`, `forge-std`. Clone with `--recurse-submodules`.

## Environment

Copy `.env.example` → `.env`. Three vars are required to start the API and quote flow:

- `PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY` — signs EIP-191 `personal_sign` quotes
- `PAYMASTER_ADDRESS` — deployed contract address
- `ETHEREUM_MAINNET_RPC_URL` — optional override for Chainlink oracle pricing (defaults to PublicNode public Ethereum RPC if unset)

For live `eth_sendUserOperation` support, the bundler also needs:

- `BUNDLER_SUBMITTER_PRIVATE_KEY` — funded Taiko EOA used to submit `handleOps`

Optional bundler tuning:

- `BUNDLER_CHAIN_ID` — target chain id for bundler hashing + viem chain context (default `167000`)
- `BUNDLER_CHAIN_RPC_URL` — Taiko RPC used for `eth_estimateGas`, EntryPoint `simulateValidation`, and `handleOps` submission (defaults to `TAIKO_RPC_URL`, then `TAIKO_MAINNET_RPC_URL`, then public Taiko RPC)
- `BUNDLER_BENEFICIARY_ADDRESS` — alternate fee recipient; defaults to the submitter address
- `BUNDLER_CALL_GAS_BUFFER_PERCENT` — extra percent buffer added on top of simulated `callGasLimit`, default `15`
- `BUNDLER_BUNDLE_POLL_INTERVAL_MS` — submission loop interval
- `BUNDLER_MAX_OPERATIONS_PER_BUNDLE` — max claimed UserOps per bundle, default `1`
- `BUNDLER_MAX_INFLIGHT_TRANSACTIONS` — max unconfirmed submitter txs, default `1`
- `BUNDLER_TX_TIMEOUT_MS` — how long to keep tracking an unconfirmed tx before releasing its UserOps back to pending
- `BUNDLER_MAX_FINALIZED_OPERATIONS` — max retained finalized UserOps, default `10000`

Contract deployment env vars/scripts:

- `DEPLOYER_PRIVATE_KEY` — required by `forge script` deployments
- `ENTRYPOINT_ADDRESS` — EntryPoint used by paymaster/factory deploy scripts

## Tech Stack

- **Runtime**: Node.js 22, TypeScript (strict), ES2022 target
- **HTTP**: Hono
- **Ethereum**: viem
- **DB**: SQLite (better-sqlite3, WAL mode) at `./data/servo.db`
- **Contracts**: Solidity 0.8.24 + Foundry
- **Package manager**: pnpm 10.32.1 (workspaces)
- **Tests**: Vitest (TS), Forge (Solidity)
- **CI**: GitHub Actions — lint, format, build, test (TS + Solidity)
- **Release**: semver tag push (`vX.Y.Z`) deploys Railway services, runs live smoke tests, then publishes the GitHub Release from `CHANGELOG.md` (web deploy currently commented out)

## Releases & Deployment

Servo uses a tag-driven release workflow at `.github/workflows/release.yml`.

Release contract:

- Update `package.json`, `packages/api/src/openapi.ts`, and `docs/api-openapi.yaml` to the release version.
- Add a non-empty `## [vX.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- Push the release tag with `git push origin main --follow-tags`.

Workflow behavior:

- Re-runs lint, format, TypeScript tests, and Solidity tests.
- Deploys the bundler with `railway.bundler.json`, then the API with `railway.api.json`.
- Waits for API `/health`, then smoke tests `/status`, `/rpc`, and `pm_getPaymasterData`.
- Creates or updates the GitHub Release from the matching `CHANGELOG.md` section.
- Vercel web deploy is currently commented out (pending token refresh).
- Opts GitHub JavaScript actions into Node 24 and uses the current official action majors so release runs stay ahead of the June 2026 runner default.

Required GitHub Actions variables:

- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_API_SERVICE_ID`
- `RAILWAY_BUNDLER_SERVICE_ID`
- `RAILWAY_API_BASE_URL`

Required GitHub Actions secrets:

- `RAILWAY_API_TOKEN`

Railway config: `railway.api.json` and `railway.bundler.json` are the in-repo service manifests. The CI workflow copies the appropriate one to `railway.json` before each `railway up` invocation.

## Conventions

- **Formatting**: Biome or project formatter — always run `pnpm format:write` before committing
- **Lint**: `pnpm lint` must pass. CI checks both lint and format
- **Web linting**: the monorepo root `eslint.config.mjs` applies `@next/eslint-plugin-next` to `packages/web`; run it through `pnpm --filter @agent-paymaster/web lint`
- **Tests**: co-located with source (`*.test.ts`). Every new module needs tests
- **Imports**: use workspace aliases (`@agent-paymaster/shared`, etc.)
- **Logging**: structured JSON with `requestId`, `method`, `path`, `status`, `duration`
- **Paymaster data**: always use `packPaymasterAndData()` / `normalizePaymasterAndData()` for the outer envelope and `encodeServoErc20PaymasterConfig()` / `computeServoPaymasterSigningHash()` for the inner Pimlico ERC-20 mode bytes — never hand-encode

## Common Pitfalls

- **Build order matters**: `shared` must build before `api` or `bundler`. The root `pnpm build` and `pnpm test` commands handle this, but if you run package scripts directly on a fresh clone, build dependencies first.
- **Submodules**: contract tests fail without submodules. Use `git submodule update --init --recursive` if you didn't clone with `--recurse-submodules`.
- **SQLite WAL**: the bundler and API share a SQLite volume. Don't delete `./data/` while services are running.
- **Bundler read-only mode**: if `BUNDLER_SUBMITTER_PRIVATE_KEY` is unset, the bundler rejects `eth_sendUserOperation` instead of accepting UserOps it cannot submit.
- **Quote TTL**: quotes expire (default 90s). Tests that hold quotes too long will fail on-chain.
- **Packed format**: ERC-4337 v0.7 uses packed UserOp format. Don't confuse with v0.6 struct layout.
- **Docker**: two separate Dockerfiles — `Dockerfile` (API) and `Dockerfile.bundler`. Both expose `/health`.

## Config Defaults Worth Knowing

| Var                                 | Default | What                                      |
| ----------------------------------- | ------- | ----------------------------------------- |
| `PAYMASTER_SURCHARGE_BPS`           | 500     | 5% surcharge on gas cost                  |
| `PAYMASTER_QUOTE_TTL_SECONDS`       | 90      | Quote validity window                     |
| `RATE_LIMIT_MAX_REQUESTS`           | 60      | Requests per window per sender            |
| `RATE_LIMIT_WINDOW_MS`              | 60000   | Rate limit window (1 min)                 |
| `REQUEST_TIMEOUT_MS`                | 2500    | Upstream request timeout                  |
| `BUNDLER_CHAIN_ID`                  | 167000  | Bundler chain id + viem chain context     |
| `BUNDLER_CALL_GAS_BUFFER_PERCENT`   | 15      | Extra buffer on simulated `callGasLimit`  |
| `BUNDLER_MAX_OPERATIONS_PER_BUNDLE` | 1       | Safe default bundle size                  |
| `BUNDLER_MAX_INFLIGHT_TRANSACTIONS` | 1       | Max submitter txs awaiting confirmation   |
| `BUNDLER_BUNDLE_POLL_INTERVAL_MS`   | 5000    | Submission loop cadence                   |
| `BUNDLER_TX_TIMEOUT_MS`             | 180000  | Release stale unconfirmed txs after 3 min |
| `BUNDLER_MAX_FINALIZED_OPERATIONS`  | 10000   | Retained finalized UserOps (memory + DB)  |

## Networks

| Name                    | Chain ID | Status           |
| ----------------------- | -------- | ---------------- |
| Taiko Alethia (mainnet) | 167000   | Production       |
| Taiko Hoodi             | 167013   | Not yet deployed |
