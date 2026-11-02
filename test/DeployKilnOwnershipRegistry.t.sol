// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployKilnOwnershipRegistry} from "../script/DeployKilnOwnershipRegistry.s.sol";
import {KilnOwnershipRegistry} from "../contracts/KilnOwnershipRegistry.sol";

/// @notice Exercises the deploy script end to end against the local test
/// chain and asserts the deployment is recorded in chain.json. The record
/// write is redirected (KILN_DEPLOYMENTS_PATH) to a scratch file seeded with
/// the canonical record, so the real deployments/chain.json is never touched
/// by a test run — a test entry in the canonical file would falsely flip the
/// app to "anchored."
contract DeployKilnOwnershipRegistryTest is Test {
    // Anvil account #0 — a public, well-known test key, never a real one.
    uint256 internal constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    string internal constant SCRATCH_PATH = "out/test-chain.json";
    string internal constant CANONICAL_PATH = "deployments/chain.json";

    function setUp() public {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("KILN_DEPLOYMENTS_PATH", SCRATCH_PATH);
        // Seed the scratch record with the canonical file's exact contents.
        vm.writeFile(SCRATCH_PATH, vm.readFile(CANONICAL_PATH));
    }

    function testDeployScriptRecordsDeployment() public {
        DeployKilnOwnershipRegistry script = new DeployKilnOwnershipRegistry();
        KilnOwnershipRegistry registry = script.run();

        assertTrue(address(registry) != address(0));
        assertGt(address(registry).code.length, 0);

        string memory key = string.concat(".deployments.", vm.toString(block.chainid));
        string memory json = vm.readFile(SCRATCH_PATH);

        // The entry exists and names the contract this run actually deployed.
        address recorded = abi.decode(vm.parseJson(json, string.concat(key, ".address")), (address));
        assertEq(recorded, address(registry));

        uint256 recordedChainId = abi.decode(vm.parseJson(json, string.concat(key, ".chainId")), (uint256));
        assertEq(recordedChainId, block.chainid);

        address recordedDeployer = abi.decode(vm.parseJson(json, string.concat(key, ".deployer")), (address));
        assertEq(recordedDeployer, vm.addr(DEPLOYER_KEY));

        string memory recordedAt = abi.decode(vm.parseJson(json, string.concat(key, ".deployedAt")), (string));
        assertEq(recordedAt, vm.toString(block.timestamp));

        // txHash is recorded only when the broadcast summary vouches for this
        // exact deployment; when present it must be a full 32-byte hash.
        if (vm.keyExistsJson(json, string.concat(key, ".txHash"))) {
            string memory txHash = abi.decode(vm.parseJson(json, string.concat(key, ".txHash")), (string));
            assertEq(bytes(txHash).length, 66);
        }

        // The pre-existing record shape survives the write.
        string memory schema = abi.decode(vm.parseJson(json, ".schema"), (string));
        assertEq(schema, "kiln.chain-deployments.v1");

        // And the canonical record stays untouched by the test run.
        string memory canonical = vm.readFile(CANONICAL_PATH);
        assertFalse(vm.keyExistsJson(canonical, key));

        vm.removeFile(SCRATCH_PATH);
    }
}
