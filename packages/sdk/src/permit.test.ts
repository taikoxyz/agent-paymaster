import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

import { buildPermitTypedData, signPermit } from "./permit.js";

describe("permit helpers", () => {
  it("builds EIP-2612 typed data with USDC defaults", () => {
    const typedData = buildPermitTypedData({
      owner: "0x1111111111111111111111111111111111111111",
      spender: "0x2222222222222222222222222222222222222222",
      value: 5_000_000n,
      nonce: 0n,
      deadline: 1_900_000_000n,
      tokenAddress: "0x07D83526730c7438048D55A4fC0b850E2Aab6f0B",
      chainId: 167013,
    });

    expect(typedData.domain.name).toBe("USD Coin");
    expect(typedData.domain.version).toBe("2");
    expect(typedData.domain.chainId).toBe(167013);
    expect(typedData.message.value).toBe(5_000_000n);
  });

  it("signs permit typed data and emits rpc context", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945386df7f5f0f6db9df9f8f9f7f5c5d6f7c1a",
    );

    const signed = await signPermit({
      account,
      owner: account.address,
      spender: "0x2222222222222222222222222222222222222222",
      value: 1_000_000n,
      nonce: 7n,
      deadline: 1_900_000_000n,
      tokenAddress: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
      chainId: 167000,
    });

    const recovered = await recoverTypedDataAddress({
      domain: signed.typedData.domain,
      types: signed.typedData.types,
      primaryType: signed.typedData.primaryType,
      message: signed.typedData.message,
      signature: signed.signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(signed.context.value).toBe("1000000");
    expect(signed.context.deadline).toBe("1900000000");
    expect(signed.context.signature).toMatch(/^0x[0-9a-f]+$/u);
  });
});
