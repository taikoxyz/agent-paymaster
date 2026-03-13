import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";

import { AgentPaymasterSdkError } from "./errors.js";
import { UserOperationBuilder, applyPaymasterData, buildUserOperation } from "./userop-builder.js";

const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "token", type: "address" },
      { name: "exchangeRate", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "postOpOverheadGas", type: "uint32" },
      { name: "surchargeBps", type: "uint16" },
    ],
  },
  {
    type: "bytes",
    name: "quoteSignature",
  },
  {
    type: "tuple",
    name: "permit",
    components: [
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

describe("user operation builder", () => {
  it("builds a valid user operation", () => {
    const userOperation = buildUserOperation({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
      signature:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    });

    expect(userOperation.initCode).toBe("0x");
    expect(userOperation.signature).toMatch(/^0x[0-9a-f]+$/u);
  });

  it("throws when signature is missing", () => {
    expect(() =>
      buildUserOperation({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
      }),
    ).toThrowError(AgentPaymasterSdkError);
  });

  it("throws when signature is empty", () => {
    expect(() =>
      buildUserOperation({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
        signature: "0x",
      }),
    ).toThrowError(AgentPaymasterSdkError);
  });

  it("applies paymaster data from quote payload", () => {
    const builder = new UserOperationBuilder({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
      signature:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    })
      .withGasEstimate({
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        paymasterVerificationGasLimit: "0xea60",
        paymasterPostOpGasLimit: "0xafc8",
      })
      .withPaymasterQuote({
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        paymasterVerificationGasLimit: "0xea60",
        paymasterPostOpGasLimit: "0xafc8",
        quoteId: "abc123",
        token: "USDC",
        tokenAddress: "0x9999999999999999999999999999999999999999",
        maxTokenCost: "0.000100",
        maxTokenCostMicros: "100",
        validUntil: 1_900_000_000,
        isStub: false,
        paymaster: "0x9999999999999999999999999999999999999999",
        paymasterData: "0x00",
        paymasterAndData: "0x999999999999999999999999999999999999999900",
      });

    const built = builder.build();

    expect(built.callGasLimit).toBe("0x88d8");
    expect(built.paymasterVerificationGasLimit).toBe("0xea60");
    expect(built.paymasterPostOpGasLimit).toBe("0xafc8");
    expect(built.paymasterAndData).toBe("0x999999999999999999999999999999999999999900");
  });

  it("constructs paymasterAndData from paymaster + paymasterData", () => {
    const userOperation = buildUserOperation({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
      signature:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    });

    const patched = applyPaymasterData(userOperation, {
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterData: "0xabcd",
    });

    expect(patched.paymasterAndData).toBe("0x9999999999999999999999999999999999999999abcd");
  });

  it("bundles a permit into paymaster quote data", () => {
    const paymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
      {
        token: "0x9999999999999999999999999999999999999999",
        exchangeRate: 1_000_000n,
        maxTokenCost: 100n,
        validAfter: 1,
        validUntil: 2,
        postOpOverheadGas: 45_000,
        surchargeBps: 500,
      },
      "0x1234",
      {
        value: 0n,
        deadline: 0n,
        signature: "0x",
      },
    ]);

    const builder = new UserOperationBuilder({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
      signature:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    }).withPaymasterQuoteAndPermit(
      {
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        paymasterVerificationGasLimit: "0xea60",
        paymasterPostOpGasLimit: "0xafc8",
        quoteId: "abc123",
        token: "USDC",
        tokenAddress: "0x9999999999999999999999999999999999999999",
        maxTokenCost: "0.000100",
        maxTokenCostMicros: "100",
        validUntil: 1_900_000_000,
        isStub: false,
        paymaster: "0x9999999999999999999999999999999999999999",
        paymasterData,
        paymasterAndData: `0x9999999999999999999999999999999999999999${paymasterData.slice(2)}`,
      },
      {
        value: 150n,
        deadline: 1_900_000_000n,
        signature: "0x123456",
      },
    );

    const built = builder.build();

    expect(built.paymasterAndData).not.toBe(
      `0x9999999999999999999999999999999999999999${paymasterData.slice(2)}`,
    );
    expect(built.paymasterAndData).toContain("123456");
  });

  it("throws on invalid sender", () => {
    expect(() =>
      buildUserOperation({
        sender: "0x1" as `0x${string}`,
        nonce: "0x1",
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
      }),
    ).toThrowError(AgentPaymasterSdkError);
  });

  it("preserves address checksum casing", () => {
    const userOperation = buildUserOperation({
      sender: "0x07D83526730c7438048D55A4fC0b850E2Aab6f0B",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
      signature:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    });

    expect(userOperation.sender).toBe("0x07D83526730c7438048D55A4fC0b850E2Aab6f0B");
  });
});
