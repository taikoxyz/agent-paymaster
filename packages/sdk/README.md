# @agent-paymaster/sdk

TypeScript client for the Agent Paymaster unified RPC + quote APIs.

## Install

```bash
pnpm add @agent-paymaster/sdk
```

## Quick start

```ts
import {
  AgentPaymasterClient,
  UserOperationBuilder,
  createPermitSignature,
} from "@agent-paymaster/sdk";

const client = new AgentPaymasterClient({
  apiUrl: "https://your-paymaster-gateway.example",
});

const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032";

const userOp = new UserOperationBuilder({
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
})
  .withSignature("0x")
  .build();

const gas = await client.ethEstimateUserOperationGas(userOp, entryPoint);

const quote = await client.getUsdcQuote({
  chain: "taikoHoodi",
  entryPoint,
  token: "USDC",
  userOperation: {
    ...userOp,
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
  },
});

const finalUserOp = new UserOperationBuilder({
  ...userOp,
  callGasLimit: gas.callGasLimit,
  verificationGasLimit: gas.verificationGasLimit,
  preVerificationGas: gas.preVerificationGas,
})
  .withPaymasterQuote(quote)
  .build();

const userOpHash = await client.ethSendUserOperation(finalUserOp, entryPoint);

const permit = await createPermitSignature(
  {
    owner: finalUserOp.sender,
    spender: quote.paymaster,
    tokenAddress: quote.tokenAddress,
    chainId: quote.chainId,
    value: BigInt(quote.maxTokenCostMicros),
    nonce: 0,
    deadline: quote.validUntil,
  },
  async (typedData) => {
    // Use your wallet implementation to sign EIP-712 typed data.
    return signTypedData(typedData);
  },
);

console.log({ userOpHash, permit });
```

## Features

- Typed wrappers for:
  - `eth_sendUserOperation`
  - `eth_estimateUserOperationGas`
  - `pm_getPaymasterData`
  - `pm_getPaymasterStubData`
- Quote helper for `POST /v1/paymaster/quote`
- EIP-2612 USDC permit typed-data + signature parsing helpers
- UserOperation builder utilities for paymaster integration
- Typed transport, JSON-RPC, and rate-limit error classes
