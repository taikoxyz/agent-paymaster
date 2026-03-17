import { type Address, type Hex, parseAbi, toHex, type PublicClient } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import type { LocalAccount } from "viem/accounts";

import type { ServoClient } from "./client.js";
import { signPermit } from "./permit.js";
import { buildInitCode, buildServoCallData, getCounterfactualAddress } from "./servo-account.js";
import type { ChainName, CreateAndExecuteResult, ServoCall } from "./types.js";

const ERC20_NONCES_ABI = parseAbi(["function nonces(address owner) view returns (uint256)"]);
const DUMMY_SIGNATURE: Hex = `0x${"00".repeat(65)}`;

const CHAIN_IDS: Record<ChainName, number> = {
  taikoMainnet: 167000,
  taikoHekla: 167009,
  taikoHoodi: 167013,
};

export interface CreateAndExecuteInput {
  client: ServoClient;
  publicClient: PublicClient;
  owner: LocalAccount;
  entryPoint: Address;
  chain: ChainName | number;
  factoryAddress: Address;
  salt: bigint;
  nonce: bigint;
  calls: ServoCall[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  usdcAmountMicros?: bigint;
  permitDeadline?: bigint;
  tokenName?: string;
  tokenVersion?: string;
}

export const createAndExecute = async (
  input: CreateAndExecuteInput,
): Promise<CreateAndExecuteResult> => {
  const chainId = typeof input.chain === "number" ? input.chain : CHAIN_IDS[input.chain];
  const ownerAddress = input.owner.address;

  // 1. Derive counterfactual account address
  const counterfactualAddress = await getCounterfactualAddress({
    publicClient: input.publicClient,
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });

  // 2. Build initCode and callData
  const initCode = buildInitCode({
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });
  const callData = buildServoCallData(input.calls);

  // 3. Build draft UserOp for quoting
  const draftUserOp = {
    sender: counterfactualAddress,
    nonce: toHex(input.nonce),
    initCode,
    callData,
    maxFeePerGas: toHex(input.maxFeePerGas),
    maxPriorityFeePerGas: toHex(input.maxPriorityFeePerGas),
    signature: DUMMY_SIGNATURE,
  };

  // 4. Get stub quote to learn maxTokenCost and tokenAddress for the permit (no full simulation)
  const initialQuote = await input.client.getPaymasterStubData(
    draftUserOp,
    input.entryPoint,
    input.chain,
  );

  // 5. Sign USDC permit
  const maxTokenCost = BigInt(initialQuote.maxTokenCostMicros);
  const permitValue =
    input.usdcAmountMicros !== undefined && input.usdcAmountMicros >= maxTokenCost
      ? input.usdcAmountMicros
      : maxTokenCost;

  const permitNonce = await input.publicClient.readContract({
    address: initialQuote.tokenAddress,
    abi: ERC20_NONCES_ABI,
    functionName: "nonces",
    args: [counterfactualAddress],
  });

  const quoteDeadline = BigInt(initialQuote.validUntil);
  const deadline =
    input.permitDeadline !== undefined && input.permitDeadline < quoteDeadline
      ? input.permitDeadline
      : quoteDeadline;

  const signedPermit = await signPermit({
    account: input.owner,
    owner: counterfactualAddress,
    spender: initialQuote.paymaster,
    tokenAddress: initialQuote.tokenAddress,
    chainId,
    value: permitValue,
    nonce: permitNonce,
    deadline,
    tokenName: input.tokenName,
    tokenVersion: input.tokenVersion,
  });

  // 6. Get final quote with permit
  const quote = await input.client.getPaymasterData(draftUserOp, input.entryPoint, input.chain, {
    permit: signedPermit.context,
  });

  // 7. Compute UserOp hash using viem (pure, no RPC call needed)
  // factoryData is the createAccount calldata already encoded in initCode (after the 20-byte address)
  const factoryData: Hex = `0x${initCode.slice(42)}`;

  const userOpHash = getUserOperationHash({
    userOperation: {
      sender: counterfactualAddress,
      nonce: input.nonce,
      factory: input.factoryAddress,
      factoryData,
      callData,
      callGasLimit: BigInt(quote.callGasLimit),
      verificationGasLimit: BigInt(quote.verificationGasLimit),
      preVerificationGas: BigInt(quote.preVerificationGas),
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      paymaster: quote.paymaster,
      paymasterData: quote.paymasterData,
      paymasterVerificationGasLimit: BigInt(quote.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(quote.paymasterPostOpGasLimit),
      signature: DUMMY_SIGNATURE,
    },
    entryPointAddress: input.entryPoint,
    entryPointVersion: "0.7",
    chainId,
  });

  // 8. Sign the UserOp hash
  const signature = await input.owner.signMessage({ message: { raw: userOpHash } });

  // 9. Submit
  const submittedHash = await input.client.sendUserOperation(
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
    input.entryPoint,
  );

  return {
    counterfactualAddress,
    quote,
    permit: signedPermit.context,
    userOperationHash: submittedHash,
  };
};
