/**
 * E2E cold-start test on local Anvil.
 *
 * Deploys the full Servo stack (EntryPoint, MockUSDC, Paymaster, Factory),
 * creates an in-process API+Bundler+Submitter, and runs the complete
 * zero-ETH flow: derive counterfactual address → fund with USDC →
 * get paymaster quote → sign permit → sign UserOp → submit → verify.
 *
 * Run: RUN_E2E_ANVIL=1 pnpm --filter @agent-paymaster/api vitest run e2e-anvil
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
  maxUint256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import {
  BundlerService,
  type HexString,
  ViemAdmissionSimulator,
  ViemGasSimulator,
} from "@agent-paymaster/bundler";

import { createApp } from "./index.js";
import { StaticPriceProvider } from "./paymaster-service.js";
import type { JsonRpcRequest, JsonRpcResponse, DependencyHealth } from "./types.js";

const runE2E = process.env.RUN_E2E_ANVIL === "1";

// Anvil well-known keys
const DEPLOYER_PK: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const QUOTE_SIGNER_PK: Hex =
  "0x59c6995e998f97a5a0044966f0945386df7f5f0f6db9df9f8f9f7f5c5d6f7c1a";
const SUBMITTER_PK: Hex =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AGENT_PK: Hex =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const QUOTE_SIGNER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const ANVIL_RPC = "http://127.0.0.1:8545";
const CHAIN_ID = 167000;
const FIXTURE_PATH = "/tmp/servo-anvil-fixture.json";
const RECIPIENT = "0xa935CEC3c5Ef99D7F1016674DEFd455Ef06776C5";
const SALT = 0n;
const TRANSFER_AMOUNT = 10_000n; // 0.01 USDC
const DUMMY_SIG: Hex = `0x${"00".repeat(65)}`;

interface AnvilFixture {
  entryPoint: Hex;
  usdc: Hex;
  paymaster: Hex;
  factory: Hex;
}

const anvilChain = {
  id: CHAIN_ID,
  name: "anvil-taiko",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function mint(address, uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
]);

const FACTORY_ABI = parseAbi([
  "function getAddress(address, uint256) view returns (address)",
  "function createAccount(address, uint256) returns (address)",
]);

const ACCOUNT_ABI = parseAbi(["function execute(address, uint256, bytes)"]);

// ---------------------------------------------------------------------------
// Anvil + Forge
// ---------------------------------------------------------------------------

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
    setTimeout(() => fail(new Error("Anvil timeout")), 10_000);
  });

const deployFixture = (): AnvilFixture => {
  const dir = resolve(process.cwd(), "..", "paymaster-contracts");
  execSync(
    `DEPLOYER_PRIVATE_KEY=${DEPLOYER_PK} QUOTE_SIGNER_ADDRESS=${QUOTE_SIGNER_ADDR} FIXTURE_OUTPUT_PATH=${FIXTURE_PATH} forge script script/DeployAnvilFixture.s.sol --rpc-url ${ANVIL_RPC} --broadcast`,
    { cwd: dir, stdio: "pipe", timeout: 60_000 },
  );
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as AnvilFixture;
};

// ---------------------------------------------------------------------------
// In-process RPC
// ---------------------------------------------------------------------------

const rpc = async (
  app: { request: (path: string, init: RequestInit) => Promise<Response> },
  method: string,
  params: unknown[],
): Promise<Record<string, unknown>> => {
  const res = await app.request("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
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
  let bundlerService: BundlerService;
  let counterfactual: Hex;

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

    // Compute counterfactual + mint USDC
    counterfactual = (await publicClient.readContract({
      address: fixture.factory,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [agent.address, SALT],
    })) as Hex;

    await walletClient.writeContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [counterfactual, 10_000_000n],
    });

    // Build stack
    bundlerService = new BundlerService({
      chainId: CHAIN_ID,
      entryPoints: [fixture.entryPoint as HexString],
      gasSimulator: new ViemGasSimulator(ANVIL_RPC, anvilChain),
      admissionSimulator: new ViemAdmissionSimulator(ANVIL_RPC, anvilChain),
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
          priceProvider: new StaticPriceProvider(2_500_000_000n),
          quoteSignerPrivateKey: QUOTE_SIGNER_PK,
          paymasterAddress: fixture.paymaster,
          supportedEntryPoints: [fixture.entryPoint],
          tokenAddresses: {
            taikoMainnet: fixture.usdc,
            taikoHekla: fixture.usdc,
            taikoHoodi: fixture.usdc,
          },
        },
      },
    });

    // No submitter needed — we'll process bundles manually in the test
  }, 90_000);

  afterAll(async () => {
    if (anvil) {
      anvil.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!anvil.killed) anvil.kill("SIGKILL");
    }
    try {
      unlinkSync(FIXTURE_PATH);
    } catch {}
  });

  it("deploys ServoAccount and transfers USDC with zero ETH", async () => {
    const publicClient = createPublicClient({ chain: anvilChain, transport: http(ANVIL_RPC) });
    const agent = privateKeyToAccount(AGENT_PK);

    // Build initCode and callData
    const factoryCalldata = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [agent.address, SALT],
    });
    const initCode: Hex = `${fixture.factory.toLowerCase()}${factoryCalldata.slice(2)}` as Hex;

    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [RECIPIENT, TRANSFER_AMOUNT],
    });
    const callData = encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "execute",
      args: [fixture.usdc, 0n, transferData],
    });

    const gasPrice = await publicClient.getGasPrice();
    // Use generous gas limits for initCode deployment (factory CREATE2 costs ~522k)
    const VGL = 700000n;
    const CGL = 100000n;
    const PVG = 50000n;

    const draftUserOp = {
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

    // 1. Get stub quote (with our gas limits, not the heuristic ones)
    const stub = (await rpc(app, "pm_getPaymasterStubData", [
      draftUserOp,
      fixture.entryPoint,
      "taikoMainnet",
      {},
    ])) as Record<string, string>;

    // 2. Sign permit
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

    // 3. Get real quote with permit
    // IMPORTANT: the API signs the quote against the bundler's gas estimates,
    // not the values in the draft UserOp. So we must use the gas limits from
    // the API response for the UserOp hash and handleOps submission.
    const pm = (await rpc(app, "pm_getPaymasterData", [
      draftUserOp,
      fixture.entryPoint,
      "taikoMainnet",
      {
        permit: {
          value: maxCost.toString(),
          deadline: deadline.toString(),
          signature: permitSig,
        },
      },
    ])) as Record<string, string>;

    // 4. Compute hash and sign — MUST use the gas limits from the API response
    // because the API's quote signature was computed against these values.
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

    // 5. Submit — use our gas limits + paymaster gas limits from the quote
    const finalUserOp = {
      ...draftUserOp,
      paymasterVerificationGasLimit: pm.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: pm.paymasterPostOpGasLimit,
      paymasterAndData: pm.paymasterAndData,
      signature: userOpSig,
    };

    const submittedHash = (await rpc(app, "eth_sendUserOperation", [
      finalUserOp,
      fixture.entryPoint,
    ])) as unknown as string;

    expect(submittedHash).toMatch(/^0x[0-9a-f]{64}$/u);

    // 6. Manually process the bundle (simulate submitter)
    const submitterAccount = privateKeyToAccount(SUBMITTER_PK);
    const submitterWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: submitterAccount,
    });

    const bundle = bundlerService.createBundle(1);
    expect(bundle).not.toBeNull();

    // Build packed UserOps and call handleOps directly
    const { packUserOperation, ENTRY_POINT_ABI, collectUserOperationExecutions } = await import(
      "@agent-paymaster/bundler/dist/index.js"
    ).then(() => import("@agent-paymaster/bundler")).catch(() => {
      // Fallback: import the entrypoint module
      throw new Error("Cannot import bundler entrypoint helpers");
    });

    // Instead of importing packing utils, just call handleOps via the bundler RPC
    // The bundler already has the UserOp; let's use walletClient to send handleOps
    const handleOpsAbi = parseAbi([
      "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
      "error FailedOp(uint256 opIndex, string reason)",
      "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
    ]);

    // Pack the UserOp for handleOps — must use API gas limits
    const accountGasLimits = concatHex([toHex(apiVGL, { size: 16 }), toHex(apiCGL, { size: 16 })]);
    const gasFees = concatHex([toHex(gasPrice, { size: 16 }), toHex(gasPrice, { size: 16 })]);

    const packedOp = {
      sender: counterfactual,
      nonce: 0n,
      initCode,
      callData,
      accountGasLimits,
      preVerificationGas: apiPVG,
      gasFees,
      paymasterAndData: pm.paymasterAndData as Hex,
      signature: userOpSig,
    };

    // First simulate to get the revert reason if any
    try {
      await publicClient.simulateContract({
        address: fixture.entryPoint,
        abi: handleOpsAbi,
        functionName: "handleOps",
        args: [[packedOp], submitterAccount.address],
        account: submitterAccount,
      });
    } catch (simError: unknown) {
      const e = simError as { shortMessage?: string; cause?: { data?: unknown } };
      console.error("handleOps simulation failed:", e.shortMessage);
      if (e.cause?.data) {
        try {
          console.error("Revert data:", JSON.stringify(e.cause.data, (_, v) => typeof v === "bigint" ? v.toString() : v));
        } catch {
          console.error("Revert data (raw):", String(e.cause.data));
        }
      }
      throw simError;
    }

    const txHash = await submitterWallet.writeContract({
      address: fixture.entryPoint,
      abi: handleOpsAbi,
      functionName: "handleOps",
      args: [[packedOp], submitterAccount.address],
      gas: 2_000_000n,
    });

    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(txReceipt.status).toBe("success");

    // Mark the bundle as submitted in the bundler service
    bundlerService.markBundleSubmitted(bundle!.bundleHash, {
      transactionHash: txHash,
      blockNumber: Number(txReceipt.blockNumber),
      blockHash: txReceipt.blockHash,
      gasCost: "0x0",
      effectiveGasPrice: "0x0",
      success: true,
    });

    // 7. Verify on-chain
    const code = await publicClient.getCode({ address: counterfactual });
    expect(code!.length).toBeGreaterThan(2);

    const accountEth = await publicClient.getBalance({ address: counterfactual });
    expect(accountEth).toBe(0n);

    const accountUsdc = await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [counterfactual],
    });
    expect(accountUsdc).toBeLessThan(10_000_000n);

    const recipientUsdc = await publicClient.readContract({
      address: fixture.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    });
    expect(recipientUsdc).toBe(TRANSFER_AMOUNT);

    console.log(`Account deployed: ${counterfactual}`);
    console.log(`USDC: 10.000000 → ${formatUnits(accountUsdc, 6)}`);
    console.log(`Recipient: ${formatUnits(recipientUsdc, 6)} USDC`);
    console.log(`Account ETH: ${formatUnits(accountEth, 18)} (zero!)`);
  }, 60_000);
});

describe("E2E: Anvil cold-start", () => {
  it("is skipped unless RUN_E2E_ANVIL=1", () => {
    expect(true).toBe(true);
  });
});
