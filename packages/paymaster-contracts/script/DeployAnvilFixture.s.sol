// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {EntryPoint} from "account-abstraction/contracts/core/EntryPoint.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";
import {ServoAccountFactory} from "../src/ServoAccountFactory.sol";
import {MockERC20Permit} from "../test/mocks/MockERC20Permit.sol";

/// @notice Deploys the full Servo stack onto Anvil for E2E testing.
contract DeployAnvilFixture is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        string memory outputPath = vm.envOr("FIXTURE_OUTPUT_PATH", string("/tmp/servo-anvil-fixture.json"));

        vm.startBroadcast(deployerPrivateKey);

        EntryPoint entryPoint = new EntryPoint();
        MockERC20Permit usdc = new MockERC20Permit();
        TaikoUsdcPaymaster paymaster = new TaikoUsdcPaymaster(
            IEntryPoint(address(entryPoint)),
            address(usdc),
            quoteSigner,
            1_000_000,   // maxVerificationGasLimit (1M — generous for CREATE2 deployment)
            200_000,     // maxPostOpOverheadGas
            1 ether,     // maxNativeCostWei
            300,         // maxQuoteTtlSeconds
            1_000        // maxSurchargeBps (10%)
        );
        ServoAccountFactory factory = new ServoAccountFactory(IEntryPoint(address(entryPoint)));

        // Fund the paymaster's EntryPoint deposit
        entryPoint.depositTo{value: 2 ether}(address(paymaster));

        vm.stopBroadcast();

        // Write fixture addresses as JSON
        string memory json = string.concat(
            '{"entryPoint":"', vm.toString(address(entryPoint)),
            '","usdc":"', vm.toString(address(usdc)),
            '","paymaster":"', vm.toString(address(paymaster)),
            '","factory":"', vm.toString(address(factory)),
            '","quoteSigner":"', vm.toString(quoteSigner),
            '"}'
        );
        vm.writeFile(outputPath, json);

        console.log("Anvil fixture deployed");
        console.log("  entryPoint:", address(entryPoint));
        console.log("  usdc:", address(usdc));
        console.log("  paymaster:", address(paymaster));
        console.log("  factory:", address(factory));
        console.log("  quoteSigner:", quoteSigner);
        console.log("  output:", outputPath);
    }
}
