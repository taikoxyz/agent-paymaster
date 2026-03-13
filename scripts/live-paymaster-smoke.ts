import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  applyPermitToPaymasterQuote,
  createPermitSignature,
  type Address,
  type QuoteResponse,
  type UserOperation,
} from "../packages/sdk/src/index.ts";

const ENTRY_POINT_ABI = parseAbi([
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

const QUOTE_TYPES = {
  SponsoredUserOperation: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCodeHash", type: "bytes32" },
    { name: "callDataHash", type: "bytes32" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "paymasterGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "exchangeRate", type: "uint256" },
    { name: "maxTokenCost", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "postOpOverheadGas", type: "uint32" },
    { name: "surchargeBps", type: "uint16" },
    { name: "chainId", type: "uint256" },
    { name: "paymaster", type: "address" },
  ],
} as const;

const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "token", type: "address" },
      { name: "exchangeRate", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "postOpOverheadGas", type: "uint32" },
      { name: "surchargeBps", type: "uint16" },
    ],
  },
  { type: "bytes", name: "quoteSignature" },
  {
    type: "tuple",
    name: "permit",
    components: [
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

const ZERO_SIGNATURE = `0x${"00".repeat(65)}` as Hex;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const BASIS_POINTS_SCALE = 10_000n;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const toUint128Hex = (value: bigint): Hex => toHex(value, { size: 16 });
const toHexQuantity = (value: bigint): Hex => toHex(value);

const packUint128Pair = (first: bigint, second: bigint): Hex =>
  concatHex([toUint128Hex(first), toUint128Hex(second)]) as Hex;

const buildPackedPaymasterAndData = (
  paymaster: Address,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
  paymasterData: Hex,
): Hex =>
  concatHex([
    paymaster,
    toUint128Hex(verificationGasLimit),
    toUint128Hex(postOpGasLimit),
    paymasterData,
  ]) as Hex;

const formatUsdcMicros = (value: bigint): string => formatUnits(value, 6);

const artifactPath = resolve(
  process.cwd(),
  "packages/paymaster-contracts/out/Permit4337Account.sol/Permit4337Account.json",
);

const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};

const accountAbi = artifact.abi;
const accountBytecode = artifact.bytecode.object;

const rpcUrl = requireEnv("TAIKO_MAINNET_RPC_URL");
const deployerAccount = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const ownerAccount = privateKeyToAccount(requireEnv("TEST_ACCOUNT_OWNER_PRIVATE_KEY") as Hex);
const quoteSignerAccount = privateKeyToAccount(requireEnv("QUOTE_SIGNER_PRIVATE_KEY") as Hex);

const entryPointAddress = getAddress(
  process.env.ENTRYPOINT_ADDRESS ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
);
const usdcAddress = getAddress(
  process.env.USDC_ADDRESS ?? "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
);
const paymasterAddress = getAddress(
  process.env.PAYMASTER_ADDRESS ?? "0xCa675148201E29b13A848cE30c3074c8dE995891",
);
const quoteTtlSeconds = Number(process.env.PAYMASTER_QUOTE_TTL_SECONDS ?? "90");
const surchargeBps = BigInt(process.env.PAYMASTER_SURCHARGE_BPS ?? "500");
const usdcPerEthMicros = BigInt(process.env.PAYMASTER_STATIC_USDC_PER_ETH_MICROS ?? "2500000000");

const publicClient = createPublicClient({
  chain: {
    id: 167000,
    name: "taiko-mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  },
  transport: http(rpcUrl),
});

const walletClient = createWalletClient({
  account: deployerAccount,
  chain: publicClient.chain,
  transport: http(rpcUrl),
});

const main = async () => {
  console.log("Smoke test configuration");
  console.log(`  deployer: ${deployerAccount.address}`);
  console.log(`  owner: ${ownerAccount.address}`);
  console.log(`  quote signer: ${quoteSignerAccount.address}`);
  console.log(`  entryPoint: ${entryPointAddress}`);
  console.log(`  paymaster: ${paymasterAddress}`);
  console.log(`  usdc: ${usdcAddress}`);

  const deployHash = await walletClient.deployContract({
    abi: accountAbi,
    bytecode: accountBytecode,
    args: [entryPointAddress, ownerAccount.address],
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const accountAddress = deployReceipt.contractAddress;

  if (!accountAddress) {
    throw new Error("account deployment did not return a contract address");
  }

  console.log(`Deployed Permit4337Account at ${accountAddress}`);

  const gasPrice = await publicClient.getGasPrice();
  const callGasLimit = 80_000n;
  const verificationGasLimit = 150_000n;
  const preVerificationGas = 150_000n;
  const paymasterVerificationGasLimit = 200_000n;
  const paymasterPostOpGasLimit = 100_000n;
  const maxFeePerGas = gasPrice;
  const maxPriorityFeePerGas = gasPrice;

  const callData = encodeFunctionData({
    abi: accountAbi,
    functionName: "ping",
  });

  const userOperation: UserOperation = {
    sender: accountAddress,
    nonce: "0x0",
    initCode: "0x",
    callData,
    callGasLimit: toHexQuantity(callGasLimit),
    verificationGasLimit: toHexQuantity(verificationGasLimit),
    preVerificationGas: toHexQuantity(preVerificationGas),
    maxFeePerGas: toHexQuantity(maxFeePerGas),
    maxPriorityFeePerGas: toHexQuantity(maxPriorityFeePerGas),
    signature: ZERO_SIGNATURE,
  };

  const totalGasLimit =
    callGasLimit +
    verificationGasLimit +
    preVerificationGas +
    paymasterVerificationGasLimit +
    paymasterPostOpGasLimit;
  const estimatedGasWei = totalGasLimit * maxFeePerGas;
  const baseMicros = (estimatedGasWei * usdcPerEthMicros) / WEI_PER_ETH;
  const maxTokenCostMicros =
    ((baseMicros * (BASIS_POINTS_SCALE + surchargeBps)) + (BASIS_POINTS_SCALE - 1n)) /
    BASIS_POINTS_SCALE;
  const validAfter = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = validAfter + BigInt(quoteTtlSeconds);
  const accountGasLimits = packUint128Pair(verificationGasLimit, callGasLimit);
  const paymasterGasLimits = packUint128Pair(
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
  );
  const gasFees = packUint128Pair(maxPriorityFeePerGas, maxFeePerGas);

  const quoteMessage = {
    sender: accountAddress,
    nonce: 0n,
    initCodeHash: keccak256("0x"),
    callDataHash: keccak256(callData),
    accountGasLimits,
    paymasterGasLimits,
    preVerificationGas,
    gasFees,
    token: usdcAddress,
    exchangeRate: usdcPerEthMicros,
    maxTokenCost: maxTokenCostMicros,
    validAfter: Number(validAfter),
    validUntil: Number(validUntil),
    postOpOverheadGas: Number(paymasterPostOpGasLimit),
    surchargeBps: Number(surchargeBps),
    chainId: 167000n,
    paymaster: paymasterAddress,
  } as const;

  const quoteSignature = await quoteSignerAccount.signTypedData({
    domain: {
      name: "TaikoUsdcPaymaster",
      version: "3",
      chainId: 167000,
      verifyingContract: paymasterAddress,
    },
    types: QUOTE_TYPES,
    primaryType: "SponsoredUserOperation",
    message: quoteMessage,
  });

  const paymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
    {
      token: usdcAddress,
      exchangeRate: usdcPerEthMicros,
      maxTokenCost: maxTokenCostMicros,
      validAfter: Number(validAfter),
      validUntil: Number(validUntil),
      postOpOverheadGas: Number(paymasterPostOpGasLimit),
      surchargeBps: Number(surchargeBps),
    },
    quoteSignature,
    {
      value: 0n,
      deadline: 0n,
      signature: "0x",
    },
  ]) as Hex;

  const quote: QuoteResponse = {
    quoteId: createHash("sha256").update(paymasterData.slice(2), "hex").digest("hex").slice(0, 24),
    chain: "taikoMainnet",
    chainId: 167000,
    token: "USDC",
    paymaster: paymasterAddress,
    paymasterData,
    paymasterAndData: `${paymasterAddress}${paymasterData.slice(2)}` as Hex,
    callGasLimit: toHexQuantity(callGasLimit),
    verificationGasLimit: toHexQuantity(verificationGasLimit),
    preVerificationGas: toHexQuantity(preVerificationGas),
    paymasterVerificationGasLimit: toHexQuantity(paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHexQuantity(paymasterPostOpGasLimit),
    estimatedGasLimit: toHexQuantity(totalGasLimit),
    estimatedGasWei: toHexQuantity(estimatedGasWei),
    maxTokenCostMicros: maxTokenCostMicros.toString(),
    maxTokenCost: formatUsdcMicros(maxTokenCostMicros),
    validUntil: Number(validUntil),
    entryPoint: entryPointAddress,
    sender: accountAddress,
    tokenAddress: usdcAddress,
    supportedTokens: ["USDC"],
  };

  const deployerUsdcBalance = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [deployerAccount.address],
  });

  if (deployerUsdcBalance < maxTokenCostMicros) {
    throw new Error(
      `deployer USDC balance ${formatUsdcMicros(deployerUsdcBalance)} is below required ${quote.maxTokenCost}`,
    );
  }

  const paymasterUsdcBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  const accountUsdcBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [accountAddress],
  });
  const accountEthBefore = await publicClient.getBalance({ address: accountAddress });

  const fundHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [accountAddress, maxTokenCostMicros],
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  const permitNonce = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "nonces",
    args: [accountAddress],
  });
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permit = await createPermitSignature(
    {
      owner: accountAddress,
      spender: paymasterAddress,
      value: maxTokenCostMicros,
      nonce: permitNonce,
      deadline: permitDeadline,
      tokenAddress: usdcAddress,
      chainId: 167000,
    },
    async (typedData) =>
      ownerAccount.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      }),
  );

  const quotedWithPermit = applyPermitToPaymasterQuote(quote, permit);
  const packedPaymasterAndData = buildPackedPaymasterAndData(
    paymasterAddress,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    quotedWithPermit.paymasterData,
  );

  const packedForHash = {
    sender: accountAddress,
    nonce: 0n,
    initCode: "0x" as Hex,
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData: packedPaymasterAndData,
    signature: ZERO_SIGNATURE,
  };

  const userOpHash = await publicClient.readContract({
    address: entryPointAddress,
    abi: ENTRY_POINT_ABI,
    functionName: "getUserOpHash",
    args: [packedForHash],
  });

  const userOpSignature = await ownerAccount.signMessage({
    message: {
      raw: userOpHash,
    },
  });

  const finalUserOperation = {
    ...packedForHash,
    signature: userOpSignature,
  };

  const simulation = await publicClient.simulateContract({
    account: deployerAccount,
    address: entryPointAddress,
    abi: ENTRY_POINT_ABI,
    functionName: "handleOps",
    args: [[finalUserOperation], deployerAccount.address],
  });

  const handleOpsHash = await walletClient.writeContract(simulation.request);
  const handleOpsReceipt = await publicClient.waitForTransactionReceipt({ hash: handleOpsHash });

  const pingCount = await publicClient.readContract({
    address: accountAddress,
    abi: accountAbi,
    functionName: "pingCount",
  });
  const paymasterUsdcAfter = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  });
  const accountUsdcAfter = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [accountAddress],
  });
  const accountEthAfter = await publicClient.getBalance({ address: accountAddress });

  console.log("Smoke test result");
  console.log(`  deployment tx: ${deployHash}`);
  console.log(`  funding tx: ${fundHash}`);
  console.log(`  handleOps tx: ${handleOpsHash}`);
  console.log(`  handleOps status: ${handleOpsReceipt.status}`);
  console.log(`  pingCount: ${pingCount}`);
  console.log(`  quote max token cost: ${quote.maxTokenCost} USDC`);
  console.log(
    `  paymaster USDC delta: ${formatUsdcMicros(paymasterUsdcAfter - paymasterUsdcBefore)} USDC`,
  );
  console.log(
    `  account USDC delta: ${formatUsdcMicros(accountUsdcAfter - accountUsdcBefore)} USDC`,
  );
  console.log(`  account ETH before: ${formatUnits(accountEthBefore, 18)} ETH`);
  console.log(`  account ETH after: ${formatUnits(accountEthAfter, 18)} ETH`);

  if (pingCount !== 1n) {
    throw new Error(`expected pingCount=1, got ${pingCount}`);
  }

  if (accountEthBefore !== 0n || accountEthAfter !== 0n) {
    throw new Error("account should not hold native ETH during the smoke test");
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
