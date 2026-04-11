# Changelog

All notable user-facing changes to `agent-paymaster` are documented in this file.

Format:

- Keep unreleased notes under `Unreleased` until a tag is cut.
- Group notes in this order: `Added`, `Changed`, `Fixed`, `Docs`, `Security`.
- Keep bullets short and focused on operator or integrator impact.

## [Unreleased]

### Changed

- Replaced the hand-rolled `TaikoUsdcPaymaster` contract with a thin `ServoPaymaster` wrapper over Pimlico's audited `SingletonPaymasterV7` (vendored from `pimlicolabs/singleton-paymaster` under `packages/paymaster-contracts/src/pimlico/`). Deletes ~550 lines of custom contract surface in exchange for Pimlico's audited base.
- Quote signatures now use EIP-191 `personal_sign` over Pimlico's custom UserOp hash instead of EIP-712. Off-chain signer implementations must switch from `signTypedData` to `signMessage`.
- The 5% Servo surcharge is now baked into the signed `exchangeRate` instead of carrying a separate `surchargeBps` field — Pimlico's ERC-20 mode has no surcharge slot.
- USDC allowance is no longer bundled into `paymasterData`. Fresh accounts now prepend `permit(MAX_UINT256)` to the account `callData` and batch it with the real action in a single UserOperation, so a counterfactual account can be funded, deployed, approved, and used without ever holding ETH.
- `pm_getCapabilities` now returns an `allowance` section (with `standard: "EIP-2612"`, `spender: "paymaster"`, `bootstrap: "bundled-userop"`) instead of the old `permit` object.
- The `ServoPaymaster` contract pools USDC on itself (`treasury = address(this)`). A new admin-gated `withdrawToken(token, to, amount)` lets operators sweep accumulated USDC.

### Removed

- `PAYMASTER_DATA_PARAMETERS` and `SPONSORED_USER_OPERATION_TYPES` constants from `@agent-paymaster/shared`. Replaced by `encodeServoErc20PaymasterConfig` and `computeServoPaymasterSigningHash`.
- `PermitContext` from `@agent-paymaster/sdk`. The SDK no longer accepts a permit context parameter on `getPaymasterData`.
- On-chain guardrail configuration (`PAYMASTER_MAX_VERIFICATION_GAS_LIMIT`, `PAYMASTER_MAX_POSTOP_OVERHEAD_GAS`, `PAYMASTER_MAX_NATIVE_COST_WEI`, `PAYMASTER_MAX_SURCHARGE_BPS`). Pimlico trusts the quote signer to bound these off-chain.

## [v0.2.12] - 2026-04-01

### Fixed

- `pm_getPaymasterStubData` now correctly accepts ERC-4337 v0.7 account deployment fields (`factory` + `factoryData`) by normalizing them to packed `initCode` before internal bundler gas estimation, instead of forwarding an ambiguous payload that included both representations.
- Malformed v0.7 `factory` values are now rejected earlier as `-32602` invalid params, preserving the bundler's 20-byte address validation after API-side normalization.

## [v0.2.11] - 2026-03-24

### Changed

- Bundler `callGasLimit` estimation now uses `eth_estimateGas` simulation when possible and applies a configurable `BUNDLER_CALL_GAS_BUFFER_PERCENT` safety margin (default `15`), instead of relying on the calldata-size heuristic alone.

### Fixed

- Complex UserOps such as ERC-8004 registrations no longer get 3x+ underestimated `callGasLimit` values during quoting and submission. If the sender is undeployed or RPC simulation fails, the bundler now falls back to heuristic `callGasLimit × 3`.

## [v0.2.10] - 2026-03-23

### Fixed

- Gas price oracle now uses `eth_feeHistory` (median of 50th-percentile tips over 10 blocks) instead of `eth_maxPriorityFeePerGas`, which returned 0.675 gwei on Taiko when the actual median tip is 0. This was inflating suggested gas prices by ~75× and USDC quotes by ~15×. With the fix, a cold-start account deployment quote drops from ~1.5 USDC to ~0.05 USDC.

## [v0.2.9] - 2026-03-23

### Fixed

- Gas price oracle was not wired through to the PaymasterService config, causing `gasPriceGuidance` to always be omitted from responses. The oracle is now correctly passed to the internal config.

## [v0.2.8] - 2026-03-23

### Added

