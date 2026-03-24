---
name: servo-agent
description: >
  How to make gasless transactions on Taiko using Servo — pay gas in USDC, no ETH needed.
  Use this skill whenever someone needs to transact on Taiko without ETH, create an ERC-4337
  smart account on Taiko, use a paymaster, pay gas fees in USDC or stablecoins, build a
  UserOperation for Taiko, or integrate with the Servo bundler. Also trigger when building
  AI agents that need onchain capabilities on Taiko, when the user mentions "Servo",
  "servo paymaster", "agent-paymaster", gasless transactions on Taiko, or USDC gas payment.
  Even if the user just says "I need to do something onchain on Taiko" — this skill applies.
---

# Servo: Gasless Transactions on Taiko

Servo is an ERC-4337 paymaster + bundler for Taiko. Agents pay gas in USDC — no ETH needed, ever.

**The core loop**: build a UserOp → Servo quotes the USDC gas cost → agent signs a USDC permit → Servo bundles and submits → on-chain contract settles actual cost and refunds surplus.

**Pricing**: 5% surcharge on gas cost, included in the quote. No API key, no signup.

**Standard tooling**: Use `viem` (or any ERC-4337 library). No proprietary SDK required — Servo exposes standard `pm_*` and `eth_*` JSON-RPC methods.

## Addresses — Taiko Mainnet (Chain 167000)

|                         | Address                                          |
| ----------------------- | ------------------------------------------------ |
| **Servo RPC**           | `https://api-production-cdfe.up.railway.app/rpc` |
| **TaikoUsdcPaymaster**  | `0xca675148201e29b13a848ce30c3074c8de995891`     |
| **ServoAccountFactory** | `0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716`     |
| **EntryPoint v0.7**     | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`     |
| **USDC**                | `0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`     |
| **Taiko RPC**           | `https://rpc.mainnet.taiko.xyz`                  |

**This paymaster is currently not deployed on testnets, so it will only work on Taiko mainnet**

---

## Flow A: Cold Start — No Wallet Yet

The agent has a private key and USDC but no smart account. The account address is derived deterministically (CREATE2) and is usable _before_ deployment — USDC can be sent there immediately. The factory deploys it on the first UserOp.

### Step 1 — Derive the account address

Call the factory's `getAddress(owner, salt)` view function. This is a pure read — no transaction needed.

```typescript
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const owner = privateKeyToAccount("0x<agent-private-key>");
const publicClient = createPublicClient({
  transport: http("https://rpc.mainnet.taiko.xyz"),
});

const SERVO_RPC = "https://api-production-cdfe.up.railway.app/rpc";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const FACTORY = "0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716";
const USDC = "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b";

const factoryAbi = parseAbi([
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
]);

const accountAddress = await publicClient.readContract({
  address: FACTORY,
  abi: factoryAbi,
  functionName: "getAddress",
  args: [owner.address, 0n], // salt 0n = primary account
});
// This address is deterministic and permanent — fund it with USDC now
```

### Step 2 — Fund with USDC

Transfer USDC to the derived address. The account contract doesn't exist yet — that's fine. ERC-20 balances are stored in the USDC contract keyed by address, so the funds will be there when the account deploys.

### Step 3 — Prepare factory fields (first UserOp only)

For the first UserOp, pass `factory` and `factoryData` so the EntryPoint deploys the account. After the first UserOp, omit these fields (or set them to `undefined`).

```typescript
// First UserOp — include factory fields:
const factory = FACTORY;
const factoryData = encodeFunctionData({
  abi: factoryAbi,
  functionName: "createAccount",
  args: [owner.address, 0n],
});

// Subsequent UserOps — omit factory/factoryData entirely
```

### Step 4 — Encode your call

ServoAccount exposes `execute(address, uint256, bytes)` for single calls and `executeBatch(address[], uint256[], bytes[])` for atomic batches.

```typescript
const accountAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas)",
]);

// Single call to any contract:
const callData = encodeFunctionData({
  abi: accountAbi,
  functionName: "execute",
  args: ["0x<target-contract>", 0n, "0x<encoded-call>"],
});

// Batch (atomic, all-or-nothing):
const batchCallData = encodeFunctionData({
  abi: accountAbi,
  functionName: "executeBatch",
  args: [
    ["0x<token>", "0x<dex>"], // targets
    [0n, 0n], // values
    [approveCalldata, swapCalldata], // datas
  ],
});
```

### Step 5 — Fetch gas price guidance + paymaster quote (stub)

Taiko has very low gas prices (~0.02 gwei). Do NOT hardcode gas prices — fetch them from Servo.

Call `GET /capabilities` to get `gasPriceGuidance`, then use `suggestedMaxFeePerGas` and `suggestedMaxPriorityFeePerGas` when requesting a quote. This ensures the USDC ceiling reflects actual Taiko gas costs (typically < 0.10 USDC for a cold-start deployment) rather than an inflated guess (which can exceed 20 USDC at 10 gwei).

