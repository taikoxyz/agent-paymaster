# Servo — Deployment Reference

> Live deployment details for Servo on Taiko Alethia (mainnet, chain ID 167000).

## Contracts

| Contract                | Address                                      | Purpose                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EntryPoint v0.7**     | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Canonical ERC-4337 singleton (same address on every EVM chain). Routes all UserOps: deploys accounts via initCode, validates signatures, calls paymaster, settles gas.                     |
| **TaikoUsdcPaymaster**  | `0xca675148201e29b13a848ce30c3074c8de995891` | Validates off-chain EIP-712 signed gas quotes, executes USDC permits, locks `maxTokenCost` USDC during validation, settles actual cost in `_postOp`, refunds surplus to the agent.         |
| **ServoAccountFactory** | `0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716` | Deterministic CREATE2 factory for agent wallets. Deploys the current ServoAccount implementation with ERC-1271 validation and ERC-721 safe-receive support for registry `_safeMint` flows. |
| **USDC**                | `0x07d83526730c7438048D55A4fc0b850e2aaB6f0b` | Circle's bridged USDC on Taiko. 6 decimals. Supports both ERC-2612 permit variants (v/r/s and bytes signature).                                                                            |

### Paymaster configuration

| Parameter                 | Value       | Description                                                                                        |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `maxVerificationGasLimit` | 1,000,000   | Maximum verification gas accepted per UserOp. Must exceed factory CREATE2 deployment cost (~620k). |
| `maxPostOpOverheadGas`    | 100,000     | Maximum `postOpOverheadGas` in signed quotes.                                                      |
| `maxNativeCostWei`        | 0.1 ETH     | Maximum native gas cost per UserOp. Rejects ops that would cost more.                              |
| `maxQuoteTtlSeconds`      | 150         | Maximum quote validity window. Quotes beyond this are rejected on-chain.                           |
| `maxSurchargeBps`         | 1,000 (10%) | Maximum surcharge in signed quotes.                                                                |
| `lockedUsdcPrefund`       | 0           | USDC currently locked for in-flight UserOps.                                                       |

### EntryPoint deposit

The paymaster maintains an ETH deposit in the EntryPoint that reimburses the bundler for gas. Current balance: ~0.0046 ETH. If this runs dry, no UserOps can be processed — the paymaster must be topped up via `entryPoint.depositTo{value: ...}(paymasterAddress)`.

## Server-managed accounts

| Account               | Address                                      | Role                                                                                                                                                                                  | Needs ETH?          | Key location                                                                             |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| **Contract Owner**    | `0x2AB05c081B31B3882C1c0367D9b734e530237B15` | Owns the paymaster. Can call `setLimits()`, `setQuoteSigner()`, `withdrawToken()`, and manage the EntryPoint deposit.                                                                 | Yes — for admin txs | `~/.config/crypto-wallet-testing/pk.hex`                                                 |
| **Quote Signer**      | `0x208cc91CE369E969d246DeBf2a78f28BdeebB9B8` | Signs EIP-712 gas quotes. The API holds this key and signs every `pm_getPaymasterData` response. The paymaster contract verifies these signatures on-chain. Never sends transactions. | No                  | `~/.config/servo-quote-signer/pk.hex` → Railway env `PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY` |
| **Bundler Submitter** | `0x2AB05c081B31B3882C1c0367D9b734e530237B15` | Submits `handleOps` transactions to the EntryPoint. Claims UserOps from the mempool, simulates, and sends bundles. **Same key as Contract Owner** (testing wallet).                   | **Yes — critical**  | `~/.config/crypto-wallet-testing/pk.hex` → Railway env `BUNDLER_SUBMITTER_PRIVATE_KEY`   |

### ETH flow

```
Agent pays USDC → Paymaster locks USDC
Submitter fronts ETH for handleOps gas → EntryPoint reimburses from Paymaster's ETH deposit
Paymaster settles actual USDC cost in postOp → Refunds surplus USDC to agent
```

The submitter's ETH balance gets replenished by EntryPoint reimbursement after each successful `handleOps`. But it needs enough ETH to front the first transaction's gas (~0.001 ETH per bundle on Taiko).

## Infrastructure

| Service     | Platform       | URL                                                 |
| ----------- | -------------- | --------------------------------------------------- |
| **API**     | Railway        | `https://api-production-cdfe.up.railway.app`        |
| **Bundler** | Railway        | `bundler.railway.internal:3001` (private)           |
| **Web**     | Vercel         | `https://servo.dev` (when Vercel token is valid)    |
| **SQLite**  | Railway volume | `/app/data/servo.db` (shared between API + Bundler) |

### Railway project

- Project ID: `ba002e5e-0684-46e9-8bb4-d3bc2b93fa42`
- Environment: `d8994a62-a7de-4757-bed7-254976521af6`
- API service: `92ee628d-d597-475f-a76e-d0ed3af8b9c9`
- Bundler service: `568568ac-f02e-4156-8325-f3a387dfceef`
