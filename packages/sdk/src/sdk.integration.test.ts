import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ServoRpcClient } from "./client.js";
import { createAndExecute } from "./flow.js";

const runLive = process.env.RUN_HEKLA_INTEGRATION === "1";

const required = [
  "SDK_TEST_RPC_URL",
  "SDK_TEST_CHAIN_RPC_URL",
  "SDK_TEST_ENTRYPOINT",
  "SDK_TEST_FACTORY",
  "SDK_TEST_OWNER_PRIVATE_KEY",
  "SDK_TEST_CALL_TARGET",
  "SDK_TEST_CALL_DATA",
  "SDK_TEST_MAX_FEE_PER_GAS",
  "SDK_TEST_MAX_PRIORITY_FEE_PER_GAS",
  "SDK_TEST_CHAIN_ID",
] as const;

const missing = required.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0;
});

describe.runIf(runLive && missing.length === 0)("sdk integration (live)", () => {
  it("runs end-to-end cold-start submission", async () => {
    const rpcUrl = process.env.SDK_TEST_RPC_URL as string;
    const chainRpcUrl = process.env.SDK_TEST_CHAIN_RPC_URL as string;
    const entryPoint = process.env.SDK_TEST_ENTRYPOINT as `0x${string}`;
    const factoryAddress = process.env.SDK_TEST_FACTORY as `0x${string}`;
    const ownerPrivateKey = process.env.SDK_TEST_OWNER_PRIVATE_KEY as `0x${string}`;
    const callTarget = process.env.SDK_TEST_CALL_TARGET as `0x${string}`;
    const callData = process.env.SDK_TEST_CALL_DATA as `0x${string}`;
    const maxFeePerGas = BigInt(process.env.SDK_TEST_MAX_FEE_PER_GAS as string);
    const maxPriorityFeePerGas = BigInt(process.env.SDK_TEST_MAX_PRIORITY_FEE_PER_GAS as string);
    const chainId = Number.parseInt(process.env.SDK_TEST_CHAIN_ID as string, 10);

    const rpcClient = new ServoRpcClient({ rpcUrl });
    const publicClient = createPublicClient({ transport: http(chainRpcUrl) });
    const owner = privateKeyToAccount(ownerPrivateKey);

    const result = await createAndExecute({
      rpcClient,
      publicClient,
      owner,
      entryPoint,
      chain: chainId,
      factoryAddress,
      salt: 1n,
      nonce: 0n,
      calls: [{ target: callTarget, data: callData, value: 0n }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    expect(result.userOperationHash).toMatch(/^0x[0-9a-f]{64}$/u);
  }, 180_000);
});

describe("sdk integration (live)", () => {
  it("is skipped unless RUN_HEKLA_INTEGRATION=1 and required env vars are present", () => {
    if (runLive && missing.length > 0) {
      throw new Error(`Missing integration env vars: ${missing.join(", ")}`);
    }

    expect(true).toBe(true);
  });
});
