// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {ServoAccountFactory} from "../src/ServoAccountFactory.sol";

contract DeployServoAccountFactory is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address entryPointAddr = vm.envAddress("ENTRYPOINT_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);
        ServoAccountFactory factory = new ServoAccountFactory(IEntryPoint(entryPointAddr));
        vm.stopBroadcast();

        console.log("ServoAccountFactory deployed");
        console.log("  deployer:", deployer);
        console.log("  contract:", address(factory));
        console.log("  entryPoint:", entryPointAddr);
    }
}