- Gas price guidance in quote responses and capabilities. `pm_getPaymasterStubData`, `pm_getPaymasterData`, `pm_getCapabilities`, and `/capabilities` now include a `gasPriceGuidance` object with `baseFeePerGas`, `suggestedMaxFeePerGas`, and `suggestedMaxPriorityFeePerGas` fetched from the Taiko RPC. This helps agents pick a realistic `maxFeePerGas` instead of overshooting (e.g. 10 gwei vs 0.03 gwei), which can reduce USDC quote ceilings by 100×.

## [v0.2.7] - 2026-03-23

### Fixed

- `pm_getPaymasterStubData` no longer fails when the caller omits `initCode` or `signature` from the UserOp. The API now injects safe defaults before forwarding to the bundler for gas estimation, matching the ERC-4337 spec expectation that stub calls work with incomplete UserOps.
- Internal RPC errors now include a `detail` field with the underlying error message, making production debugging easier.

## [v0.2.6] - 2026-03-22

### Added

- Agent skill (`skills/servo-agent/`) teaching AI agents how to create ERC-4337 accounts and transact on Taiko paying gas in USDC via Servo, using standard viem tooling and JSON-RPC.

## [v0.2.5] - 2026-03-17

### Fixed

- Bundler admission simulation now passes through when `simulateValidation` revert data cannot be decoded (EntryPoint v0.7 moved this function to a separate `EntryPointSimulations` contract). Invalid UserOps are still caught during `handleOps` simulation in the submitter.

## [v0.2.4] - 2026-03-17

### Changed

- SDK rewritten to use `viem/account-abstraction` primitives. `getUserOperationHash` is now a pure local computation (no RPC call). Custom UserOp building, packing, and signing modules removed. SDK source reduced by 50%.
- Initial quote step in SDK `createAndExecute` now uses `pm_getPaymasterStubData` instead of full `pm_getPaymasterData`, eliminating a redundant server-side simulation round-trip.
- EntryPoint version references corrected from v0.8 to v0.7 across shared, API, bundler, and SDK (matching the actual eth-infinitism/account-abstraction v0.7.0 submodule).
- Test-only contracts (`PaymasterStub.sol`, `Permit4337Account.sol`) moved from `src/` to `test/`.
- SDK address validation now uses `viem.isAddress` with consistent lowercase normalization.

### Fixed

- Duplicate `CANONICAL_TAIKO_ENTRY_POINT` constant in bundler replaced with imported `SERVO_TAIKO_ENTRY_POINT_V07` from shared.
- Redundant `encodeFunctionData` call for `createAccount` in SDK flow replaced with `initCode` slice derivation.

## [v0.2.3] - 2026-03-16

### Fixed

- Quote clock skew: `validAfter` now includes a 30-second backward grace window to tolerate API/chain clock drift.
- Paymaster verification gas increased from 60K to 150K to prevent OOG during permit attempts and signature verification.
- On-chain `maxQuoteTtlSeconds` increased from 90 to 150 to accommodate the grace window.

## [v0.2.2] - 2026-03-16

### Added

- Resilient auto-submitter for the bundler: claims pending UserOps, simulates, and submits `handleOps` bundles with configurable concurrency and timeout tracking.
- EntryPoint deposit monitoring and oracle quorum validation in the API health checks.
- End-to-end test script (`scripts/e2e-test.ts`) for full paymaster flow testing.

### Fixed

- Bundler review follow-ups: improved error handling, logging, and edge-case resilience in the submission loop.

## [v0.2.1] - 2026-03-15

### Changed

- Landing page now uses Taiko brand identity (pink accent, Taiko gray palette).
- Integration section reframed as agent-first: main CTA is "give your agent this endpoint" rather than manual code integration.
- All CTAs updated from "Start building" to "Use with your agent".
- Pricing simplified to single pay-per-use card.

### Docs

- README rewritten: expanded intro, added agent integration guide with production RPC URL, simplified four-phase "how it works", moved releases under Development section.
- Added links bar (landing page, API status, OpenAPI spec) to README.

## [v0.2.0] - 2026-03-13

### Changed

- **BREAKING**: Removed the `@agent-paymaster/sdk` package. Agents now use standard ERC-7677 paymaster RPC methods (`pm_getPaymasterData`, `pm_getPaymasterStubData`) with pure viem — no proprietary SDK dependency needed.
- **BREAKING**: Removed the `POST /v1/paymaster/quote` REST endpoint. All paymaster interaction now goes through the unified `/rpc` JSON-RPC gateway.
- Added server-side EIP-2612 permit embedding via the ERC-7677 `context.permit` parameter — agents pass their permit in the RPC context and receive ready-to-use `paymasterData` with the permit already encoded.
- Exported `PAYMASTER_DATA_PARAMETERS` and `SPONSORED_USER_OPERATION_TYPES` from `@agent-paymaster/shared` as canonical protocol-level ABI constants.
- Removed the `PersistenceStore` quote-caching layer from the API gateway.

