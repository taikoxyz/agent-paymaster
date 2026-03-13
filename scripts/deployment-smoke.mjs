#!/usr/bin/env node

const apiBaseUrl = process.env.SMOKE_API_BASE_URL?.replace(/\/+$/u, "");
const webUrl = process.env.SMOKE_WEB_URL?.replace(/\/+$/u, "");

if (!apiBaseUrl && !webUrl) {
  console.error("At least one of SMOKE_API_BASE_URL or SMOKE_WEB_URL is required");
  process.exit(1);
}

const entryPoint =
  process.env.SMOKE_ENTRYPOINT_ADDRESS ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const quoteChain = process.env.SMOKE_QUOTE_CHAIN ?? "taikoMainnet";
const expectedWebTitle = process.env.SMOKE_WEB_TITLE ?? "Servo";

const sampleUserOperation = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x99",
};

const assertOk = async (response, label) => {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed with ${response.status}: ${text}`);
  }

  return response;
};

const readJson = async (response, label) => {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const main = async () => {
  if (apiBaseUrl) {
    const healthResponse = await assertOk(await fetch(`${apiBaseUrl}/health`), "GET /health");
    const health = await readJson(healthResponse, "GET /health");

    assert(health.status === "ok", `API health status is ${health.status}`);
    assert(
      health.dependencies?.bundler?.status === "ok",
      `Bundler dependency status is ${health.dependencies?.bundler?.status ?? "<missing>"}`,
    );

    const statusResponse = await assertOk(await fetch(`${apiBaseUrl}/status`), "GET /status");
    const status = await readJson(statusResponse, "GET /status");

    assert(status.status === "ready", `API status is ${status.status}`);
    assert(
      status.dependencies?.bundler?.status === "ok",
      `Bundler status in /status is ${status.dependencies?.bundler?.status ?? "<missing>"}`,
    );

    const rpcResponse = await assertOk(
      await fetch(`${apiBaseUrl}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_supportedEntryPoints",
          params: [],
        }),
      }),
      "POST /rpc",
    );
    const rpcPayload = await readJson(rpcResponse, "POST /rpc");

    assert(Array.isArray(rpcPayload.result), "eth_supportedEntryPoints did not return an array");
    assert(
      rpcPayload.result.some(
        (value) => typeof value === "string" && value.toLowerCase() === entryPoint.toLowerCase(),
      ),
      `eth_supportedEntryPoints does not include ${entryPoint}`,
    );

    const quoteResponse = await assertOk(
      await fetch(`${apiBaseUrl}/v1/paymaster/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chain: quoteChain,
          entryPoint,
          token: "USDC",
          userOperation: sampleUserOperation,
        }),
      }),
      "POST /v1/paymaster/quote",
    );
    const quote = await readJson(quoteResponse, "POST /v1/paymaster/quote");

    assert(typeof quote.quoteId === "string" && quote.quoteId.length > 0, "quoteId is missing");
    assert(
      typeof quote.paymaster === "string" && /^0x[a-fA-F0-9]{40}$/.test(quote.paymaster),
      "paymaster is invalid",
    );
    assert(
      typeof quote.paymasterAndData === "string" && /^0x[0-9a-fA-F]+$/.test(quote.paymasterAndData),
      "paymasterAndData is invalid",
    );
    assert(
      Array.isArray(quote.supportedTokens) && quote.supportedTokens.includes("USDC"),
      "supportedTokens is invalid",
    );
    assert(
      typeof quote.maxTokenCost === "string" && quote.maxTokenCost.length > 0,
      "maxTokenCost is missing",
    );

    console.log(`API smoke passed for ${apiBaseUrl}`);
  }

  if (webUrl) {
    const webResponse = await assertOk(await fetch(webUrl), "GET web URL");
    const html = await webResponse.text();

    assert(
      html.includes(expectedWebTitle),
      `Web response does not include expected title fragment: ${expectedWebTitle}`,
    );
    assert(!html.includes("Authentication Required"), "Web response is still protected");

    console.log(`Web smoke passed for ${webUrl}`);
    console.log(`Expected web title fragment: ${expectedWebTitle}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
