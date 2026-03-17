import { parseAbi, type PublicClient } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { Address, HexString, UserOperation } from "./types.js";
import { packUserOperation } from "./userop.js";

export const ENTRY_POINT_V08_ABI = parseAbi([
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
]);

export interface GetUserOpHashInput {
  publicClient: PublicClient;
  entryPoint: Address;
  userOperation: UserOperation;
}

export const getUserOpHash = async ({
  publicClient,
  entryPoint,
  userOperation,
}: GetUserOpHashInput): Promise<HexString> => {
  const packed = packUserOperation(userOperation);

  const hash = await publicClient.readContract({
    address: entryPoint,
    abi: ENTRY_POINT_V08_ABI,
    functionName: "getUserOpHash",
    args: [packed],
  });

  return hash;
};

export interface SignUserOpInput {
  account: LocalAccount;
  userOpHash: HexString;
}

export const signUserOp = async ({ account, userOpHash }: SignUserOpInput): Promise<HexString> => {
  const signature = (await account.signMessage({
    message: {
      raw: userOpHash,
    },
  })) as HexString;

  return signature;
};
