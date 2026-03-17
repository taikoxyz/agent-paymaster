import { describe, expect, it, vi } from "vitest";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getUserOpHash, signUserOp } from "./sign-userop.js";
import { buildUserOp } from "./userop.js";

describe("userop signing", () => {
  it("reads userOpHash from entrypoint", async () => {
    const readContract = vi.fn(async () => `0x${"ab".repeat(32)}` as const);

    const hash = await getUserOpHash({
      publicClient: { readContract } as unknown as Parameters<
        typeof getUserOpHash
      >[0]["publicClient"],
      entryPoint: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      userOperation: buildUserOp({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        callData: "0x1234",
        initCode: "0x",
        callGasLimit: "0x88d8",
        verificationGasLimit: "0x1d4c8",
        preVerificationGas: "0x5274",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
      }),
    });

    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(readContract).toHaveBeenCalledOnce();
  });

  it("signs userOpHash as EIP-191 message", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945386df7f5f0f6db9df9f8f9f7f5c5d6f7c1a",
    );

    const userOpHash = `0x${"12".repeat(32)}` as const;

    const signature = await signUserOp({ account, userOpHash });

    const recovered = await recoverMessageAddress({
      message: { raw: userOpHash },
      signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
