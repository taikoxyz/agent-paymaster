import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { ServoClient } from "./client.js";
import { createAndExecute } from "./flow.js";

describe("createAndExecute", () => {
  it("orchestrates quote -> permit -> sign -> submit", async () => {
    const rpcMethods: string[] = [];

    const client = new ServoClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as {
          method: string;
          id: number;
          params: unknown[];
        };

        rpcMethods.push(payload.method);

        if (
          payload.method === "pm_getPaymasterStubData" ||
          payload.method === "pm_getPaymasterData"
        ) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                paymaster: "0x9999999999999999999999999999999999999999",
                paymasterData: "0x12",
                paymasterAndData: "0x999999999999999999999999999999999999999912",
                callGasLimit: "0x88d8",
                verificationGasLimit: "0x1d4c8",
                preVerificationGas: "0x5274",
                paymasterVerificationGasLimit: "0xea60",
                paymasterPostOpGasLimit: "0xafc8",
                quoteId: "quote-1",
                token: "USDC",
                tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
                maxTokenCost: "1.000000",
                maxTokenCostMicros: "1000000",
                validUntil: 1900000000,
                isStub: false,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (payload.method === "eth_sendUserOperation") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: `0x${"ab".repeat(32)}`,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected rpc method: ${payload.method}`);
      },
    });

    const publicClient = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "getAddress") {
          return "0x3333333333333333333333333333333333333333";
        }

        if (functionName === "nonces") {
          return 7n;
        }

        throw new Error(`Unexpected function: ${functionName}`);
      }),
    };

    const owner = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945386df7f5f0f6db9df9f8f9f7f5c5d6f7c1a",
    );

    const result = await createAndExecute({
      client,
      publicClient: publicClient as unknown as Parameters<
        typeof createAndExecute
      >[0]["publicClient"],
      owner,
      entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      chain: "taikoMainnet",
      factoryAddress: "0x9999999999999999999999999999999999999999",
      salt: 123n,
      nonce: 0n,
      calls: [
        {
          target: "0x4444444444444444444444444444444444444444",
          value: 0n,
          data: "0x1234",
        },
      ],
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    expect(rpcMethods).toEqual([
      "pm_getPaymasterStubData",
      "pm_getPaymasterData",
      "eth_sendUserOperation",
    ]);
    expect(result.counterfactualAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(result.userOperationHash).toBe(`0x${"ab".repeat(32)}`);
    expect(result.permit.value).toBe("1000000");
  });
});
