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

export type PaymasterDataInput =
  | {
      paymasterAndData: HexString;
      paymaster?: never;
      paymasterData?: never;
    }
  | {
      paymasterAndData?: never;
      paymaster: Address;
      paymasterData: HexString;
    };

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

  return value as Address;
};

const assertSignature = (value: string | undefined, fieldName: string): HexString => {
  if (value === undefined) {
    throw new AgentPaymasterSdkError(
      "invalid_signature",
      `${fieldName} is required. Provide a non-empty signature (use a 65-byte dummy signature for gas estimation).`,
    );
  }

  const signature = assertHex(value, fieldName);
  if (signature === "0x") {
    throw new AgentPaymasterSdkError(
      "invalid_signature",
      `${fieldName} cannot be empty. Provide a non-empty signature (use a 65-byte dummy signature for gas estimation).`,
    );
  }

  return signature;
};

export const buildUserOperation = (input: BuildUserOperationInput): UserOperation => {
  const userOperation: UserOperation = {
    sender: assertAddress(input.sender, "sender"),
    nonce: assertHex(input.nonce, "nonce"),
    initCode: assertHex(input.initCode ?? "0x", "initCode"),
    callData: assertHex(input.callData, "callData"),
    maxFeePerGas: assertHex(input.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: assertHex(input.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    signature: assertSignature(input.signature, "signature"),
  };

  if (input.callGasLimit !== undefined) {
    userOperation.callGasLimit = assertHex(input.callGasLimit, "callGasLimit");
  }

  if (input.verificationGasLimit !== undefined) {
    userOperation.verificationGasLimit = assertHex(
      input.verificationGasLimit,
      "verificationGasLimit",
    );
  }

  if (input.preVerificationGas !== undefined) {
    userOperation.preVerificationGas = assertHex(input.preVerificationGas, "preVerificationGas");
  }

  if (input.paymasterVerificationGasLimit !== undefined) {
    userOperation.paymasterVerificationGasLimit = assertHex(
      input.paymasterVerificationGasLimit,
      "paymasterVerificationGasLimit",
    );
  }

  if (input.paymasterPostOpGasLimit !== undefined) {
    userOperation.paymasterPostOpGasLimit = assertHex(
      input.paymasterPostOpGasLimit,
      "paymasterPostOpGasLimit",
    );
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

export const applyPaymasterData = (
  userOperation: UserOperation,
  input: PaymasterDataInput,
): UserOperation => ({
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
      paymasterVerificationGasLimit: assertHex(
        estimate.paymasterVerificationGasLimit,
        "paymasterVerificationGasLimit",
      ),
      paymasterPostOpGasLimit: assertHex(
        estimate.paymasterPostOpGasLimit,
        "paymasterPostOpGasLimit",
      ),
    };

    return this;
  }

  withPaymasterQuote(quote: QuoteResponse | PaymasterRpcResult): this {
    this.draft = {
      ...this.draft,
      paymasterAndData: assertHex(quote.paymasterAndData, "paymasterAndData"),
      callGasLimit:
        "callGasLimit" in quote ? assertHex(quote.callGasLimit, "callGasLimit") : this.draft.callGasLimit,
      verificationGasLimit:
        "verificationGasLimit" in quote
          ? assertHex(quote.verificationGasLimit, "verificationGasLimit")
          : this.draft.verificationGasLimit,
      preVerificationGas:
        "preVerificationGas" in quote
          ? assertHex(quote.preVerificationGas, "preVerificationGas")
          : this.draft.preVerificationGas,
      paymasterVerificationGasLimit:
        "paymasterVerificationGasLimit" in quote
          ? assertHex(quote.paymasterVerificationGasLimit, "paymasterVerificationGasLimit")
          : this.draft.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit:
        "paymasterPostOpGasLimit" in quote
          ? assertHex(quote.paymasterPostOpGasLimit, "paymasterPostOpGasLimit")
          : this.draft.paymasterPostOpGasLimit,
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
      signature: assertSignature(signature, "signature"),
    };

    return this;
  }

  build(): UserOperation {
    return { ...this.draft };
  }
}