### Fixed

- Eliminated an encode-decode-reencode cycle on the `pm_getPaymasterData` hot path by refactoring `quote()` to accept an optional permit parameter.
- Hoisted `resolveRouteLabel` route Set to module scope to avoid per-request allocation.
- Added `parseDecimalBigInt` for validated permit input parsing, replacing unsafe `BigInt(String(...))` on untrusted context values.

### Docs

- Updated landing page code example, README, Agents.md, and OpenAPI specs to reflect the SDK-free ERC-7677 integration flow.
- Updated deployment smoke scripts to use `pm_getPaymasterStubData` via `/rpc` instead of the removed REST endpoint.

## [v0.1.6] - 2026-03-13

### Fixed

- Removed the `cache: pnpm` setting from `actions/setup-node` so the Corepack-based pnpm setup works reliably without requiring `pnpm` on `PATH` during the GitHub Action bootstrap phase.

## [v0.1.5] - 2026-03-13

### Fixed

- Replaced `pnpm/action-setup@v4` with Corepack-based pnpm activation so the release workflow no longer depends on any Node 20 GitHub JavaScript actions.

## [v0.1.4] - 2026-03-13

### Fixed

- Upgraded the release workflow to `actions/checkout@v6` and `actions/setup-node@v6`, and opted GitHub JavaScript actions into Node 24 to clear the hosted-run deprecation warning before the June 2026 runner switch.

## [v0.1.3] - 2026-03-13

### Fixed

- Changed the Vercel release smoke test to validate the public production URL instead of only the authenticated deployment URL, and added support for public web smoke checks in `pnpm smoke:deploy`.
- Removed the stray `packages/web/package-lock.json` so Next.js release builds stop inferring a conflicting workspace root.

### Docs

- Documented the required `VERCEL_PRODUCTION_URL` GitHub Actions variable and the expected Vercel standard deployment protection setting for public releases.

## [v0.1.2] - 2026-03-13

### Fixed

- Limited the Railway bundler image build to the `shared` and `bundler` workspaces so the release deploy no longer depends on SDK-only package links inside the container build stage.

## [v0.1.1] - 2026-03-13

### Fixed

- Made the root `pnpm test` command build workspace packages before running Vitest so release verification works on clean Linux checkouts and fresh clones.

### Docs

- Generalized the release examples in `README.md` and clarified the clean-checkout test behavior in `Agents.md`.

## [v0.1.0] - 2026-03-13

### Added

- Initial Servo release with a Hono API gateway for `/v1/paymaster/quote`, `/rpc`, `/health`, `/status`, `/metrics`, and `/openapi.json`.
- ERC-4337 bundler service for Taiko with packed UserOperation handling, mempool persistence, receipt lookup, and bundle lifecycle tracking.
- TypeScript SDK helpers for paymaster quotes, paymaster data packing, and permit-assisted sponsorship flows.
- Solidity paymaster contracts for quote validation, permit support, and USDC settlement on Taiko.
- Next.js landing page for the public Servo product site on Vercel.

### Changed

- Paymaster quote pricing now uses mainnet Chainlink as the primary oracle with Coinbase and Kraken fallbacks, and defaults to PublicNode when `ETHEREUM_MAINNET_RPC_URL` is unset.
- Releases are now tag-driven and deploy the Railway API, Railway bundler, and Vercel web app from one GitHub Actions workflow after changelog and version validation.

### Fixed

- Added release smoke coverage for live health, JSON-RPC routing, and quote generation before a GitHub Release is published.

### Docs

- Documented the release contract, required GitHub Actions variables and secrets, and the Railway plus Vercel deployment flow in `README.md` and `Agents.md`.

[Unreleased]: https://github.com/ggonzalez94/agent-paymaster/compare/v0.2.12...HEAD
[v0.2.12]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.2.12
[v0.2.5]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.2.5
[v0.2.4]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.2.4
[v0.2.3]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.2.3
[v0.2.0]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.2.0
[v0.1.6]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.6
[v0.1.5]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.5
[v0.1.4]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.4
[v0.1.3]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.3
[v0.1.2]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.2
[v0.1.1]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.1
[v0.1.0]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.0
