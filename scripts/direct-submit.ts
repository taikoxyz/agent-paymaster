import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toHex,
  concatHex,
  keccak256,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taiko } from "viem/chains";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const SMART_ACCOUNT = "0x560832daba4020b31df5bef135aa215d9548a2d3" as const;
const PAYMASTER_API = "https://api-production-cdfe.up.railway.app/rpc";

const PK = process.env.PK as Hex;
if (!PK) {
  console.error("Set PK");
  process.exit(1);
}
const account = privateKeyToAccount(PK);

const publicClient = createPublicClient({ chain: taiko, transport: http() });
const walletClient = createWalletClient({ chain: taiko, transport: http(), account });

const EP_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
]);

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(PAYMASTER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: any; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

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
  const vgl = BigInt(op.verificationGasLimit);
  const cgl = BigInt(op.callGasLimit);
  const mpfpg = BigInt(op.maxPriorityFeePerGas);
  const mfpg = BigInt(op.maxFeePerGas);
  const accountGasLimits = concatHex([toHex(vgl, { size: 16 }), toHex(cgl, { size: 16 })]);
  const gasFees = concatHex([toHex(mpfpg, { size: 16 }), toHex(mfpg, { size: 16 })]);

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
      [innerHash, ENTRY_POINT, BigInt(taiko.id)],
    ),
  );
}

async function main() {
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: parseAbi(["function getNonce(address, uint192) view returns (uint256)"]),
    functionName: "getNonce",
    args: [SMART_ACCOUNT, 0n],
  });

  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 10_000_000n;
  const maxPriorityFeePerGas = 1_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  const DUMMY_SIG = ("0x" + "ff".repeat(65)) as Hex;

  console.log("Getting fresh quote...");
  const pmData = await rpc("pm_getPaymasterData", [
    {
      sender: SMART_ACCOUNT,
      nonce: toHex(nonce),
      initCode: "0x",
      callData: "0x5c36b186",
      callGasLimit: toHex(55000n), // ping() needs ~45k
      maxFeePerGas: toHex(maxFeePerGas),
      maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
      signature: DUMMY_SIG,
      paymasterAndData: "0x",
    },
    ENTRY_POINT,
    "taikoMainnet",
    {},
  ]);

  console.log("validUntil:", new Date(Number(pmData.validUntil) * 1000).toISOString());
  console.log("maxTokenCost:", pmData.maxTokenCost);

  // Compute hash and sign
  const fullOp = {
    sender: SMART_ACCOUNT as Hex,
    nonce: toHex(nonce) as Hex,
    initCode: "0x" as Hex,
    callData: "0x5c36b186" as Hex,
    callGasLimit: pmData.callGasLimit as Hex,
    verificationGasLimit: pmData.verificationGasLimit as Hex,
    preVerificationGas: pmData.preVerificationGas as Hex,
    maxFeePerGas: toHex(maxFeePerGas) as Hex,
    maxPriorityFeePerGas: toHex(maxPriorityFeePerGas) as Hex,
    paymasterAndData: pmData.paymasterAndData as Hex,
  };

  const userOpHash = computeUserOpHash(fullOp);
  console.log("UserOp hash:", userOpHash);

  const signature = await account.signMessage({ message: { raw: userOpHash } });
  console.log("Signature:", signature.slice(0, 20) + "...");

  // Pack for handleOps
  const vgl = BigInt(pmData.verificationGasLimit);
  const cgl = BigInt(pmData.callGasLimit);
  const accountGasLimits = concatHex([toHex(vgl, { size: 16 }), toHex(cgl, { size: 16 })]);
  const gasFees = concatHex([
    toHex(maxPriorityFeePerGas, { size: 16 }),
    toHex(maxFeePerGas, { size: 16 }),
  ]);

  const packedOp = {
    sender: SMART_ACCOUNT as Hex,
    nonce: BigInt(nonce),
    initCode: "0x" as Hex,
    callData: "0x5c36b186" as Hex,
    accountGasLimits,
    preVerificationGas: BigInt(pmData.preVerificationGas),
    gasFees,
    paymasterAndData: pmData.paymasterAndData as Hex,
    signature,
  };

  console.log("\nSubmitting handleOps directly (bypassing bundler)...");
  const txHash = await walletClient.writeContract({
    address: ENTRY_POINT,
    abi: EP_ABI,
    functionName: "handleOps",
    args: [[packedOp], account.address],
    gas: 2_000_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  console.log("Transaction submitted:", txHash);
  console.log("Waiting for receipt...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Status:", receipt.status);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Block:", receipt.blockNumber.toString());

  // Check for events
  for (const log of receipt.logs) {
    console.log("Log:", log.address, log.topics[0]?.slice(0, 10));
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message?.substring(0, 500) || String(err));
  process.exit(1);
});
