// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {KilnOwnershipRegistry} from "../contracts/KilnOwnershipRegistry.sol";

contract DeployKilnOwnershipRegistry is Script {
    function run() external returns (KilnOwnershipRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        registry = new KilnOwnershipRegistry();
        vm.stopBroadcast();
    }
}
