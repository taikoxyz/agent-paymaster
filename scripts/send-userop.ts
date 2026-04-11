/**
 * End-to-end test: send a UserOp through the Servo paymaster, paying gas in USDC.
 *
 * Usage: PK=0x... npx tsx scripts/send-userop.ts
 *
 * Prerequisites:
 *   1. `SMART_ACCOUNT` below must already be deployed on Taiko mainnet.
 *   2. `SMART_ACCOUNT` must have a persistent USDC allowance granted to the current
 *      `ServoPaymaster`. Use `scripts/live-paymaster-smoke.ts` once to bootstrap the
 *      allowance via an EIP-2612 permit transaction, then this script can send warm
 *      UserOps against the same account.
 *   3. `SMART_ACCOUNT` must hold enough USDC to cover gas for the op.
 *
 * Pimlico's SingletonPaymasterV7 has no permit slot in `paymasterAndData`, so there is no
 * cold-start path that works in a single UserOp — allowance must exist at `postOp` time.
 */
import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  toHex,
  concatHex,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taiko } from "viem/chains";

// ── Config ──────────────────────────────────────────────────────────────
const SMART_ACCOUNT = "0x560832daba4020b31df5bef135aa215d9548a2d3" as const;
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const PAYMASTER_API = "https://api-production-cdfe.up.railway.app/rpc";

const PK = process.env.PK as Hex;
if (!PK) {
  console.error("Set PK env var to the owner private key");
  process.exit(1);
}
const owner = privateKeyToAccount(PK);

const client = createPublicClient({ chain: taiko, transport: http() });

// ── Helpers ─────────────────────────────────────────────────────────────
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(PAYMASTER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

/** Compute the canonical UserOp hash (same as EntryPoint + bundler). */
function computeUserOpHash(op: {
  sender: Hex;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterAndData: Hex;
}): Hex {
  const verificationGasLimit = BigInt(op.verificationGasLimit);
  const callGasLimit = BigInt(op.callGasLimit);
  const maxPriorityFeePerGas = BigInt(op.maxPriorityFeePerGas);
  const maxFeePerGas = BigInt(op.maxFeePerGas);

  const accountGasLimits = concatHex([
    toHex(verificationGasLimit, { size: 16 }),
    toHex(callGasLimit, { size: 16 }),
  ]);
  const gasFees = concatHex([
    toHex(maxPriorityFeePerGas, { size: 16 }),
    toHex(maxFeePerGas, { size: 16 }),
  ]);

  const innerHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        op.sender,
        BigInt(op.nonce),
        keccak256(op.initCode),
        keccak256(op.callData),
        accountGasLimits,
        BigInt(op.preVerificationGas),
        gasFees,
        keccak256(op.paymasterAndData),
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [innerHash, ENTRYPOINT, BigInt(taiko.id)],
    ),
  );
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  // 1. Build callData — call ping() on the smart account
  const callData = encodeFunctionData({
    abi: [
      { name: "ping", type: "function", inputs: [], outputs: [], stateMutability: "nonpayable" },
    ],
  });

  // 2. Get gas fees from chain
  const block = await client.getBlock();
  const baseFee = block.baseFeePerGas ?? 10_000_000n;
  const maxPriorityFeePerGas = 1_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  console.log("Base fee:", baseFee, "Max fee:", maxFeePerGas);

  // 3. Get nonce
  const nonce = await client.readContract({
    address: ENTRYPOINT,
    abi: [
      {
        name: "getNonce",
        type: "function",
        inputs: [
          { name: "sender", type: "address" },
          { name: "key", type: "uint192" },
        ],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
    ],
    functionName: "getNonce",
    args: [SMART_ACCOUNT, 0n],
  });
  console.log("Nonce:", nonce);

  // 4. Get paymaster quote (bundler needs non-empty dummy signature for estimation)
  const DUMMY_SIG = ("0x" + "ff".repeat(65)) as Hex;
  const draftUserOp = {
    sender: SMART_ACCOUNT,
    nonce: toHex(nonce),
    initCode: "0x",
    callData,
    callGasLimit: toHex(55000n), // ping() needs ~45k; bundler default (35k) is too low
    maxFeePerGas: toHex(maxFeePerGas),
    maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
    signature: DUMMY_SIG,
    paymasterAndData: "0x",
  };

  console.log("\nRequesting paymaster quote...");
  const pmData = (await rpc("pm_getPaymasterData", [
    draftUserOp,
    ENTRYPOINT,
    "taikoMainnet",
    {},
  ])) as Record<string, string>;

  console.log("Quote received:");
  console.log("  Max USDC cost:", pmData.maxTokenCost);
  console.log("  Valid until:", new Date(Number(pmData.validUntil) * 1000).toISOString());

  // 5. Compute UserOp hash with the real paymaster data
  const fullOpForHash = {
    sender: SMART_ACCOUNT as Hex,
    nonce: toHex(nonce) as Hex,
    initCode: "0x" as Hex,
    callData: callData as Hex,
    callGasLimit: pmData.callGasLimit as Hex,
    verificationGasLimit: pmData.verificationGasLimit as Hex,
    preVerificationGas: pmData.preVerificationGas as Hex,
    maxFeePerGas: toHex(maxFeePerGas) as Hex,
    maxPriorityFeePerGas: toHex(maxPriorityFeePerGas) as Hex,
    paymasterAndData: pmData.paymasterAndData as Hex,
  };

  const userOpHash = computeUserOpHash(fullOpForHash);
  console.log("\nUserOp hash:", userOpHash);

  // 6. Sign (personal_sign — Permit4337Account uses toEthSignedMessageHash)
  const signature = await owner.signMessage({ message: { raw: userOpHash } });
  console.log("Signature:", signature.slice(0, 20) + "...");

  // 7. Submit in the bundler's unpacked format
  const submitOp = {
    sender: SMART_ACCOUNT,
    nonce: toHex(nonce),
    initCode: "0x",
    callData,
    callGasLimit: pmData.callGasLimit,
    verificationGasLimit: pmData.verificationGasLimit,
    preVerificationGas: pmData.preVerificationGas,
    maxFeePerGas: toHex(maxFeePerGas),
    maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
    paymasterAndData: pmData.paymasterAndData,
    paymasterVerificationGasLimit: pmData.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: pmData.paymasterPostOpGasLimit,
    signature,
  };

  console.log("\nSubmitting UserOp via eth_sendUserOperation...");
  const opHash = await rpc("eth_sendUserOperation", [submitOp, ENTRYPOINT]);
  console.log("UserOp submitted! Hash:", opHash);

  // 8. Poll for receipt
  console.log("\nWaiting for on-chain confirmation...");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const receipt = (await rpc("eth_getUserOperationReceipt", [opHash])) as Record<
        string,
        unknown
      > | null;
      if (receipt) {
        const txReceipt = receipt.receipt as Record<string, string> | undefined;
        console.log("\n✅ UserOp confirmed on-chain!");
        console.log("  Success:", receipt.success);
        console.log("  Tx hash:", txReceipt?.transactionHash);
        console.log("  Actual gas cost:", receipt.actualGasCost);
        console.log("  Actual gas used:", receipt.actualGasUsed);
        return;
      }
    } catch {
      // not found yet
    }
    process.stdout.write(".");
  }
  console.log("\nTimed out waiting for receipt. Check with: eth_getUserOperationReceipt", opHash);
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