```typescript
// 5a — Fetch current gas prices from Servo
const capsResponse = await fetch("https://api-production-cdfe.up.railway.app/capabilities");
const caps = await capsResponse.json();
const gasGuidance = caps.gasPriceGuidance;
// gasGuidance.suggestedMaxFeePerGas     — e.g. "0x11a5536" (~0.02 gwei)
// gasGuidance.suggestedMaxPriorityFeePerGas — e.g. "0xf4240" (~0.001 gwei)
// gasGuidance.baseFeePerGas             — e.g. "0x85897b" (~0.009 gwei)

// 5b — Request a stub quote using the suggested gas prices
const stubResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "pm_getPaymasterStubData",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        factory, // v0.7 separate field
        factoryData, // v0.7 separate field
        callData,
        maxFeePerGas: gasGuidance.suggestedMaxFeePerGas,
        maxPriorityFeePerGas: gasGuidance.suggestedMaxPriorityFeePerGas,
        signature: "0x",
      },
      ENTRY_POINT,
      "taikoMainnet",
    ],
  }),
});
const stub = (await stubResponse.json()).result;
// stub.maxTokenCost = "0.050000" (human-readable USDC — realistic at correct gas price)
// stub.maxTokenCostMicros = "50000" (use this for permit signing)
// stub.validUntil = 1710000090 (unix timestamp — quote expires in ~90s)
// stub.gasPriceGuidance is also available here if you skip the capabilities call
```

### Step 6 — Sign USDC permit (ERC-2612)

The agent signs a permit authorizing the paymaster to pull USDC from the smart account. The `owner` in the permit is the **smart account address**, not the EOA — the EOA just provides the signature. The paymaster contract calls `isValidSignature()` (ERC-1271) on the smart account to verify.

```typescript
// Read the USDC permit nonce (0n for brand-new accounts)
const permitNonce = await publicClient.readContract({
  address: USDC,
  abi: parseAbi(["function nonces(address) view returns (uint256)"]),
  functionName: "nonces",
  args: [accountAddress],
});

const permitSignature = await owner.signTypedData({
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 167000,
    verifyingContract: USDC,
  },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: {
    owner: accountAddress, // smart account, NOT the EOA
    spender: stub.paymaster, // paymaster pulls USDC
    value: BigInt(stub.maxTokenCostMicros),
    nonce: permitNonce,
    deadline: BigInt(stub.validUntil),
  },
});
```

### Step 7 — Get final quote with permit

Use the same `maxFeePerGas` from Step 5 — the quote must be priced consistently.

```typescript
const finalResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "pm_getPaymasterData",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        factory,
        factoryData,
        callData,
        maxFeePerGas: gasGuidance.suggestedMaxFeePerGas,
        maxPriorityFeePerGas: gasGuidance.suggestedMaxPriorityFeePerGas,
        signature: "0x",
      },
      ENTRY_POINT,
      "taikoMainnet",
      {
        permit: {
          value: stub.maxTokenCostMicros,
          deadline: String(stub.validUntil),
          signature: permitSignature,
        },
      },
    ],
  }),
});
const quote = (await finalResponse.json()).result;
// quote.paymasterAndData — ready to include in UserOp
// quote.callGasLimit, verificationGasLimit, preVerificationGas — use these
```

### Step 8 — Sign and submit the UserOp

```typescript
import { getUserOperationHash } from "viem/account-abstraction";

// viem uses the v0.7 unpacked format for hash computation
const maxFeePerGas = BigInt(gasGuidance.suggestedMaxFeePerGas);
const maxPriorityFeePerGas = BigInt(gasGuidance.suggestedMaxPriorityFeePerGas);

const userOpHash = getUserOperationHash({
  userOperation: {
    sender: accountAddress,
    nonce: 0n,
    factory: FACTORY,
    factoryData,
    callData,
    callGasLimit: BigInt(quote.callGasLimit),
    verificationGasLimit: BigInt(quote.verificationGasLimit),
    preVerificationGas: BigInt(quote.preVerificationGas),
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster: quote.paymaster,
    paymasterData: quote.paymasterData,
    paymasterVerificationGasLimit: BigInt(quote.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(quote.paymasterPostOpGasLimit),
    signature: "0x",
  },
  entryPointAddress: ENTRY_POINT,
  entryPointVersion: "0.7",
  chainId: 167000,
});

const signature = await owner.signMessage({ message: { raw: userOpHash } });

// Submit — Servo accepts v0.7 fields (factory/factoryData, unpacked gas fields)
const sendResponse = await fetch(SERVO_RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "eth_sendUserOperation",
    params: [
      {
        sender: accountAddress,
        nonce: "0x0",
        factory,
        factoryData,
        callData,
        callGasLimit: quote.callGasLimit,
        verificationGasLimit: quote.verificationGasLimit,
        preVerificationGas: quote.preVerificationGas,
        maxFeePerGas: gasGuidance.suggestedMaxFeePerGas,
        maxPriorityFeePerGas: gasGuidance.suggestedMaxPriorityFeePerGas,
        paymasterAndData: quote.paymasterAndData,
        signature,
      },
      ENTRY_POINT,
    ],
  }),
});
const opHash = (await sendResponse.json()).result;
```

