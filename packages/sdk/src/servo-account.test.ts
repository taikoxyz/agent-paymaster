import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";

import {
  buildInitCode,
  buildServoCallData,
  buildServoExecuteBatchCallData,
  buildServoExecuteCallData,
  getCounterfactualAddress,
  SERVO_ACCOUNT_ABI,
} from "./servo-account.js";

describe("servo account helpers", () => {
  it("builds initCode for factory createAccount", () => {
    const initCode = buildInitCode({
      factoryAddress: "0x9999999999999999999999999999999999999999",
      owner: "0x1111111111111111111111111111111111111111",
      salt: 123n,
    });

    expect(initCode.startsWith("0x9999999999999999999999999999999999999999")).toBe(true);
    expect(initCode.length).toBeGreaterThan(42);
  });

  it("derives counterfactual address via factory getAddress", async () => {
    const readContract = vi.fn(async () => "0x3333333333333333333333333333333333333333");

    const address = await getCounterfactualAddress({
      publicClient: { readContract } as unknown as Parameters<
        typeof getCounterfactualAddress
      >[0]["publicClient"],
      factoryAddress: "0x9999999999999999999999999999999999999999",
      owner: "0x1111111111111111111111111111111111111111",
      salt: 123n,
    });

    expect(address).toBe("0x3333333333333333333333333333333333333333");
    expect(readContract).toHaveBeenCalledOnce();
  });

  it("builds execute calldata for single call", () => {
    const callData = buildServoExecuteCallData({
      target: "0x2222222222222222222222222222222222222222",
      value: 5n,
      data: "0x1234",
    });

    const decoded = decodeFunctionData({
      abi: SERVO_ACCOUNT_ABI,
      data: callData,
    });

    expect(decoded.functionName).toBe("execute");
  });

  it("builds executeBatch calldata for multiple calls", () => {
    const callData = buildServoExecuteBatchCallData([
      {
        target: "0x2222222222222222222222222222222222222222",
        value: 1n,
        data: "0x12",
      },
      {
        target: "0x3333333333333333333333333333333333333333",
        value: 0n,
        data: "0x34",
      },
    ]);

    const decoded = decodeFunctionData({
      abi: SERVO_ACCOUNT_ABI,
      data: callData,
    });

    expect(decoded.functionName).toBe("executeBatch");
    expect(Array.isArray(decoded.args?.[0])).toBe(true);
  });

  it("routes buildServoCallData to execute or executeBatch", () => {
    const single = buildServoCallData([
      {
        target: "0x2222222222222222222222222222222222222222",
        value: 0n,
        data: "0x12",
      },
    ]);

    const batch = buildServoCallData([
      {
        target: "0x2222222222222222222222222222222222222222",
        value: 0n,
        data: "0x12",
      },
      {
        target: "0x3333333333333333333333333333333333333333",
        value: 0n,
        data: "0x34",
      },
    ]);

    const singleDecoded = decodeFunctionData({ abi: SERVO_ACCOUNT_ABI, data: single });
    const batchDecoded = decodeFunctionData({ abi: SERVO_ACCOUNT_ABI, data: batch });

    expect(singleDecoded.functionName).toBe("execute");
    expect(batchDecoded.functionName).toBe("executeBatch");
  });
});
