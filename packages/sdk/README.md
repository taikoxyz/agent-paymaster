# @agent-paymaster/sdk

TypeScript SDK for Servo's ERC-4337 USDC gas-payment flow.

## Features

- `getCounterfactualAddress(owner, salt)` via ServoAccountFactory
- `buildInitCode(owner, salt)` for first-op account deployment
- `buildUserOp(...)` and `buildDummySignature()` for PackedUserOperation flows
- `signPermit(...)` for USDC EIP-2612 permit context
- `getUserOpHash(...)` + `signUserOp(...)`
- `createAndExecute(...)` end-to-end helper:
  - quote (`pm_getPaymasterData`)
  - permit signing
  - final quote with permit context
  - userOp hash + signature
  - submission (`eth_sendUserOperation`)

## Example

```ts
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ServoRpcClient, createAndExecute } from "@agent-paymaster/sdk";

const rpcClient = new ServoRpcClient({
  rpcUrl: "https://api-production-cdfe.up.railway.app/rpc",
});

const publicClient = createPublicClient({
  transport: http("https://rpc.mainnet.taiko.xyz"),
});

const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);

const result = await createAndExecute({
  rpcClient,
  publicClient,
  owner,
  entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",
  chain: "taikoMainnet",
  factoryAddress: "0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716",
  salt: 1n,
  nonce: 0n,
  calls: [
    {
      target: "0x0000000000000000000000000000000000000000", // replace
      value: 0n,
      data: "0x",
    },
  ],
  maxFeePerGas: 10_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
});

console.log(result.userOperationHash);
```
