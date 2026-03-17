import { describe, expect, it } from "vitest";

import { ServoRpcClient } from "./client.js";
import type { AgentPaymasterSdkError, JsonRpcRequestError, RateLimitError } from "./errors.js";
import type { UserOperation } from "./types.js";

const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";

const SAMPLE_USER_OPERATION: UserOperation = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
};

const makeResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

describe("ServoRpcClient", () => {
  it("sends eth_estimateUserOperationGas and returns typed result", async () => {
    const calls: unknown[] = [];

    const client = new ServoRpcClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)) as unknown);

        return makeResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            callGasLimit: "0x88d8",
            verificationGasLimit: "0x1d4c8",
            preVerificationGas: "0x5274",
            paymasterVerificationGasLimit: "0xea60",
            paymasterPostOpGasLimit: "0xafc8",
          },
        });
      },
    });

    const result = await client.estimateUserOperationGas(SAMPLE_USER_OPERATION, ENTRY_POINT);

    expect(result.callGasLimit).toBe("0x88d8");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "eth_estimateUserOperationGas",
      params: [SAMPLE_USER_OPERATION, ENTRY_POINT],
    });
  });

  it("sends pm_getPaymasterData with permit context", async () => {
    const calls: unknown[] = [];

    const client = new ServoRpcClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)) as unknown);

        return makeResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            paymaster: "0x9999999999999999999999999999999999999999",
            paymasterData: "0x12",
            paymasterAndData: "0x999999999999999999999999999999999999999912",
            callGasLimit: "0x1",
            verificationGasLimit: "0x2",
            preVerificationGas: "0x3",
            paymasterVerificationGasLimit: "0x4",
            paymasterPostOpGasLimit: "0x5",
            quoteId: "abc123",
            token: "USDC",
            tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
            maxTokenCost: "1.000000",
            maxTokenCostMicros: "1000000",
            validUntil: 1_900_000_000,
            isStub: false,
          },
        });
      },
    });

    const result = await client.getPaymasterData(
      SAMPLE_USER_OPERATION,
      ENTRY_POINT,
      "taikoMainnet",
      {
        permit: {
          value: "1000000",
          deadline: "1900000000",
          signature:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
        },
      },
    );

    expect(result.quoteId).toBe("abc123");
    expect(calls[0]).toMatchObject({
      method: "pm_getPaymasterData",
      params: [
        SAMPLE_USER_OPERATION,
        ENTRY_POINT,
        "taikoMainnet",
        {
          permit: {
            value: "1000000",
            deadline: "1900000000",
          },
        },
      ],
    });
  });

  it("maps json-rpc error responses to JsonRpcRequestError", async () => {
    const client = new ServoRpcClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async () =>
        makeResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32602,
              message: "Missing required positional params",
              data: {
                reason: "params_missing",
              },
            },
          },
          400,
        ),
    });

    await expect(
      client.sendUserOperation(SAMPLE_USER_OPERATION, ENTRY_POINT),
    ).rejects.toMatchObject<Partial<JsonRpcRequestError>>({
      name: "JsonRpcRequestError",
      rpcCode: -32602,
      message: "Missing required positional params",
      status: 400,
    });
  });

  it("maps rate-limited responses to RateLimitError", async () => {
    const client = new ServoRpcClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async () =>
        makeResponse(
          {
            error: {
              message: "Rate limit exceeded",
              limit: 1,
              resetAt: 999,
            },
          },
          429,
          {
            "X-RateLimit-Limit": "1",
            "X-RateLimit-Reset": "999",
          },
        ),
    });

    await expect(
      client.sendUserOperation(SAMPLE_USER_OPERATION, ENTRY_POINT),
    ).rejects.toMatchObject<Partial<RateLimitError>>({
      name: "RateLimitError",
      status: 429,
      limit: 1,
      resetAt: 999,
    });
  });

  it("rejects invalid JSON-RPC payloads", async () => {
    const client = new ServoRpcClient({
      rpcUrl: "http://localhost:3000/rpc",
      fetchImpl: async () =>
        makeResponse({
          foo: "bar",
        }),
    });

    await expect(client.supportedEntryPoints()).rejects.toMatchObject<
      Partial<AgentPaymasterSdkError>
    >({
      name: "AgentPaymasterSdkError",
      code: "invalid_response",
    });
  });
});
