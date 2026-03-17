import { describe, expect, it } from "vitest";

import { EntryPointMonitor } from "./entrypoint-monitor.js";

const PAYMASTER_ADDRESS = "0xCa675148201E29b13A848cE30c3074c8dE995891";
const DEPOSITS_SELECTOR = "0xfc7e286d";

const createMockFetch = (balanceHex: string) =>
  (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", result: balanceHex }), {
      status: 200,
    })) as unknown as typeof fetch;

const createErrorFetch = (error: { code: number; message: string }) =>
  (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", error }), {
      status: 200,
    })) as unknown as typeof fetch;

describe("EntryPointMonitor", () => {
  it("returns ok when balance is above low threshold", async () => {
    // 0.01 ETH
    const balanceHex = "0x" + 10_000_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createMockFetch(balanceHex),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("ok");
    expect(result.balanceWei).toBe("10000000000000000");
  });

  it("returns low when balance is below low threshold", async () => {
    // 0.001 ETH — below default 0.002 low threshold, above 0.0005 critical
    const balanceHex = "0x" + 1_000_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createMockFetch(balanceHex),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("low");
  });

  it("returns critical when balance is below critical threshold", async () => {
    // 0.0001 ETH — below default 0.0005 critical threshold
    const balanceHex = "0x" + 100_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createMockFetch(balanceHex),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("critical");
  });

  it("returns critical when balance is zero", async () => {
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createMockFetch("0x" + "0".repeat(64)),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("critical");
  });

  it("returns unknown on RPC error", async () => {
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createErrorFetch({ code: -32000, message: "execution reverted" }),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("unknown");
    expect(result.error).toBe("execution reverted");
  });

  it("returns unknown on network failure", async () => {
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("unknown");
    expect(result.error).toBe("fetch failed");
  });

  it("returns unknown on non-200 HTTP response", async () => {
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("unknown");
    expect(result.error).toBe("HTTP 502");
  });

  it("respects custom thresholds", async () => {
    // 0.05 ETH — above default thresholds but below custom low threshold of 0.1 ETH
    const balanceHex = "0x" + 50_000_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      lowThresholdWei: 100_000_000_000_000_000n, // 0.1 ETH
      criticalThresholdWei: 10_000_000_000_000_000n, // 0.01 ETH
      fetchImpl: createMockFetch(balanceHex),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("low");
  });

  it("encodes paymaster address correctly in calldata", async () => {
    let capturedBody: string | undefined;
    const mockFetch = (async (_url: string, init: { body: string }) => {
      capturedBody = init.body;
      const balanceHex = "0x" + 10_000_000_000_000_000n.toString(16).padStart(64, "0");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", result: balanceHex }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: mockFetch,
    });

    await monitor.checkDeposit();

    const parsed = JSON.parse(capturedBody!);
    const calldata = parsed.params[0].data as string;
    expect(calldata).toMatch(new RegExp(`^${DEPOSITS_SELECTOR}`));
    expect(calldata.toLowerCase()).toContain(PAYMASTER_ADDRESS.slice(2).toLowerCase());
  });

  it("reads deposit balance from deposits(address) tuple response", async () => {
    const depositWei = 1_200_000_000_000_000n;
    const tupleResult = `0x${depositWei.toString(16).padStart(64, "0")}${"0".repeat(64 * 4)}`;
    const monitor = new EntryPointMonitor({
      paymasterAddress: PAYMASTER_ADDRESS,
      fetchImpl: createMockFetch(tupleResult),
    });

    const result = await monitor.checkDeposit();
    expect(result.status).toBe("low");
    expect(result.balanceWei).toBe(depositWei.toString());
  });
});
