import { describe, expect, it } from "vitest";

import { AgentPaymasterSdkError } from "./errors.js";
import { buildDummySignature, buildUserOp, packUserOperation } from "./userop.js";

describe("userop helpers", () => {
  it("builds userop and defaults signature to dummy", () => {
    const userOp = buildUserOp({
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
    });

    expect(userOp.signature).toBe(buildDummySignature());
    expect(userOp.initCode).toBe("0x");
  });

  it("rejects empty signature", () => {
    expect(() =>
      buildUserOp({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
        signature: "0x",
      }),
    ).toThrow(AgentPaymasterSdkError);
  });

  it("packs a userop into entrypoint packed format", () => {
    const packed = packUserOperation(
      buildUserOp({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        initCode: "0x",
        callData: "0x1234",
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
        paymasterAndData: "0x",
        signature:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
      }),
    );

    expect(packed.accountGasLimits).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(packed.gasFees).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(packed.preVerificationGas).toBe(0x5274n);
  });
});
