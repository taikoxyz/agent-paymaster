/**
 * E2E cold-start test on local Anvil.
 *
 * Deploys EntryPoint + MockUSDC + TaikoUsdcPaymaster + ServoAccountFactory,
 * creates an in-process API + Bundler, and verifies the complete zero-ETH flow:
 * derive counterfactual -> fund USDC -> stub quote -> sign permit ->
 * full quote -> sign UserOp -> submit handleOps -> verify on-chain state.
 *
 * Run:  RUN_E2E_ANVIL=1 pnpm --filter @agent-paymaster/api vitest run e2e-anvil
 *
 * Requires: anvil + forge (Foundry), all workspace packages built.
 * Not part of CI -- run manually to validate the full on-chain flow.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { BundlerService, type HexString } from "@agent-paymaster/bundler";

import { createApp } from "./index.js";
import { StaticPriceProvider } from "./paymaster-service.js";
import type { JsonRpcRequest, JsonRpcResponse, DependencyHealth } from "./types.js";

// ---------------------------------------------------------------------------
// Gate: skip the entire suite unless explicitly enabled
// ---------------------------------------------------------------------------
const runE2E = process.env.RUN_E2E_ANVIL === "1";

// ---------------------------------------------------------------------------
// Anvil well-known keys (deterministic from "test test test..." mnemonic)
// ---------------------------------------------------------------------------
const DEPLOYER_PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const QUOTE_SIGNER_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SUBMITTER_PK: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AGENT_PK: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const QUOTE_SIGNER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ANVIL_RPC = "http://127.0.0.1:8545";
const CHAIN_ID = 167000;
const FIXTURE_PATH = "/tmp/servo-anvil-fixture.json";
const RECIPIENT = "0xa935CEC3c5Ef99D7F1016674DEFd455Ef06776C5";
const SALT = 0n;
const INITIAL_USDC = 10_000_000n; // 10 USDC (6 decimals)
const TRANSFER_AMOUNT = 10_000n; // 0.01 USDC
const DUMMY_SIG: Hex = `0x${"00".repeat(65)}`;
const USDC_PER_ETH_MICROS = 2_500_000_000n; // $2500 per ETH

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AnvilFixture {
  entryPoint: Hex;
  usdc: Hex;
  paymaster: Hex;
  factory: Hex;
}

// ---------------------------------------------------------------------------
// Chain definition for viem clients
// ---------------------------------------------------------------------------
const anvilChain = {
  id: CHAIN_ID,
  name: "anvil-taiko",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

// ---------------------------------------------------------------------------
// Contract ABIs
// ---------------------------------------------------------------------------
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
]);
const FACTORY_ABI = parseAbi([
  "function getAddress(address,uint256) view returns (address)",
  "function createAccount(address,uint256) returns (address)",
]);
const ACCOUNT_ABI = parseAbi(["function execute(address,uint256,bytes)"]);
const HANDLE_OPS_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn Anvil and wait for "Listening on" before resolving. */
const spawnAnvil = (): Promise<ChildProcess> =>
  new Promise((ok, fail) => {
    const child = spawn("anvil", ["--chain-id", String(CHAIN_ID), "--block-time", "1"], {
      stdio: "pipe",
    });
    child.on("error", fail);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        child.stdout?.off("data", onData);
        ok(child);
      }
    };
    child.stdout?.on("data", onData);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("Anvil failed to start within 10s"));
    }, 10_000);
    child.on("exit", () => clearTimeout(timer));
  });

