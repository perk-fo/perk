// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";

/// @dev Deploys LPGrantVault from its artifact (compiled under the low-runs profile, see foundry.toml).
abstract contract VaultDeployer {
    Vm private constant VM_VAULT = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error VaultDeployFailed();

    function defaultVaultConfig() internal pure returns (IPerkLPGrantVault.Config memory) {
        return IPerkLPGrantVault.Config({
            rootDelaySeconds: 1 days, rootDeadlineSeconds: 14 days, minActivation: 1e18, maxPriceDeviationTicks: 500
        });
    }

    function deployVault(
        address owner,
        address factory,
        address templateRegistry,
        address referralRegistry,
        address treasury,
        address poolManager,
        address positionManager,
        IPerkLPGrantVault.Config memory config
    ) internal returns (IPerkLPGrantVault vault) {
        bytes memory initCode = bytes.concat(
            VM_VAULT.getCode("LPGrantVault.sol:LPGrantVault"),
            abi.encode(
                owner, factory, templateRegistry, referralRegistry, treasury, poolManager, positionManager, config
            )
        );
        address addr;
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (addr == address(0)) revert VaultDeployFailed();
        vault = IPerkLPGrantVault(addr);
    }
}
