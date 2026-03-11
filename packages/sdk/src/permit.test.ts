import { describe, expect, it } from "vitest";

import { buildPermitTypedData, createPermitSignature } from "./permit.js";

describe("permit helpers", () => {
  it("builds EIP-2612 typed data with USDC defaults", () => {
    const typedData = buildPermitTypedData({
      owner: "0x1111111111111111111111111111111111111111",
      spender: "0x2222222222222222222222222222222222222222",
      value: 5_000_000n,
      nonce: 0,
      deadline: 1_900_000_000,
      tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
      chainId: 167013,
    });

    expect(typedData.domain.name).toBe("USD Coin");
    expect(typedData.domain.version).toBe("2");
    expect(typedData.domain.chainId).toBe(167013);
    expect(typedData.message.value).toBe("5000000");
  });

  it("creates permit signature and extracts v/r/s", async () => {
    const result = await createPermitSignature(
      {
        owner: "0x1111111111111111111111111111111111111111",
        spender: "0x2222222222222222222222222222222222222222",
        value: 1_000_000n,
        nonce: 7,
        deadline: 1_900_000_000,
        tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
        chainId: 167000,
      },
      async () =>
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
    );

    expect(result.v).toBe(27);
    expect(result.r).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.s).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
