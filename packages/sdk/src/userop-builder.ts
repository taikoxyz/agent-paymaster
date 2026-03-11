import { AgentPaymasterSdkError } from "./errors.js";
import type {
  Address,
  BuildUserOperationInput,
  HexString,
  PaymasterRpcResult,
  QuoteResponse,
  UserOperation,
  UserOperationGasEstimate,
} from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

interface PaymasterDataInput {
  paymasterAndData?: HexString;
  paymaster?: Address;
  paymasterData?: HexString;
}

const assertHex = (value: string, fieldName: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_hex", `${fieldName} must be a hex string`);
  }

  return value.toLowerCase() as HexString;
};

const assertAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
};

export const buildUserOperation = (input: BuildUserOperationInput): UserOperation => {
  const userOperation: UserOperation = {
    sender: assertAddress(input.sender, "sender"),
    nonce: assertHex(input.nonce, "nonce"),
    initCode: assertHex(input.initCode ?? "0x", "initCode"),
    callData: assertHex(input.callData, "callData"),
    maxFeePerGas: assertHex(input.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: assertHex(input.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    signature: assertHex(input.signature ?? "0x", "signature"),
  };

  if (input.callGasLimit !== undefined) {
    userOperation.callGasLimit = assertHex(input.callGasLimit, "callGasLimit");
  }

  if (input.verificationGasLimit !== undefined) {
    userOperation.verificationGasLimit = assertHex(input.verificationGasLimit, "verificationGasLimit");
  }

  if (input.preVerificationGas !== undefined) {
    userOperation.preVerificationGas = assertHex(input.preVerificationGas, "preVerificationGas");
  }

  if (input.l1DataGas !== undefined) {
    userOperation.l1DataGas = assertHex(input.l1DataGas, "l1DataGas");
  }

  return userOperation;
};

const resolvePaymasterAndData = (input: PaymasterDataInput): HexString => {
  if (input.paymasterAndData !== undefined) {
    return assertHex(input.paymasterAndData, "paymasterAndData");
  }

  if (input.paymaster !== undefined && input.paymasterData !== undefined) {
    return `${assertAddress(input.paymaster, "paymaster")}${assertHex(input.paymasterData, "paymasterData").slice(2)}`;
  }

  throw new AgentPaymasterSdkError(
    "invalid_paymaster_data",
    "Provide paymasterAndData or both paymaster and paymasterData",
  );
};

export const applyPaymasterData = (userOperation: UserOperation, input: PaymasterDataInput): UserOperation => ({
  ...userOperation,
  paymasterAndData: resolvePaymasterAndData(input),
});

export class UserOperationBuilder {
  private draft: UserOperation;

  constructor(input: BuildUserOperationInput) {
    this.draft = buildUserOperation(input);
  }

  withGasEstimate(estimate: UserOperationGasEstimate): this {
    this.draft = {
      ...this.draft,
      callGasLimit: assertHex(estimate.callGasLimit, "callGasLimit"),
      verificationGasLimit: assertHex(estimate.verificationGasLimit, "verificationGasLimit"),
      preVerificationGas: assertHex(estimate.preVerificationGas, "preVerificationGas"),
    };

    return this;
  }

  withPaymasterQuote(quote: QuoteResponse | Pick<PaymasterRpcResult, "paymasterAndData">): this {
    this.draft = {
      ...this.draft,
      paymasterAndData: assertHex(quote.paymasterAndData, "paymasterAndData"),
    };

    return this;
  }

  withPaymasterData(input: PaymasterDataInput): this {
    this.draft = applyPaymasterData(this.draft, input);
    return this;
  }

  withSignature(signature: HexString): this {
    this.draft = {
      ...this.draft,
      signature: assertHex(signature, "signature"),
    };

    return this;
  }

  build(): UserOperation {
    return { ...this.draft };
  }
}
