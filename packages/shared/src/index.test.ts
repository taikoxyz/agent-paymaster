import { describe, expect, it } from "vitest";

import {
  buildHealth,
  computeServoPaymasterSigningHash,
  encodeServoErc20PaymasterConfig,
  normalizePaymasterAndData,
  packPaymasterAndData,
  SERVO_ERC20_PAYMASTER_DATA_NO_SIG_LENGTH,
} from "./index.js";

describe("buildHealth", () => {
  it("returns an ok status for a service", () => {
    const result = buildHealth("api");

    expect(result.service).toBe("api");
    expect(result.status).toBe("ok");
    expect(Date.parse(result.timestamp)).not.toBeNaN();
  });

  it("packs paymasterAndData with the gas prefixes required on-chain", () => {
    const packed = packPaymasterAndData({
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
      paymasterData: "0xabcd",
    });

    expect(packed.slice(0, 42)).toBe("0x9999999999999999999999999999999999999999");
    expect(packed.slice(42, 74)).toBe("0000000000000000000000000000ea60");
    expect(packed.slice(74, 106)).toBe("0000000000000000000000000000afc8");
    expect(packed.endsWith("abcd")).toBe(true);
  });

  it("normalizes legacy paymasterAndData into the packed on-chain form", () => {
    const normalized = normalizePaymasterAndData({
      paymasterAndData: "0x9999999999999999999999999999999999999999abcd",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
    });

    expect(normalized.inputFormat).toBe("legacy");
    expect(normalized.paymasterData).toBe("0xabcd");
    expect(normalized.paymasterAndData.slice(42, 74)).toBe("0000000000000000000000000000ea60");
    expect(normalized.paymasterAndData.slice(74, 106)).toBe("0000000000000000000000000000afc8");
  });

  it("reads gas limits back out of packed paymasterAndData", () => {
    const packed = packPaymasterAndData({
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
      paymasterData: "0xabcd",
    });

    const normalized = normalizePaymasterAndData({
      paymasterAndData: packed,
    });

    expect(normalized.inputFormat).toBe("packed");
    expect(normalized.paymasterVerificationGasLimit).toBe(0xea60n);
    expect(normalized.paymasterPostOpGasLimit).toBe(0xafc8n);
    expect(normalized.paymasterData).toBe("0xabcd");
  });
});

describe("encodeServoErc20PaymasterConfig", () => {
  const baseCfg = {
    validUntil: 0x123456,
    validAfter: 0x100000,
    token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
    postOpGas: 0x9c40n,
    exchangeRate: 0x77359400n,
    paymasterValidationGasLimit: 0x186a0n,
    treasury: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
  };

  it("produces exactly 118 bytes (mode + flags + fixed 116-byte body)", () => {
    const encoded = encodeServoErc20PaymasterConfig(baseCfg);
    const byteLength = (encoded.length - 2) / 2;
    expect(byteLength).toBe(SERVO_ERC20_PAYMASTER_DATA_NO_SIG_LENGTH);
  });

  it("packs fields in the order Pimlico's _parseErc20Config expects", () => {
    const encoded = encodeServoErc20PaymasterConfig(baseCfg);
    const body = encoded.slice(2);

    // Byte 0: modeByte = (1 << 1) | 1 = 0x03 (ERC20 mode, allowAllBundlers=true)
    expect(body.slice(0, 2)).toBe("03");
    // Byte 1: flags = 0x00 (no prefund, no recipient, no constantFee)
    expect(body.slice(2, 4)).toBe("00");
    // Bytes 2..8: validUntil (6 bytes = 12 hex chars) = 0x000000123456
    expect(body.slice(4, 16)).toBe("000000123456");
    // Bytes 8..14: validAfter = 0x000000100000
    expect(body.slice(16, 28)).toBe("000000100000");
    // Bytes 14..34: token (20 bytes)
    expect(body.slice(28, 68)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    // Bytes 34..50: postOpGas (16 bytes) = 0x9c40
    expect(body.slice(68, 100)).toBe("00000000000000000000000000009c40");
    // Bytes 50..82: exchangeRate (32 bytes)
    expect(body.slice(100, 164)).toBe(
      "0000000000000000000000000000000000000000000000000000000077359400",
    );
    // Bytes 82..98: paymasterValidationGasLimit (16 bytes) = 0x186a0
    expect(body.slice(164, 196)).toBe("000000000000000000000000000186a0");
    // Bytes 98..118: treasury (20 bytes)
    expect(body.slice(196, 236)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("sets allowAllBundlers=false via the mode byte when requested", () => {
    const encoded = encodeServoErc20PaymasterConfig({ ...baseCfg, allowAllBundlers: false });
    // (1 << 1) | 0 = 0x02
    expect(encoded.slice(2, 4)).toBe("02");
  });

  it("rejects a zero exchange rate", () => {
    expect(() => encodeServoErc20PaymasterConfig({ ...baseCfg, exchangeRate: 0n })).toThrow();
  });
});

describe("computeServoPaymasterSigningHash", () => {
  it("produces a 32-byte keccak hash and changes with each field", () => {
    const input = {
      userOp: {
        sender: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        nonce: 7n,
        initCode: "0x" as `0x${string}`,
        callData: "0xdeadbeef" as `0x${string}`,
        accountGasLimits: ("0x" +
          "00".repeat(16) +
          "0000000000000000000000000001e240") as `0x${string}`,
        preVerificationGas: 30_000n,
        gasFees: ("0x" + "00".repeat(16) + "0000000000000000000000000000000a") as `0x${string}`,
      },
      paymasterAndDataNoSig: ("0x" + "cc".repeat(170)) as `0x${string}`,
      chainId: 167000,
    };

    const hash = computeServoPaymasterSigningHash(input);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

    const mutated = computeServoPaymasterSigningHash({
      ...input,
      userOp: { ...input.userOp, nonce: 8n },
    });
    expect(mutated).not.toBe(hash);
  });
});
