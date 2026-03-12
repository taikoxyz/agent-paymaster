// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";

contract DeployTaikoUsdcPaymaster is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address entryPointAddr = vm.envAddress("ENTRYPOINT_ADDRESS");
        address usdcAddress = vm.envAddress("USDC_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        uint256 maxVerificationGasLimit = vm.envUint("PAYMASTER_MAX_VERIFICATION_GAS_LIMIT");
        uint256 maxPostOpOverheadGas = vm.envUint("PAYMASTER_MAX_POSTOP_OVERHEAD_GAS");
        uint256 maxNativeCostWei = vm.envUint("PAYMASTER_MAX_NATIVE_COST_WEI");
        uint256 maxQuoteTtlSeconds = vm.envUint("PAYMASTER_QUOTE_TTL_SECONDS");
        uint256 maxSurchargeBps = vm.envUint("PAYMASTER_MAX_SURCHARGE_BPS");

        vm.startBroadcast(deployerPrivateKey);

        TaikoUsdcPaymaster paymaster = new TaikoUsdcPaymaster(
            IEntryPoint(entryPointAddr),
            usdcAddress,
            quoteSigner,
            maxVerificationGasLimit,
            maxPostOpOverheadGas,
            maxNativeCostWei,
            maxQuoteTtlSeconds,
            maxSurchargeBps
        );

        vm.stopBroadcast();

        console.log("TaikoUsdcPaymaster deployed");
        console.log("  deployer:", deployer);
        console.log("  contract:", address(paymaster));
        console.log("  entryPoint:", entryPointAddr);
        console.log("  usdc:", usdcAddress);
        console.log("  quoteSigner:", quoteSigner);
        console.log("  maxPostOpOverheadGas:", maxPostOpOverheadGas);
        console.log("  maxSurchargeBps:", maxSurchargeBps);
    }
}
