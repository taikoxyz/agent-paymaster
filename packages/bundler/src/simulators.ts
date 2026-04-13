import { logEvent, type HexString } from "@agent-paymaster/shared";
import { createPublicClient, http, type Chain } from "viem";

import {
  ENTRY_POINT_SIMULATION_ABI,
  classifySimulationValidation,
  extractSimulationPreOpGas,
  packUserOperation,
} from "./entrypoint.js";
import type {
  AdmissionSimulator,
  CallGasEstimator,
  GasSimulator,
  UserOperation,
  UserOperationGasEstimate,
} from "./types.js";

export class ViemGasSimulator implements GasSimulator {
  private readonly publicClient;

  constructor(rpcUrl: string, chain?: Chain) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  async estimatePreOpGas(
    userOperation: UserOperation,
    entryPoint: HexString,
    baseline: UserOperationGasEstimate,
  ): Promise<bigint> {
    const simulationUserOperation: UserOperation = {
      ...userOperation,
      callGasLimit: baseline.callGasLimit,
      verificationGasLimit: baseline.verificationGasLimit,
      preVerificationGas: baseline.preVerificationGas,
      paymasterVerificationGasLimit: baseline.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: baseline.paymasterPostOpGasLimit,
      paymasterAndData: userOperation.paymasterAndData ?? "0x",
    };

    try {
      await this.publicClient.simulateContract({
        address: entryPoint,
        abi: ENTRY_POINT_SIMULATION_ABI,
        functionName: "simulateValidation",
        args: [packUserOperation(simulationUserOperation)],
      });
    } catch (error) {
      const preOpGas = extractSimulationPreOpGas(error);
      if (preOpGas !== null) {
        return preOpGas;
      }

      throw error;
    }

    throw new Error("simulateValidation unexpectedly succeeded without revert");
  }
}

export class ViemCallGasEstimator implements CallGasEstimator {
  private readonly publicClient;
  private readonly bufferPercent: bigint;

  constructor(rpcUrl: string, chain?: Chain, bufferPercent = 15n) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
    this.bufferPercent = bufferPercent;
  }

  async estimateCallGas(
    sender: HexString,
    callData: HexString,
    entryPoint: HexString,
  ): Promise<bigint | null> {
    if (callData === "0x" || callData === "0x00") {
      return null;
    }

    const code = await this.publicClient.getCode({ address: sender });
    if (code === undefined || code === "0x") {
      return null;
    }

    try {
      const estimatedGas = await this.publicClient.estimateGas({
        account: entryPoint,
        to: sender,
        data: callData,
      });

      const buffered = estimatedGas + (estimatedGas * this.bufferPercent) / 100n;
      return buffered;
    } catch (error) {
      logEvent("warn", "bundler.call_gas_estimation_failed", {
        sender,
        reason: error instanceof Error ? error.message : "estimation_failed",
      });
      return null;
    }
  }
}

export class ViemAdmissionSimulator implements AdmissionSimulator {
  private readonly publicClient;

  constructor(rpcUrl: string, chain?: Chain) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  async simulateValidation(userOperation: UserOperation, entryPoint: HexString): Promise<void> {
    try {
      await this.publicClient.simulateContract({
        address: entryPoint,
        abi: ENTRY_POINT_SIMULATION_ABI,
        functionName: "simulateValidation",
        args: [packUserOperation(userOperation)],
      });
    } catch (error) {
      const classified = classifySimulationValidation(error);
      if (classified) {
        if (!classified.success) {
          throw new Error(classified.reason);
        }
        return;
      }

      // v0.7 EntryPoint does not expose simulateValidation on the production
      // contract (it lives on EntryPointSimulations). When the revert data
      // cannot be decoded, pass through and let the submitter catch issues
      // during handleOps simulation.
      return;
    }

    throw new Error("simulateValidation unexpectedly succeeded without revert");
  }
}
