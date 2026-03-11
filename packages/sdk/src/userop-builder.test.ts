import { describe, expect, it } from "vitest";

import { AgentPaymasterSdkError } from "./errors.js";
import { UserOperationBuilder, applyPaymasterData, buildUserOperation } from "./userop-builder.js";

describe("user operation builder", () => {
  it("builds a valid user operation with defaults", () => {
    const userOperation = buildUserOperation({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
    });

    expect(userOperation.initCode).toBe("0x");
    expect(userOperation.signature).toBe("0x");
  });

  it("applies paymaster data from quote payload", () => {
    const builder = new UserOperationBuilder({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
    })
      .withGasEstimate({
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        paymasterVerificationGasLimit: "0xea60",
        paymasterPostOpGasLimit: "0xafc8",
      })
      .withPaymasterQuote({
        paymasterAndData: "0x999999999999999999999999999999999999999900",
      });

    const built = builder.build();

    expect(built.callGasLimit).toBe("0x88d8");
    expect(built.paymasterAndData).toBe("0x999999999999999999999999999999999999999900");
  });

  it("constructs paymasterAndData from paymaster + paymasterData", () => {
    const userOperation = buildUserOperation({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
    });

    const patched = applyPaymasterData(userOperation, {
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterData: "0xabcd",
    });

    expect(patched.paymasterAndData).toBe("0x9999999999999999999999999999999999999999abcd");
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
});
