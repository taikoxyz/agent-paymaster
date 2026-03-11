import { ethers } from "hardhat";

export interface DeployConfig {
  expectedChainId: number;
  entryPoint: string;
  usdc: string;
  quoteSigner: string;
  priceOracle: string;
  surchargeBps: number;
  maxVerificationGasLimit: number;
  postOpOverheadGas: number;
  maxNativeCostWei: bigint;
  maxQuoteTtlSeconds: number;
}

const parseRequiredAddress = (name: string): string => {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }

  return value;
};

const parseRequiredNumber = (name: string): number => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid integer`);
  }

  return parsed;
};

const parseRequiredBigInt = (name: string): bigint => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be a valid bigint-compatible value`);
  }
};

export const deployTaikoUsdcPaymaster = async (config: DeployConfig) => {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  if (Number(network.chainId) !== config.expectedChainId) {
    throw new Error(
      `Chain ID mismatch. Expected ${config.expectedChainId} but connected to ${network.chainId.toString()}`,
    );
  }

  const paymasterFactory = await ethers.getContractFactory("TaikoUsdcPaymaster");
  const paymaster = await paymasterFactory.deploy(
    deployer.address,
    config.entryPoint,
    config.usdc,
    config.quoteSigner,
    config.priceOracle,
    config.surchargeBps,
    config.maxVerificationGasLimit,
    config.postOpOverheadGas,
    config.maxNativeCostWei,
    config.maxQuoteTtlSeconds,
  );

  await paymaster.waitForDeployment();

  console.log("TaikoUsdcPaymaster deployed");
  console.log(`  network chainId: ${network.chainId.toString()}`);
  console.log(`  deployer: ${deployer.address}`);
  console.log(`  contract: ${await paymaster.getAddress()}`);
  console.log(`  entryPoint: ${config.entryPoint}`);
  console.log(`  usdc: ${config.usdc}`);
  console.log(`  quoteSigner: ${config.quoteSigner}`);
  console.log(`  priceOracle: ${config.priceOracle}`);
};

export const loadDeployConfigFromEnv = (expectedChainId: number): DeployConfig => ({
  expectedChainId,
  entryPoint: parseRequiredAddress("ENTRYPOINT_ADDRESS"),
  usdc: parseRequiredAddress("USDC_ADDRESS"),
  quoteSigner: parseRequiredAddress("QUOTE_SIGNER_ADDRESS"),
  priceOracle: parseRequiredAddress("USDC_PRICE_ORACLE_ADDRESS"),
  surchargeBps: parseRequiredNumber("PAYMASTER_SURCHARGE_BPS"),
  maxVerificationGasLimit: parseRequiredNumber("PAYMASTER_MAX_VERIFICATION_GAS_LIMIT"),
  postOpOverheadGas: parseRequiredNumber("PAYMASTER_POSTOP_OVERHEAD_GAS"),
  maxNativeCostWei: parseRequiredBigInt("PAYMASTER_MAX_NATIVE_COST_WEI"),
  maxQuoteTtlSeconds: parseRequiredNumber("PAYMASTER_QUOTE_TTL_SECONDS"),
});
