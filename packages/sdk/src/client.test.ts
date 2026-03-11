import { describe, expect, it } from "vitest";

import { AgentPaymasterClient } from "./client.js";
import type { JsonRpcRequestError, RateLimitError } from "./errors.js";
import type { UserOperation } from "./types.js";

const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";

const SAMPLE_USER_OPERATION: UserOperation = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x",
};

const makeResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

describe("AgentPaymasterClient", () => {
  it("sends eth_estimateUserOperationGas and returns typed result", async () => {
    const calls: unknown[] = [];

    const client = new AgentPaymasterClient({
      apiUrl: "http://localhost:3000",
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

    const result = await client.ethEstimateUserOperationGas(SAMPLE_USER_OPERATION, ENTRY_POINT);

    expect(result.callGasLimit).toBe("0x88d8");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "eth_estimateUserOperationGas",
      params: [SAMPLE_USER_OPERATION, ENTRY_POINT],
    });
  });

  it("maps json-rpc error responses to JsonRpcRequestError", async () => {
    const client = new AgentPaymasterClient({
      apiUrl: "http://localhost:3000",
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

    await expect(client.ethSendUserOperation(SAMPLE_USER_OPERATION, ENTRY_POINT)).rejects.toMatchObject<
      Partial<JsonRpcRequestError>
    >({
      name: "JsonRpcRequestError",
      rpcCode: -32602,
      message: "Missing required positional params",
      status: 400,
    });
  });

  it("returns paymaster quote from REST endpoint", async () => {
    const client = new AgentPaymasterClient({
      apiUrl: "http://localhost:3000",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/paymaster/quote")) {
          return makeResponse({
            quoteId: "abc123",
            chain: "taikoMainnet",
            chainId: 167000,
            token: "USDC",
            paymaster: "0x9999999999999999999999999999999999999999",
            paymasterData: "0x12",
            paymasterAndData: "0x999999999999999999999999999999999999999912",
            paymasterVerificationGasLimit: "0xea60",
            paymasterPostOpGasLimit: "0xafc8",
            estimatedGasLimit: "0x123456",
            estimatedGasWei: "0x1",
            maxTokenCostMicros: "100",
            maxTokenCost: "0.000100",
            validUntil: 1_900_000_000,
            entryPoint: ENTRY_POINT,
            sender: SAMPLE_USER_OPERATION.sender,
            tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
            supportedTokens: ["USDC"],
          });
        }

        return makeResponse({ jsonrpc: "2.0", id: 1, result: null });
      },
    });

    const quote = await client.getUsdcQuote({
      entryPoint: ENTRY_POINT,
      userOperation: SAMPLE_USER_OPERATION,
      chain: "taikoMainnet",
      token: "USDC",
    });

    expect(quote.quoteId).toBe("abc123");
    expect(quote.supportedTokens).toContain("USDC");
  });

  it("maps rate-limited quote responses to RateLimitError", async () => {
    const client = new AgentPaymasterClient({
      apiUrl: "http://localhost:3000",
      fetchImpl: async () =>
        makeResponse(
          {
            error: {
              code: "rate_limit_exceeded",
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
      client.getUsdcQuote({
        entryPoint: ENTRY_POINT,
        userOperation: SAMPLE_USER_OPERATION,
      }),
    ).rejects.toMatchObject<Partial<RateLimitError>>({
      name: "RateLimitError",
      status: 429,
      limit: 1,
      resetAt: 999,
    });
  });
});