### Step 9 — Poll for receipt

```typescript
const checkReceipt = async (hash: string) => {
  const res = await fetch(SERVO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "eth_getUserOperationReceipt",
      params: [hash],
    }),
  });
  return (await res.json()).result; // null if pending, receipt if mined
};
```

---

## Flow B: Existing 4337 Account

If you already have a deployed 4337 account (ServoAccount, Safe, Kernel, etc.), skip Steps 1-3. Omit `factory`/`factoryData` and use your account's own `callData` encoding. The rest of the flow (Steps 5-9) is the same.

**For non-ServoAccount wallets**: encode `callData` using your account's native interface (e.g., Safe's `executeUserOp`, Kernel's `execute`). The paymaster doesn't care which account implementation you use.

**ERC-1271 requirement**: The USDC permit's `owner` is the smart account, but the EOA signs it. USDC calls `isValidSignature()` on the account to verify. ServoAccount, Safe, and Kernel all implement this — but verify your account does too.

---

## RPC Reference

All methods go to `POST https://api-production-cdfe.up.railway.app/rpc`

| Method                        | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `pm_getPaymasterStubData`     | Estimate gas + USDC cost (no permit needed)                             |
| `pm_getPaymasterData`         | Get signed paymaster fields (pass permit in 4th param `context.permit`) |
| `pm_supportedEntryPoints`     | List supported entry points                                             |
| `pm_getCapabilities`          | Supported chains, tokens, factory address, gas price guidance           |
| `eth_sendUserOperation`       | Submit signed UserOp to bundler                                         |
| `eth_getUserOperationReceipt` | Check if UserOp was included                                            |
| `eth_getUserOperationByHash`  | Lookup UserOp by hash                                                   |
| `eth_chainId`                 | Returns chain ID (hex)                                                  |

### Quote response shape

```json
{
  "paymaster": "0x...",
  "paymasterData": "0x...",
  "paymasterAndData": "0x...",
  "callGasLimit": "0x...",
  "verificationGasLimit": "0x...",
  "preVerificationGas": "0x...",
  "paymasterVerificationGasLimit": "0x...",
  "paymasterPostOpGasLimit": "0x...",
  "quoteId": "f1a2b3...",
  "token": "USDC",
  "tokenAddress": "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
  "maxTokenCost": "0.050000",
  "maxTokenCostMicros": "50000",
  "validUntil": 1710000090,
  "isStub": true,
  "gasPriceGuidance": {
    "baseFeePerGas": "0x85897b",
    "suggestedMaxFeePerGas": "0x11a5536",
    "suggestedMaxPriorityFeePerGas": "0xf4240",
    "fetchedAt": "2026-03-24T01:18:31.211Z"
  }
}
```

---

## Pitfalls — Read Before You Build

**Always fetch gas prices from Servo.** Taiko gas prices are ~0.02 gwei — 500× lower than Ethereum L1. Hardcoding even 1 gwei will inflate your USDC quote by 50×. Call `GET /capabilities` to read `gasPriceGuidance.suggestedMaxFeePerGas` and use it as your `maxFeePerGas`. The USDC ceiling is computed as `totalGas × maxFeePerGas × ETH/USD rate`, so an accurate gas price is essential for a reasonable quote.

**Use v0.7 field names.** Send `factory` and `factoryData` as separate fields — not the legacy packed `initCode`. Servo accepts both, but v0.7 separate fields are the ERC-4337 standard. For existing accounts (no deployment), simply omit `factory`/`factoryData`.

**Quote TTL is 90 seconds.** Get the quote, sign the permit, sign the UserOp, and submit — all within 90s. Don't hold quotes across long reasoning chains. If your agent is slow, separate "deciding what to do" from "executing the Servo flow" — decide first, then run steps 5-8 without pauses.

**Permit owner ≠ EOA.** The `owner` in the USDC permit is the **smart account** address, not the private key's EOA address. The EOA _signs_ the permit, but the permit says "the smart account authorizes the paymaster to pull its USDC." This is the #1 source of integration bugs.

**Stub → Final is two steps.** You must call `pm_getPaymasterStubData` first to learn the USDC cost, then sign a permit for that amount, then call `pm_getPaymasterData` with the permit. You can't skip the stub because you need the cost before you can sign the permit.

**USDC has 6 decimals.** `maxTokenCostMicros: "50000"` = 0.050 USDC. Use `maxTokenCostMicros` for permit signing, `maxTokenCost` for display.

**Counterfactual addresses are real.** You can send USDC to a derived address before the account exists on-chain. CREATE2 guarantees it always deploys to that address.

**Use the same maxFeePerGas in all calls.** The stub, final, and submission must use the same `maxFeePerGas`. The USDC quote is priced based on it, and the permit amount must cover the quoted cost. Changing the gas price between calls will cause the permit to be too small or too large.

**5% surcharge is included.** The `maxTokenCost` in the quote already includes the surcharge.

**No ETH needed anywhere.** Not for account creation, not for gas, not for anything. USDC covers deployment + execution + gas — all in one UserOp.
