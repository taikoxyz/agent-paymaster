export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agent Paymaster API",
    version: "0.2.3",
    description:
      "Unified ERC-4337 bundler and paymaster API with zero-config access and USDC gas quoting for Taiko.",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development",
    },
  ],
  paths: {
    "/health": {
      get: {
        summary: "Gateway health",
        responses: {
          "200": {
            description: "Gateway and dependency health",
          },
        },
      },
    },
    "/status": {
      get: {
        summary: "Detailed gateway status",
        responses: {
          "200": {
            description: "Service status and runtime configuration",
          },
        },
      },
    },
    "/capabilities": {
      get: {
        summary: "Servo capabilities",
        responses: {
          "200": {
            description:
              "Supported chains, entry points, token addresses, optional factory, and permit requirements",
          },
        },
      },
    },
    "/metrics": {
      get: {
        summary: "Prometheus metrics",
        responses: {
          "200": {
            description: "Prometheus exposition format",
          },
        },
      },
    },
    "/rpc": {
      post: {
        summary: "Unified JSON-RPC endpoint",
        description: "Proxies eth_* methods to bundler and serves pm_* paymaster methods.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  jsonrpc: { type: "string", enum: ["2.0"] },
                  id: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
                  method: { type: "string" },
                  params: {},
                },
                required: ["jsonrpc", "id", "method"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "JSON-RPC response (success or error payload)",
          },
        },
      },
    },
  },
} as const;
