import { deployTaikoUsdcPaymaster, loadDeployConfigFromEnv } from "./deploy";

const TAIKO_HOODI_CHAIN_ID = 167013;

async function main() {
  const config = loadDeployConfigFromEnv(TAIKO_HOODI_CHAIN_ID);
  await deployTaikoUsdcPaymaster(config);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
