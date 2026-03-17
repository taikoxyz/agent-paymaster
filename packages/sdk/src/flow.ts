import { parseAbi, type PublicClient } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { ServoRpcClient } from "./client.js";
import { AgentPaymasterSdkError } from "./errors.js";
import { signPermit } from "./permit.js";
import { buildInitCode, buildServoCallData, getCounterfactualAddress } from "./servo-account.js";
import { getUserOpHash, signUserOp } from "./sign-userop.js";
import type { Address, ChainName, CreateAndExecuteResult, ServoCall } from "./types.js";
import { buildDummySignature, buildUserOp } from "./userop.js";

const ERC20_PERMIT_NONCES_ABI = parseAbi(["function nonces(address owner) view returns (uint256)"]);

export interface CreateAndExecuteInput {
  rpcClient: ServoRpcClient;
  publicClient: PublicClient;
  owner: LocalAccount;
  entryPoint: Address;
  chain: ChainName | number | `${number}`;
  factoryAddress: Address;
  salt: bigint;
  nonce: bigint;
  calls: ServoCall[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  usdcAmountMicros?: bigint;
  permitNonce?: bigint;
  permitDeadline?: bigint;
  tokenName?: string;
  tokenVersion?: string;
}

const CHAIN_IDS: Record<ChainName, number> = {
  taikoMainnet: 167000,
  taikoHekla: 167009,
  taikoHoodi: 167013,
};

const assertNonNegative = (value: bigint, fieldName: string): bigint => {
  if (value < 0n) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be non-negative`);
  }

  return value;
};

const resolvePermitValue = (maxTokenCostMicros: bigint, usdcAmountMicros?: bigint): bigint => {
  if (usdcAmountMicros === undefined) {
    return maxTokenCostMicros;
  }

  const desired = assertNonNegative(usdcAmountMicros, "usdcAmountMicros");
  return desired >= maxTokenCostMicros ? desired : maxTokenCostMicros;
};

const resolveChainId = (chain: ChainName | number | `${number}`): number => {
  if (typeof chain === "number") {
    if (!Number.isInteger(chain) || chain <= 0) {
      throw new AgentPaymasterSdkError("invalid_chain", "chain must be a positive integer");
    }
    return chain;
  }

  if (chain in CHAIN_IDS) {
    return CHAIN_IDS[chain as ChainName];
  }

  const parsed = Number.parseInt(chain, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AgentPaymasterSdkError(
      "invalid_chain",
      "chain must be a known chain name or integer id",
    );
  }

  return parsed;
};

const readPermitNonce = async (
  publicClient: PublicClient,
  tokenAddress: Address,
  owner: Address,
): Promise<bigint> => {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_PERMIT_NONCES_ABI,
    functionName: "nonces",
    args: [owner],
  });
};

export const createAndExecute = async (
  input: CreateAndExecuteInput,
): Promise<CreateAndExecuteResult> => {
  assertNonNegative(input.salt, "salt");
  assertNonNegative(input.nonce, "nonce");
  assertNonNegative(input.maxFeePerGas, "maxFeePerGas");
  assertNonNegative(input.maxPriorityFeePerGas, "maxPriorityFeePerGas");

  if (input.calls.length === 0) {
    throw new AgentPaymasterSdkError("invalid_calls", "calls must contain at least one item");
  }

  const ownerAddress = input.owner.address as Address;
  const chainId = resolveChainId(input.chain);
  const counterfactualAddress = await getCounterfactualAddress({
    publicClient: input.publicClient,
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });

  const initCode = buildInitCode({
    factoryAddress: input.factoryAddress,
    owner: ownerAddress,
    salt: input.salt,
  });

  const callData = buildServoCallData(input.calls);

  const draftUserOp = buildUserOp({
    sender: counterfactualAddress,
    nonce: `0x${input.nonce.toString(16)}`,
    initCode,
    callData,
    maxFeePerGas: `0x${input.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${input.maxPriorityFeePerGas.toString(16)}`,
    signature: buildDummySignature(),
  });

  const quoteForPermit = await input.rpcClient.getPaymasterData(
    draftUserOp,
    input.entryPoint,
    input.chain,
    {},
  );

  const maxTokenCostMicros = BigInt(quoteForPermit.maxTokenCostMicros);
  const permitValue = resolvePermitValue(maxTokenCostMicros, input.usdcAmountMicros);
  const permitNonce =
    input.permitNonce ??
    (await readPermitNonce(input.publicClient, quoteForPermit.tokenAddress, counterfactualAddress));

  const defaultDeadline = BigInt(quoteForPermit.validUntil);
  const permitDeadline =
    input.permitDeadline === undefined
      ? defaultDeadline
      : input.permitDeadline < defaultDeadline
        ? input.permitDeadline
        : defaultDeadline;

  const signedPermit = await signPermit({
    account: input.owner,
    owner: counterfactualAddress,
    spender: quoteForPermit.paymaster,
    tokenAddress: quoteForPermit.tokenAddress,
    chainId,
    value: permitValue,
    nonce: permitNonce,
    deadline: permitDeadline,
    tokenName: input.tokenName,
    tokenVersion: input.tokenVersion,
  });

  const finalQuote = await input.rpcClient.getPaymasterData(
    draftUserOp,
    input.entryPoint,
    input.chain,
    {
      permit: signedPermit.context,
    },
  );

  const finalUnsignedUserOp = buildUserOp({
    ...draftUserOp,
    callGasLimit: finalQuote.callGasLimit,
    verificationGasLimit: finalQuote.verificationGasLimit,
    preVerificationGas: finalQuote.preVerificationGas,
    paymasterVerificationGasLimit: finalQuote.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: finalQuote.paymasterPostOpGasLimit,
    paymasterAndData: finalQuote.paymasterAndData,
    signature: buildDummySignature(),
  });

  const userOperationHash = await getUserOpHash({
    publicClient: input.publicClient,
    entryPoint: input.entryPoint,
    userOperation: finalUnsignedUserOp,
  });

  const signature = await signUserOp({
    account: input.owner,
    userOpHash: userOperationHash,
  });

  const signedUserOperation = buildUserOp({
    ...finalUnsignedUserOp,
    signature,
  });

  const submittedUserOpHash = await input.rpcClient.sendUserOperation(
    signedUserOperation,
    input.entryPoint,
  );

  return {
    counterfactualAddress,
    quote: finalQuote,
    permit: signedPermit.context,
    userOperation: signedUserOperation,
    userOperationHash: submittedUserOpHash,
  };
};
