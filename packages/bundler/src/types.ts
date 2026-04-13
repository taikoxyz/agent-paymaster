import type { HexString } from "@agent-paymaster/shared";

export interface UserOperation {
  sender: HexString;
  nonce: HexString;
  initCode: HexString;
  callData: HexString;
  callGasLimit?: HexString;
  verificationGasLimit?: HexString;
  preVerificationGas?: HexString;
  paymasterVerificationGasLimit?: HexString;
  paymasterPostOpGasLimit?: HexString;
  maxFeePerGas: HexString;
  maxPriorityFeePerGas: HexString;
  paymasterAndData?: HexString;
  signature: HexString;
  l1DataGas?: HexString;
}

export interface UserOperationGasEstimate {
  callGasLimit: HexString;
  verificationGasLimit: HexString;
  preVerificationGas: HexString;
  paymasterVerificationGasLimit: HexString;
  paymasterPostOpGasLimit: HexString;
}

export interface UserOperationReceiptLog {
  address: HexString;
  data: HexString;
  topics: readonly HexString[];
  blockHash?: HexString;
  blockNumber?: HexString;
  transactionHash?: HexString;
  transactionIndex?: HexString;
  logIndex?: HexString;
  removed?: boolean;
}

export interface ClaimedUserOperation {
  hash: string;
  userOperation: UserOperation;
  entryPoint: HexString;
  receivedAt: number;
  submissionTxHash: HexString | null;
  submissionStartedAt: number | null;
}

export interface ClaimedUserOperations {
  entryPoint: HexString;
  userOperations: ClaimedUserOperation[];
}

export interface GasSimulator {
  estimatePreOpGas(
    userOperation: UserOperation,
    entryPoint: HexString,
    baseline: UserOperationGasEstimate,
  ): Promise<bigint>;
}

export interface CallGasEstimator {
  estimateCallGas(
    sender: HexString,
    callData: HexString,
    entryPoint: HexString,
  ): Promise<bigint | null>;
}

export interface AdmissionSimulator {
  simulateValidation(userOperation: UserOperation, entryPoint: HexString): Promise<void>;
}