/** Deploy the full Servo contract stack via forge script and return fixture addresses. */
const deployFixture = (): AnvilFixture => {
  try {
    execSync(
      `DEPLOYER_PRIVATE_KEY=${DEPLOYER_PK} QUOTE_SIGNER_ADDRESS=${QUOTE_SIGNER_ADDR} FIXTURE_OUTPUT_PATH=${FIXTURE_PATH} forge script script/DeployAnvilFixture.s.sol --rpc-url ${ANVIL_RPC} --broadcast`,
      { cwd: resolve(process.cwd(), "..", "paymaster-contracts"), stdio: "pipe", timeout: 60_000 },
    );
  } catch (error: unknown) {
    const stderr =
      error instanceof Error && "stderr" in error ? (error as { stderr: Buffer }).stderr : null;
    const msg = stderr ? stderr.toString().slice(0, 2000) : "unknown error";
    throw new Error(`Forge deploy failed:\n${msg}`);
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AnvilFixture;
};

/** Send a JSON-RPC request through the Hono app and return the result. */
const appRpc = async (
  app: { request: (path: string, init: RequestInit) => Promise<Response> },
  method: string,
  params: unknown[],
): Promise<Record<string, unknown>> => {
  const res = await app.request("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.runIf(runE2E)("E2E: Anvil cold-start", () => {
  let anvil: ChildProcess;
  let fixture: AnvilFixture;
  let app: ReturnType<typeof createApp>;
  let counterfactual: Hex;

  // Shared state built progressively across ordered test steps
  let factoryCalldata: Hex;
  let initCode: Hex;
  let callData: Hex;
  let gasPrice: bigint;
  let draftUserOp: Record<string, string>;
  let stub: Record<string, string>;
  let pm: Record<string, string>;
  let txHash: Hex;

  // -------------------------------------------------------------------------
  // Setup: Anvil + contracts + USDC funding + in-process API
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    anvil = await spawnAnvil();
    fixture = deployFixture();

    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const walletClient = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: deployer,
    });

    // Derive counterfactual account address
    counterfactual = (await publicClient.readContract({
      address: fixture.factory,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [agent.address, SALT],
    })) as Hex;

    // Mint USDC to the counterfactual address (account not deployed yet)
    const mintHash = await walletClient.writeContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [counterfactual, INITIAL_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Wire up in-process bundler + API
    const bundlerService = new BundlerService({
      chainId: CHAIN_ID,
      entryPoints: [fixture.entryPoint as HexString],
      paymasterVerificationGasLimit: 200_000n,
    });
    const bundlerClient = {
      async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        return bundlerService.handleJsonRpc(request);
      },
      async health(): Promise<DependencyHealth> {
        return { status: "ok", latencyMs: 0, details: bundlerService.getHealth() };
      },
    };
    app = createApp({
      bundlerClient,
      entryPointMonitor: null,
      config: {
        paymaster: {
          priceProvider: new StaticPriceProvider(USDC_PER_ETH_MICROS),
          quoteSignerPrivateKey: QUOTE_SIGNER_PK,
          paymasterAddress: fixture.paymaster,
          supportedEntryPoints: [fixture.entryPoint],
          tokenAddresses: {
            taikoMainnet: fixture.usdc,
            taikoHoodi: fixture.usdc,
          },
        },
      },
    });
  }, 90_000);

  afterAll(async () => {
    if (anvil) {
      anvil.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        anvil.once("exit", () => resolve());
        setTimeout(() => {
          if (!anvil.killed) anvil.kill("SIGKILL");
          resolve();
        }, 2_000);
      });
    }
    try {
      unlinkSync(FIXTURE_PATH);
    } catch {
      /* cleanup -- file may not exist */
    }
  });

  // -------------------------------------------------------------------------
  // Step 1: Build the draft UserOp (initCode + USDC transfer callData)
  // -------------------------------------------------------------------------
  it("builds a draft UserOp with initCode and USDC transfer", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);

    factoryCalldata = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [agent.address, SALT],
    });
    initCode = `${fixture.factory.toLowerCase()}${factoryCalldata.slice(2)}` as Hex;

    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [RECIPIENT, TRANSFER_AMOUNT],
    });
    callData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [fixture.usdc, 0n, transferData],
    });
    gasPrice = await publicClient.getGasPrice();

    // Gas limits must be generous for initCode deployment
    const VGL = 700_000n;
    const CGL = 100_000n;
    const PVG = 50_000n;
    draftUserOp = {
      sender: counterfactual,
      nonce: "0x0",
      initCode,
      callData,
      callGasLimit: toHex(CGL),
      verificationGasLimit: toHex(VGL),
      preVerificationGas: toHex(PVG),
      maxFeePerGas: toHex(gasPrice),
      maxPriorityFeePerGas: toHex(gasPrice),
      signature: DUMMY_SIG,
    };

    // Verify the counterfactual has USDC but no code and no ETH
    const code = await publicClient.getCode({ address: counterfactual });
    expect(code === undefined || code === "0x").toBe(true);

    const balance = await publicClient.getBalance({ address: counterfactual });
    expect(balance).toBe(0n);

    const usdcBalance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    expect(usdcBalance).toBe(INITIAL_USDC);
  });

  // -------------------------------------------------------------------------
  // Step 2: Get a stub paymaster quote (cost estimate without permit)
  // -------------------------------------------------------------------------
  it("returns a valid stub quote via pm_getPaymasterStubData", async () => {
    stub = (await appRpc(app, "pm_getPaymasterStubData", [
      draftUserOp,
      fixture.entryPoint,
      "taikoMainnet",
      {},
    ])) as Record<string, string>;

    // Verify stub response structure
    expect(stub.paymaster).toBeDefined();
    expect(getAddress(stub.paymaster)).toBe(getAddress(fixture.paymaster));
    expect(stub.paymasterData).toBeDefined();
    expect(stub.paymasterAndData).toBeDefined();
    expect(stub.tokenAddress).toBeDefined();
    expect(getAddress(stub.tokenAddress)).toBe(getAddress(fixture.usdc));
    expect(stub.isStub).toBe(true);

    // Gas limits should be non-zero hex quantities
    expect(BigInt(stub.callGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(stub.verificationGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(stub.preVerificationGas)).toBeGreaterThan(0n);
    expect(BigInt(stub.paymasterVerificationGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(stub.paymasterPostOpGasLimit)).toBeGreaterThan(0n);

    // Cost estimate should be positive and affordable
    const maxCostMicros = BigInt(stub.maxTokenCostMicros);
    expect(maxCostMicros).toBeGreaterThan(0n);
    expect(maxCostMicros).toBeLessThan(INITIAL_USDC);
  });

  // -------------------------------------------------------------------------
  // Step 3: Sign USDC permit and get a full paymaster quote
  // -------------------------------------------------------------------------
  it("returns a full quote via pm_getPaymasterData with permit", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);

    const maxCost = BigInt(stub.maxTokenCostMicros);
    const permitNonce = await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [counterfactual],
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const permitSig = await agent.signTypedData({
      domain: {
        name: "Mock USDC",
        version: "2",
        chainId: CHAIN_ID,
        verifyingContract: fixture.usdc,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: counterfactual,
        spender: getAddress(stub.paymaster),
        value: maxCost,
        nonce: permitNonce,
        deadline,
      },
    });

    pm = (await appRpc(app, "pm_getPaymasterData", [
      draftUserOp,
      fixture.entryPoint,
      "taikoMainnet",
      {
        permit: { value: maxCost.toString(), deadline: deadline.toString(), signature: permitSig },
      },
    ])) as Record<string, string>;

    // Full quote should not be marked as stub
    expect(pm.isStub).toBe(false);
    expect(pm.paymaster).toBeDefined();
    expect(pm.paymasterData).toBeDefined();
    expect(pm.paymasterAndData).toBeDefined();

    // Gas limits from full quote should be valid
    expect(BigInt(pm.callGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(pm.verificationGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(pm.preVerificationGas)).toBeGreaterThan(0n);
    expect(BigInt(pm.paymasterVerificationGasLimit)).toBeGreaterThan(0n);
    expect(BigInt(pm.paymasterPostOpGasLimit)).toBeGreaterThan(0n);

    // Quote should have a validity window
    expect(pm.validUntil).toBeDefined();
    expect(Number(pm.validUntil)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  // -------------------------------------------------------------------------
  // Step 4: Sign the UserOp and submit handleOps
  // -------------------------------------------------------------------------
  it("signs the UserOp and submits handleOps successfully", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const submitter = privateKeyToAccount(SUBMITTER_PK);
    const submitterWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: submitter,
    });

    // MUST use the gas limits from the API (quote was signed against them)
    const apiVGL = BigInt(pm.verificationGasLimit);
    const apiCGL = BigInt(pm.callGasLimit);
    const apiPVG = BigInt(pm.preVerificationGas);
    const pmVGL = BigInt(pm.paymasterVerificationGasLimit);
    const pmPOGL = BigInt(pm.paymasterPostOpGasLimit);

    const userOpHash = getUserOperationHash({
      userOperation: {
        sender: counterfactual,
        nonce: 0n,
        factory: fixture.factory,
        factoryData: factoryCalldata,
        callData,
        callGasLimit: apiCGL,
        verificationGasLimit: apiVGL,
        preVerificationGas: apiPVG,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        paymaster: pm.paymaster as Hex,
        paymasterData: pm.paymasterData as Hex,
        paymasterVerificationGasLimit: pmVGL,
        paymasterPostOpGasLimit: pmPOGL,
        signature: DUMMY_SIG,
      },
      entryPointAddress: fixture.entryPoint,
      entryPointVersion: "0.7",
      chainId: CHAIN_ID,
    });
    const userOpSig = await agent.signMessage({ message: { raw: userOpHash } });

    const accountGasLimits = concatHex([toHex(apiVGL, { size: 16 }), toHex(apiCGL, { size: 16 })]);
    const gasFees = concatHex([toHex(gasPrice, { size: 16 }), toHex(gasPrice, { size: 16 })]);

    txHash = await submitterWallet.writeContract({
      address: fixture.entryPoint,
      abi: HANDLE_OPS_ABI,
      functionName: "handleOps",
      args: [
        [
          {
            sender: counterfactual,
            nonce: 0n,
            initCode,
            callData,
            accountGasLimits,
            preVerificationGas: apiPVG,
            gasFees,
            paymasterAndData: pm.paymasterAndData as Hex,
            signature: userOpSig,
          },
        ],
        submitter.address,
      ],
      gas: 2_000_000n,
    });

    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(txReceipt.status).toBe("success");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Step 5: Verify on-chain state after handleOps
  // -------------------------------------------------------------------------
  it("deployed the ServoAccount (code exists at counterfactual)", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const code = await publicClient.getCode({ address: counterfactual });
    expect(code).toBeDefined();
    expect(code!.length).toBeGreaterThan(2);
  });

  it("account holds zero ETH (gas paid entirely via USDC paymaster)", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const accountEth = await publicClient.getBalance({ address: counterfactual });
    expect(accountEth).toBe(0n);
  });

  it("recipient received the expected USDC transfer amount", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const recipientUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    })) as bigint;
    expect(recipientUsdc).toBe(TRANSFER_AMOUNT);
  });

  it("account USDC balance decreased (transfer + paymaster fee)", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const accountUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;

    // Account should have less than initial minus transfer (paymaster took a fee)
    expect(accountUsdc).toBeLessThan(INITIAL_USDC - TRANSFER_AMOUNT);
    // But should still have most of its USDC (fee should be small relative to balance)
    expect(accountUsdc).toBeGreaterThan(0n);

    console.log(
      `Account: ${counterfactual} | USDC: ${formatUnits(INITIAL_USDC, 6)} -> ${formatUnits(accountUsdc, 6)} | Recipient: ${formatUnits(TRANSFER_AMOUNT, 6)} | Fee: ${formatUnits(INITIAL_USDC - accountUsdc - TRANSFER_AMOUNT, 6)}`,
    );
  });

  it("paymaster received a non-zero USDC fee", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const accountUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;

    const paymasterFee = INITIAL_USDC - accountUsdc - TRANSFER_AMOUNT;
    expect(paymasterFee).toBeGreaterThan(0n);
  });
});
