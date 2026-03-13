# Changelog

All notable user-facing changes to `agent-paymaster` are documented in this file.

Format:

- Keep unreleased notes under `Unreleased` until a tag is cut.
- Group notes in this order: `Added`, `Changed`, `Fixed`, `Docs`, `Security`.
- Keep bullets short and focused on operator or integrator impact.

## [Unreleased]

### Added

- None yet.

### Changed

- None yet.

### Fixed

- None yet.

### Docs

- None yet.

### Security

- None yet.

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

[Unreleased]: https://github.com/ggonzalez94/agent-paymaster/compare/v0.1.2...HEAD
[v0.1.2]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.2
[v0.1.1]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.1
[v0.1.0]: https://github.com/ggonzalez94/agent-paymaster/releases/tag/v0.1.0
