import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeServoPaymasterSigningHash,
  encodeServoErc20PaymasterConfig,
  packPaymasterAndData,
} from "@agent-paymaster/shared";
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
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ChainlinkOracleSource,
  CoinbaseOracleSource,
  CompositePriceProvider,
  KrakenOracleSource,
} from "../packages/api/src/price-provider.ts";

const ENTRY_POINT_ABI = parseAbi([
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

const USDC_PERMIT_ABI = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

const DUMMY_SIGNATURE = `0x${"ff".repeat(32)}${"aa".repeat(32)}1c` as Hex; // non-zero 65-byte placeholder for hash computation
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

const formatUsdcMicros = (value: bigint): string => formatUnits(value, 6);

const splitSig = (sig: Hex): { v: number; r: Hex; s: Hex } => {
  const bytes = sig.slice(2);
  return {
    r: `0x${bytes.slice(0, 64)}` as Hex,
    s: `0x${bytes.slice(64, 128)}` as Hex,
    v: Number.parseInt(bytes.slice(128, 130), 16),
  };
};

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
const paymasterAddress = getAddress(requireEnv("PAYMASTER_ADDRESS"));
const quoteTtlSeconds = Number(process.env.PAYMASTER_QUOTE_TTL_SECONDS ?? "90");
const surchargeBps = BigInt(process.env.PAYMASTER_SURCHARGE_BPS ?? "500");
const smokePriceOverride = process.env.SMOKE_USDC_PER_ETH_MICROS;

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

const resolveUsdcPerEthMicros = async (): Promise<bigint> => {
  if (smokePriceOverride !== undefined) {
    return BigInt(smokePriceOverride);
  }

  const provider = new CompositePriceProvider({
    primary: new ChainlinkOracleSource({
      ethereumRpcUrl: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    }),
    fallbacks: [new CoinbaseOracleSource(), new KrakenOracleSource()],
  });

  return provider.getUsdcPerEthMicros("taikoMainnet");
};

const main = async () => {
  console.log("Smoke test configuration (ServoPaymaster / Pimlico ERC-20 mode)");
  console.log(`  deployer: ${deployerAccount.address}`);
  console.log(`  owner: ${ownerAccount.address}`);
  console.log(`  quote signer: ${quoteSignerAccount.address}`);
  console.log(`  entryPoint: ${entryPointAddress}`);
  console.log(`  paymaster: ${paymasterAddress}`);
  console.log(`  usdc: ${usdcAddress}`);

  const marketRate = await resolveUsdcPerEthMicros();
  console.log(`  oracle price: ${formatUsdcMicros(marketRate)} USDC/ETH`);

  // Bake the Servo surcharge into the signed exchangeRate (Pimlico has no surcharge slot).
  const surchargedRate =
    (marketRate * (BASIS_POINTS_SCALE + surchargeBps) + (BASIS_POINTS_SCALE - 1n)) /
    BASIS_POINTS_SCALE;

  // Deploy a fresh test account.
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

  // Gas envelope for the ping UserOp.
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

  // Cost bounds used for quoting + funding.
  const totalGasLimit =
    callGasLimit +
    verificationGasLimit +
    preVerificationGas +
    paymasterVerificationGasLimit +
    paymasterPostOpGasLimit;
  const estimatedGasWei = totalGasLimit * maxFeePerGas;
  const maxTokenCostMicros = (estimatedGasWei * surchargedRate) / WEI_PER_ETH;
  const maxTokenCost = formatUsdcMicros(maxTokenCostMicros);
  console.log(`  max token cost: ${maxTokenCost} USDC`);

  // Snapshot balances.
  const deployerUsdcBalance = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [deployerAccount.address],
  })) as bigint;

  if (deployerUsdcBalance < maxTokenCostMicros) {
    throw new Error(
      `deployer USDC balance ${formatUsdcMicros(deployerUsdcBalance)} is below required ${maxTokenCost}`,
    );
  }

  const paymasterUsdcBefore = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  })) as bigint;
  const accountEthBefore = await publicClient.getBalance({ address: accountAddress });

  // Fund the account with USDC so the paymaster has something to pull.
  const fundHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [accountAddress, maxTokenCostMicros],
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  // Sign a USDC permit for MAX_UINT256 so the paymaster can pull from the account. Anyone can
  // broadcast `USDC.permit(owner, spender, value, deadline, v, r, s)` — EIP-2612 only requires
  // the owner's signature — so the deployer submits it as a regular tx. Once the allowance is
  // set, the actual sponsored UserOp needs zero permit machinery.
  const permitNonce = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "nonces",
    args: [accountAddress],
  })) as bigint;
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permitSig = (await ownerAccount.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 167000,
      verifyingContract: usdcAddress,
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
      owner: accountAddress,
      spender: paymasterAddress,
      value: maxUint256,
      nonce: permitNonce,
      deadline: permitDeadline,
    },
  })) as Hex;
  const { v, r, s } = splitSig(permitSig);

  const permitTxHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: USDC_PERMIT_ABI,
    functionName: "permit",
    args: [accountAddress, paymasterAddress, maxUint256, permitDeadline, v, r, s],
  });
  await publicClient.waitForTransactionReceipt({ hash: permitTxHash });

  const allowance = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [accountAddress, paymasterAddress],
  })) as bigint;
  if (allowance !== maxUint256) {
    throw new Error(`expected unlimited allowance after permit, got ${allowance}`);
  }

  // Build the Pimlico ERC-20 mode paymasterConfig bytes.
  const validAfter = Math.floor(Date.now() / 1000) - 30; // small grace window
  const validUntil = validAfter + quoteTtlSeconds;

  const erc20ConfigBytes = encodeServoErc20PaymasterConfig({
    validUntil,
    validAfter,
    token: usdcAddress,
    postOpGas: paymasterPostOpGasLimit,
    exchangeRate: surchargedRate,
    paymasterValidationGasLimit: paymasterVerificationGasLimit,
    treasury: paymasterAddress,
  });

  // Outer envelope (paymaster + vGas + postOpGas) + inner config + placeholder signature, used
  // to compute the digest the quote signer must personal_sign.
  const paymasterAndDataNoSig = packPaymasterAndData({
    paymaster: paymasterAddress,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    paymasterData: erc20ConfigBytes,
  });

  const accountGasLimits = packUint128Pair(verificationGasLimit, callGasLimit);
  const gasFees = packUint128Pair(maxPriorityFeePerGas, maxFeePerGas);

  const signingHash = computeServoPaymasterSigningHash({
    userOp: {
      sender: accountAddress,
      nonce: 0n,
      initCode: "0x",
      callData,
      accountGasLimits,
      preVerificationGas,
      gasFees,
    },
    paymasterAndDataNoSig,
    chainId: 167000,
  });

  const quoteSignature = (await quoteSignerAccount.signMessage({
    message: { raw: signingHash },
  })) as Hex;

  const paymasterAndData = concatHex([paymasterAndDataNoSig, quoteSignature]) as Hex;

  // Build the final UserOp and get its canonical hash from EntryPoint.
  const packedForHash = {
    sender: accountAddress,
    nonce: 0n,
    initCode: "0x" as Hex,
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData,
    signature: DUMMY_SIGNATURE,
  };

  const userOpHash = await publicClient.readContract({
    address: entryPointAddress,
    abi: ENTRY_POINT_ABI,
    functionName: "getUserOpHash",
    args: [packedForHash],
  });

  const userOpSignature = await ownerAccount.signMessage({
    message: { raw: userOpHash },
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

  const pingCount = (await publicClient.readContract({
    address: accountAddress,
    abi: accountAbi,
    functionName: "pingCount",
  })) as bigint;
  const paymasterUsdcAfter = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [paymasterAddress],
  })) as bigint;
  const accountUsdcAfter = (await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [accountAddress],
  })) as bigint;
  const accountEthAfter = await publicClient.getBalance({ address: accountAddress });

  console.log("Smoke test result");
  console.log(`  deployment tx: ${deployHash}`);
  console.log(`  funding tx: ${fundHash}`);
  console.log(`  permit tx: ${permitTxHash}`);
  console.log(`  handleOps tx: ${handleOpsHash}`);
  console.log(`  handleOps status: ${handleOpsReceipt.status}`);
  console.log(`  pingCount: ${pingCount}`);
  console.log(`  quote max token cost: ${maxTokenCost} USDC`);
  console.log(
    `  paymaster USDC delta: ${formatUsdcMicros(paymasterUsdcAfter - paymasterUsdcBefore)} USDC`,
  );
  console.log(`  account USDC after: ${formatUsdcMicros(accountUsdcAfter)} USDC`);
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
