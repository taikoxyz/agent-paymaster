import { deployTaikoUsdcPaymaster, loadDeployConfigFromEnv } from "./deploy";

const TAIKO_MAINNET_CHAIN_ID = 167000;

async function main() {
  const config = loadDeployConfigFromEnv(TAIKO_MAINNET_CHAIN_ID);
  await deployTaikoUsdcPaymaster(config);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
