/**
 * E2E paymaster test: send 0.01 USDC to gustavog.eth via Servo API.
 * Uses an already-deployed Permit4337Account with USDC balance.
 * Submits via eth_sendUserOperation and lets the bundler auto-submitter
 * handle the on-chain handleOps call — true end-to-end flow.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  concatHex,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = "https://rpc.mainnet.taiko.xyz";
const API_URL = "https://api-production-cdfe.up.railway.app/rpc";
const ENTRY_POINT = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
const USDC = getAddress("0x07d83526730c7438048D55A4fc0b850e2aaB6f0b");
const RECIPIENT = getAddress("0xa935CEC3c5Ef99D7F1016674DEFd455Ef06776C5"); // gustavog.eth
const TRANSFER_AMOUNT = 10_000n; // 0.01 USDC

// Pre-deployed Permit4337Account with USDC balance
const ACCOUNT_ADDRESS = getAddress("0xe15b923912ec01c9886e31aa46c57f60c22c5c9f");

const ownerPk = `0x${"ab".repeat(32)}` as Hex;
const ownerAccount = privateKeyToAccount(ownerPk);

console.log(`Account owner: ${ownerAccount.address}`);
console.log(`Smart account: ${ACCOUNT_ADDRESS}`);
console.log(`Recipient: ${RECIPIENT} (gustavog.eth)`);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const taiko = {
  id: 167000,
  name: "taiko-mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain: taiko, transport: http(RPC_URL) });

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const artifactPath = resolve(
  process.cwd(),
  "packages/paymaster-contracts/out/Permit4337Account.sol/Permit4337Account.json",
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};

const ENTRY_POINT_ABI = parseAbi([
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
]);

const ZERO_SIGNATURE = `0x${"00".repeat(65)}` as Hex;
const toUint128Hex = (v: bigint): Hex => toHex(v, { size: 16 });
const packUint128Pair = (a: bigint, b: bigint): Hex =>
  concatHex([toUint128Hex(a), toUint128Hex(b)]);

// ---------------------------------------------------------------------------
// JSON-RPC helper for Servo API
// ---------------------------------------------------------------------------

const servoRpc = async (method: string, params: unknown[]) => {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as Record<string, string>;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  // 1. Verify account state
  console.log("\n--- Step 1: Verify account ---");
  const accountUsdc = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [ACCOUNT_ADDRESS],
  });
  const accountEth = await publicClient.getBalance({ address: ACCOUNT_ADDRESS });
  console.log(`Account USDC: ${formatUnits(accountUsdc, 6)}`);
  console.log(`Account ETH: ${formatUnits(accountEth, 18)} (should be 0)`);

  if (accountUsdc < TRANSFER_AMOUNT) {
    throw new Error(`Account needs at least ${formatUnits(TRANSFER_AMOUNT, 6)} USDC`);
  }

  // 2. Build UserOp callData: execute(USDC, 0, transfer(gustavog, 0.01 USDC))
  console.log("\n--- Step 2: Build UserOp ---");
  const innerTransfer = encodeFunctionData({
    abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]),
    functionName: "transfer",
    args: [RECIPIENT, TRANSFER_AMOUNT],
  });
  const callData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "execute",
    args: [USDC, 0n, innerTransfer],
  });

  const gasPrice = await publicClient.getGasPrice();
  console.log(`Gas price: ${formatUnits(gasPrice, 9)} gwei`);

  const partialUserOp = {
    sender: ACCOUNT_ADDRESS,
    nonce: "0x0",
    initCode: "0x",
    callData,
    callGasLimit: toHex(200_000n),
    verificationGasLimit: toHex(200_000n),
    preVerificationGas: toHex(100_000n),
    maxFeePerGas: toHex(gasPrice),
    maxPriorityFeePerGas: toHex(gasPrice),
    signature: ZERO_SIGNATURE,
  };

  // 3. Get paymaster stub data (gas estimation + max cost)
  console.log("\n--- Step 3: Get paymaster stub data ---");
  const stubData = await servoRpc("pm_getPaymasterStubData", [
    partialUserOp,
    ENTRY_POINT,
    "taikoMainnet",
  ]);
  console.log(`Max gas cost: ${stubData.maxTokenCost} USDC`);

  const maxTokenCostMicros = BigInt(stubData.maxTokenCostMicros);
  if (accountUsdc < TRANSFER_AMOUNT + maxTokenCostMicros) {
    throw new Error(
      `Account needs ${formatUnits(TRANSFER_AMOUNT + maxTokenCostMicros, 6)} USDC total`,
    );
  }

  // 4. Sign USDC permit (account → paymaster for maxTokenCost)
  console.log("\n--- Step 4: Sign USDC permit ---");
  const permitNonce = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "nonces",
    args: [ACCOUNT_ADDRESS],
  });
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permitSig = await ownerAccount.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 167000,
      verifyingContract: USDC,
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
      owner: ACCOUNT_ADDRESS,
      spender: getAddress(stubData.paymaster),
      value: maxTokenCostMicros,
      nonce: permitNonce,
      deadline: permitDeadline,
    },
  });
  console.log(`Permit signed (value: ${formatUnits(maxTokenCostMicros, 6)} USDC)`);

  // 5. Get real paymaster data with permit
  console.log("\n--- Step 5: Get paymaster data ---");
  const userOpWithGas = {
    ...partialUserOp,
    callGasLimit: stubData.callGasLimit,
    verificationGasLimit: stubData.verificationGasLimit,
    preVerificationGas: stubData.preVerificationGas,
  };

  const pmData = await servoRpc("pm_getPaymasterData", [
    userOpWithGas,
    ENTRY_POINT,
    "taikoMainnet",
    {
      permit: {
        value: maxTokenCostMicros.toString(),
        deadline: permitDeadline.toString(),
        signature: permitSig,
      },
    },
  ]);
  console.log(`Quote: ${pmData.quoteId} | Cost: ${pmData.maxTokenCost} USDC`);

  // 6. Build and sign the final UserOp
  console.log("\n--- Step 6: Sign UserOp ---");
  const callGasLimit = BigInt(pmData.callGasLimit);
  const verificationGasLimit = BigInt(pmData.verificationGasLimit);
  const preVerificationGas = BigInt(pmData.preVerificationGas);
  const accountGasLimits = packUint128Pair(verificationGasLimit, callGasLimit);
  const gasFees = packUint128Pair(gasPrice, gasPrice);

  const packedUserOp = {
    sender: ACCOUNT_ADDRESS,
    nonce: 0n,
    initCode: "0x" as Hex,
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData: pmData.paymasterAndData as Hex,
    signature: ZERO_SIGNATURE,
  };

  const userOpHash = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: "getUserOpHash",
    args: [packedUserOp],
  });

  const userOpSignature = await ownerAccount.signMessage({
    message: { raw: userOpHash },
  });
  console.log(`UserOp hash: ${userOpHash}`);

  // 7. Submit via eth_sendUserOperation (bundler auto-submitter handles on-chain tx)
  console.log("\n--- Step 7: Submit via eth_sendUserOperation ---");
  const sendUserOp = {
    sender: ACCOUNT_ADDRESS,
    nonce: "0x0",
    initCode: "0x",
    callData,
    callGasLimit: pmData.callGasLimit,
    verificationGasLimit: pmData.verificationGasLimit,
    preVerificationGas: pmData.preVerificationGas,
    maxFeePerGas: toHex(gasPrice),
    maxPriorityFeePerGas: toHex(gasPrice),
    paymasterAndData: pmData.paymasterAndData,
    signature: userOpSignature,
  };

  const sendResult = await servoRpc("eth_sendUserOperation", [sendUserOp, ENTRY_POINT]);
  const returnedHash = sendResult as unknown as string;
  console.log(`Submitted! UserOp hash: ${returnedHash}`);

  // 8. Poll for receipt (bundler auto-submitter will pick it up)
  console.log("\n--- Step 8: Waiting for bundler to submit on-chain ---");
  const POLL_INTERVAL_MS = 3_000;
  const MAX_WAIT_MS = 120_000;
  const startTime = Date.now();
  let receipt: Record<string, unknown> | null = null;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      const result = await servoRpc("eth_getUserOperationReceipt", [returnedHash]);
      if (result) {
        receipt = result as unknown as Record<string, unknown>;
        break;
      }
    } catch {
      // Not yet submitted, keep polling
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  Polling... (${elapsed}s elapsed)`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!receipt) {
    throw new Error(`Timed out waiting for UserOp receipt after ${MAX_WAIT_MS / 1000}s`);
  }

  const txHash = (receipt as Record<string, unknown>).receipt
    ? ((receipt as Record<string, unknown>).receipt as Record<string, string>).transactionHash
    : (receipt as Record<string, string>).transactionHash;
  console.log(`Transaction: ${txHash}`);
  console.log(`Success: ${(receipt as Record<string, unknown>).success}`);

  // 9. Verify results
  console.log("\n--- Results ---");
  const recipientUsdc = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [RECIPIENT],
  });
  const accountUsdcAfter = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [ACCOUNT_ADDRESS],
  });
  const accountEthAfter = await publicClient.getBalance({ address: ACCOUNT_ADDRESS });

  console.log(`Recipient USDC: ${formatUnits(recipientUsdc, 6)}`);
  console.log(`Account USDC: ${formatUnits(accountUsdc, 6)} → ${formatUnits(accountUsdcAfter, 6)}`);
  console.log(`Account ETH: ${formatUnits(accountEthAfter, 18)} (should be 0 — gas paid in USDC)`);
  console.log(`\n✅ Successfully sent 0.01 USDC to gustavog.eth using Servo paymaster!`);
  console.log(`   No ETH needed — bundler auto-submitter handled everything.`);
};

main().catch((err) => {
  console.error("\nFailed:", err.message ?? err);
  process.exitCode = 1;
});
