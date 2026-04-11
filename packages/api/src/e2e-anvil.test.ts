/**
 * E2E cold-start test on local Anvil.
 *
 * Deploys EntryPoint + MockUSDC + ServoPaymaster (Pimlico SingletonPaymasterV7 wrapper) +
 * ServoAccountFactory, creates an in-process API + Bundler, and verifies the complete zero-ETH
 * flow for a fresh agent account:
 *
 *   1. Agent funds the counterfactual account with USDC while it is still undeployed.
 *   2. A single cold-start UserOp deploys the account via initCode and runs
 *      executeBatch([USDC.permit(MAX_UINT256), USDC.transfer(recipient, amount)]).
 *   3. Pimlico postOp pulls the gas fee in USDC after execution, using the allowance created
 *      earlier in the same UserOp.
 *
 * Run:  RUN_E2E_ANVIL=1 pnpm --filter @agent-paymaster/api vitest run e2e-anvil
 *
 * Requires: anvil + forge (Foundry), all workspace packages built.
 * Not part of CI — run manually to validate the full on-chain flow.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  createClient,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import {
  BundlerService,
  ViemAdmissionSimulator,
  ViemCallGasEstimator,
  ViemGasSimulator,
  type HexString,
} from "@agent-paymaster/bundler";
import { BundlerSubmitter } from "@agent-paymaster/bundler/src/submitter.js";

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

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
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
  "function allowance(address,address) view returns (uint256)",
]);
const USDC_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
const FACTORY_ABI = parseAbi([
  "function getAddress(address,uint256) view returns (address)",
  "function createAccount(address,uint256) returns (address)",
]);
const ACCOUNT_ABI = parseAbi([
  "function execute(address,uint256,bytes)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] calldatas)",
]);
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
    const child = spawn("anvil", ["--chain-id", String(CHAIN_ID)], {
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

const createAppProvider = (app: {
  request: (path: string, init: RequestInit) => Promise<Response>;
}): Eip1193Provider => ({
  async request({ method, params = [] }) {
    const res = await app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) {
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result;
  },
});

/** Split a 65-byte compact signature into (v, r, s) components. */
const splitSig = (sig: Hex): { v: number; r: Hex; s: Hex } => {
  const bytes = sig.slice(2);
  const r = `0x${bytes.slice(0, 64)}` as Hex;
  const s = `0x${bytes.slice(64, 128)}` as Hex;
  const v = Number.parseInt(bytes.slice(128, 130), 16);
  return { v, r, s };
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.runIf(runE2E)("E2E: Anvil cold-start (single UserOp bootstrap)", () => {
  let anvil: ChildProcess;
  let fixture: AnvilFixture;
  let app: ReturnType<typeof createApp>;
  let bundlerService: BundlerService;
  let bundlerSubmitter: BundlerSubmitter;
  let counterfactual: Hex;

  // Shared state built progressively across ordered test steps
  let factoryCalldata: Hex;
  let initCode: Hex;
  let batchedCallData: Hex;
  let gasPrice: bigint;

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
    bundlerService = new BundlerService({
      chainId: CHAIN_ID,
      entryPoints: [fixture.entryPoint as HexString],
      gasSimulator: new ViemGasSimulator(ANVIL_RPC, anvilChain),
      callGasEstimator: new ViemCallGasEstimator(ANVIL_RPC, anvilChain),
      admissionSimulator: new ViemAdmissionSimulator(ANVIL_RPC, anvilChain),
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

    bundlerSubmitter = new BundlerSubmitter(bundlerService, {
      chainRpcUrl: ANVIL_RPC,
      privateKey: SUBMITTER_PK,
      chain: anvilChain,
      pollIntervalMs: 100,
      maxOperationsPerBundle: 1,
      maxInflightTransactions: 1,
      txTimeoutMs: 15_000,
    });
    bundlerSubmitter.start();
  }, 180_000);

  afterAll(async () => {
    bundlerSubmitter?.stop();
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
      /* cleanup — file may not exist */
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // Pre-flight: verify fresh state
  // -------------------------------------------------------------------------
  it("counterfactual account has USDC, no code, no ETH", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);

    factoryCalldata = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [agent.address, SALT],
    });
    initCode = `${fixture.factory.toLowerCase()}${factoryCalldata.slice(2)}` as Hex;

    const permitNonce = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [counterfactual],
    })) as bigint;
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
        spender: getAddress(fixture.paymaster),
        value: maxUint256,
        nonce: permitNonce,
        deadline,
      },
    });
    const { v, r, s } = splitSig(permitSig);

    const permitCalldata = encodeFunctionData({
      abi: USDC_PERMIT_ABI,
      functionName: "permit",
      args: [counterfactual, getAddress(fixture.paymaster), maxUint256, deadline, v, r, s],
    });
    const transferInner = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [RECIPIENT, TRANSFER_AMOUNT],
    });
    batchedCallData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        [fixture.usdc, fixture.usdc],
        [0n, 0n],
        [permitCalldata, transferInner],
      ],
    });
    gasPrice = await publicClient.getGasPrice();

    const code = await publicClient.getCode({ address: counterfactual });
    expect(code === undefined || code === "0x").toBe(true);

    const ethBalance = await publicClient.getBalance({ address: counterfactual });
    expect(ethBalance).toBe(0n);

    const usdcBalance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    expect(usdcBalance).toBe(INITIAL_USDC);

    const allowance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [counterfactual, fixture.paymaster],
    })) as bigint;
    expect(allowance).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Single cold-start op: deploy + permit + action + postOp settlement
  // -------------------------------------------------------------------------
  it("deploys, permits, transfers, and settles gas in a single cold-start UserOp", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const submitter = privateKeyToAccount(SUBMITTER_PK);
    const submitterWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: submitter,
    });

    const paymasterUsdcBefore = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [fixture.paymaster],
    })) as bigint;
    const accountUsdcBefore = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;

    // Quote the final cold-start UserOp. callData already includes permit + transfer.
    const draftUserOp = {
      sender: counterfactual,
      nonce: "0x0",
      initCode,
      callData: batchedCallData,
      maxFeePerGas: toHex(gasPrice),
      maxPriorityFeePerGas: toHex(gasPrice),
      signature: DUMMY_SIG,
    };

    const pm = (await appRpc(app, "pm_getPaymasterData", [
      draftUserOp,
      fixture.entryPoint,
      "taikoMainnet",
    ])) as Record<string, string>;

    expect(pm.isStub).toBe(false);
    expect(getAddress(pm.paymaster)).toBe(getAddress(fixture.paymaster));
    // Inner paymasterData must start with Pimlico's ERC-20 mode + allowAllBundlers byte (0x03).
    expect(pm.paymasterData.slice(2, 4)).toBe("03");

    // Sign the final cold-start UserOp.
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
        callData: batchedCallData,
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

    const txHash = await submitterWallet.writeContract({
      address: fixture.entryPoint,
      abi: HANDLE_OPS_ABI,
      functionName: "handleOps",
      args: [
        [
          {
            sender: counterfactual,
            nonce: 0n,
            initCode,
            callData: batchedCallData,
            accountGasLimits,
            preVerificationGas: apiPVG,
            gasFees,
            paymasterAndData: pm.paymasterAndData as Hex,
            signature: userOpSig,
          },
        ],
        submitter.address,
      ],
      gas: 3_000_000n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe("success");

    const code = await publicClient.getCode({ address: counterfactual });
    expect(code).toBeDefined();
    expect(code!.length).toBeGreaterThan(2);

    const allowance = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [counterfactual, fixture.paymaster],
    })) as bigint;
    expect(allowance).toBe(maxUint256);

    const recipientUsdc = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    })) as bigint;
    expect(recipientUsdc).toBe(TRANSFER_AMOUNT);

    const paymasterUsdcAfter = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [fixture.paymaster],
    })) as bigint;
    expect(paymasterUsdcAfter).toBeGreaterThan(paymasterUsdcBefore);

    const accountUsdcAfter = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    })) as bigint;
    expect(accountUsdcAfter).toBeLessThan(accountUsdcBefore - TRANSFER_AMOUNT);

    const accountEth = await publicClient.getBalance({ address: counterfactual });
    expect(accountEth).toBe(0n);

    console.log(
      `Cold-start op: recipient USDC ${formatUnits(recipientUsdc, 6)} | account USDC ${formatUnits(accountUsdcBefore, 6)} -> ${formatUnits(accountUsdcAfter, 6)} | paymaster fee ${formatUnits(paymasterUsdcAfter - paymasterUsdcBefore, 6)}`,
    );
  }, 120_000);

  it("submits the same cold-start flow through /rpc using viem only", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const deployerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: deployer,
    });
    const rpcClient = createClient({
      chain: anvilChain,
      transport: custom(createAppProvider(app)),
    });
    const smokeSalt = 1n;

    const smokeCounterfactual = (await publicClient.readContract({
      address: fixture.factory,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [agent.address, smokeSalt],
    })) as Hex;

    const mintHash = await deployerWallet.writeContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [smokeCounterfactual, INITIAL_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const smokeFactoryCalldata = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [agent.address, smokeSalt],
    });
    const smokeInitCode = `${fixture.factory.toLowerCase()}${smokeFactoryCalldata.slice(2)}` as Hex;

    const permitNonce = (await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [smokeCounterfactual],
    })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const transferInner = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [RECIPIENT, TRANSFER_AMOUNT],
    });
    const actionOnlyCallData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [fixture.usdc, 0n, transferInner],
    });
    const stub = (await rpcClient.request({
      method: "pm_getPaymasterStubData",
      params: [
        {
          sender: smokeCounterfactual,
          nonce: "0x0",
          initCode: smokeInitCode,
          callData: actionOnlyCallData,
          maxFeePerGas: toHex(gasPrice),
          maxPriorityFeePerGas: toHex(gasPrice),
          signature: DUMMY_SIG,
        },
        fixture.entryPoint,
        "taikoMainnet",
      ],
    })) as Record<string, string>;

    expect(stub.isStub).toBe(true);
    expect(getAddress(stub.paymaster)).toBe(getAddress(fixture.paymaster));

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
        owner: smokeCounterfactual,
        spender: getAddress(stub.paymaster),
        value: maxUint256,
        nonce: permitNonce,
        deadline,
      },
    });
    const { v, r, s } = splitSig(permitSig);
    const permitCalldata = encodeFunctionData({
      abi: USDC_PERMIT_ABI,
      functionName: "permit",
      args: [smokeCounterfactual, getAddress(stub.paymaster), maxUint256, deadline, v, r, s],
    });
    const smokeBatchedCallData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "executeBatch",
      args: [
        [fixture.usdc, fixture.usdc],
        [0n, 0n],
        [permitCalldata, transferInner],
      ],
    });

    const draftUserOp = {
      sender: smokeCounterfactual,
      nonce: "0x0",
      initCode: smokeInitCode,
      callData: smokeBatchedCallData,
      maxFeePerGas: toHex(gasPrice),
      maxPriorityFeePerGas: toHex(gasPrice),
      signature: DUMMY_SIG,
    };

    const quote = (await rpcClient.request({
      method: "pm_getPaymasterData",
      params: [draftUserOp, fixture.entryPoint, "taikoMainnet"],
    })) as Record<string, string>;

    const userOpHash = getUserOperationHash({
      userOperation: {
        sender: smokeCounterfactual,
        nonce: 0n,
        factory: fixture.factory,
        factoryData: smokeFactoryCalldata,
        callData: smokeBatchedCallData,
        callGasLimit: BigInt(quote.callGasLimit),
        verificationGasLimit: BigInt(quote.verificationGasLimit),
        preVerificationGas: BigInt(quote.preVerificationGas),
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        paymaster: quote.paymaster as Hex,
        paymasterData: quote.paymasterData as Hex,
        paymasterVerificationGasLimit: BigInt(quote.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: BigInt(quote.paymasterPostOpGasLimit),
        signature: DUMMY_SIG,
      },
      entryPointAddress: fixture.entryPoint,
      entryPointVersion: "0.7",
      chainId: CHAIN_ID,
    });

    const signature = await agent.signMessage({ message: { raw: userOpHash } });
    const submittedHash = (await rpcClient.request({
      method: "eth_sendUserOperation",
      params: [
        {
          ...draftUserOp,
          callGasLimit: quote.callGasLimit,
          verificationGasLimit: quote.verificationGasLimit,
          preVerificationGas: quote.preVerificationGas,
          paymasterVerificationGasLimit: quote.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: quote.paymasterPostOpGasLimit,
          paymasterAndData: quote.paymasterAndData,
          signature,
        },
        fixture.entryPoint,
      ],
    })) as Hex;

    expect(submittedHash).toMatch(/^0x[0-9a-f]{64}$/u);

    let receipt: {
      success: boolean;
      receipt: { transactionHash: Hex };
    } | null = null;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      receipt = (await rpcClient.request({
        method: "eth_getUserOperationReceipt",
        params: [submittedHash],
      })) as {
        success: boolean;
        receipt: { transactionHash: Hex };
      } | null;

      if (receipt !== null) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(receipt).not.toBeNull();
    expect(receipt?.success).toBe(true);

    const txReceipt = await publicClient.getTransactionReceipt({
      hash: receipt!.receipt.transactionHash,
    });
    expect(txReceipt.status).toBe("success");

    const deployedCode = await publicClient.getCode({ address: smokeCounterfactual });
    expect(deployedCode).toBeDefined();
    expect(deployedCode!.length).toBeGreaterThan(2);
  }, 120_000);
});
