import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

dotenv.config({ path: "../../.env" });

dotenv.config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
    taikoMainnet: {
      url: process.env.TAIKO_MAINNET_RPC_URL ?? "https://rpc.mainnet.taiko.xyz",
      chainId: 167000,
      accounts,
    },
    taikoHoodi: {
      url: process.env.TAIKO_HOODI_RPC_URL ?? "https://rpc.hoodi.taiko.xyz",
      chainId: 167013,
      accounts,
    },
  },
};

export default config;
