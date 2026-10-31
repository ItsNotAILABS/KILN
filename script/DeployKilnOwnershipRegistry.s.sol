// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {KilnOwnershipRegistry} from "../contracts/KilnOwnershipRegistry.sol";

contract DeployKilnOwnershipRegistry is Script {
    /// @notice Where the deployment record lives. Overridable via
    /// KILN_DEPLOYMENTS_PATH so tests can exercise the recording against a
    /// scratch file instead of the canonical record.
    function _deploymentsPath() internal view returns (string memory) {
        return vm.envOr("KILN_DEPLOYMENTS_PATH", string("deployments/chain.json"));
    }

    function run() external returns (KilnOwnershipRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        registry = new KilnOwnershipRegistry();
        vm.stopBroadcast();

        _recordDeployment(registry, deployer);
    }

    /// @notice Record this deployment in deployments/chain.json, keyed by
    /// chainId (see deployments/README.md: entries are added by the deploy
    /// script run, never by hand). The app syncs this file in and treats any
    /// entry carrying the registry address as the anchor, so a deploy that
    /// skips this step leaves every project "not anchored."
    function _recordDeployment(KilnOwnershipRegistry registry, address deployer) internal {
        string memory objectKey = "kilnDeployment";
        vm.serializeAddress(objectKey, "address", address(registry));
        vm.serializeAddress(objectKey, "deployer", deployer);
        vm.serializeUint(objectKey, "chainId", block.chainid);

        bytes32 txHash = _deploymentTxHash(address(registry));
        if (txHash != bytes32(0)) {
            vm.serializeString(objectKey, "txHash", vm.toString(txHash));
        }
        // deployedAt is unix seconds (UTC), stringified to match the record's
        // consumer type in the app.
        string memory entry = vm.serializeString(objectKey, "deployedAt", vm.toString(block.timestamp));

        vm.writeJson(entry, _deploymentsPath(), string.concat(".deployments.", vm.toString(block.chainid)));
    }

    /// @notice The hash of the transaction that created `registry`, read from
    /// the broadcast summary. The summary is only trusted when it names this
    /// exact deployment (contract address match and success): a stale
    /// broadcast artifact from an earlier run can never supply the hash for
    /// a deployment it did not create. Returns zero when no matching summary
    /// exists (e.g. a simulated run) — the caller then omits the field
    /// rather than recording a hash it cannot vouch for.
    function _deploymentTxHash(address registry) internal view returns (bytes32) {
        try vm.getBroadcast("KilnOwnershipRegistry", uint64(block.chainid), VmSafe.BroadcastTxType.Create) returns (
            VmSafe.BroadcastTxSummary memory summary
        ) {
            if (summary.contractAddress == registry && summary.success) {
                return summary.txHash;
            }
        } catch {}
        return bytes32(0);
    }
}
