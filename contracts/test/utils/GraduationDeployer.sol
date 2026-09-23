// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";

/// @dev Deploys GraduationManager from its artifact (compiled under the low-runs profile, see foundry.toml).
abstract contract GraduationDeployer {
    Vm private constant VM_GRAD = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error GraduationDeployFailed();

    function deployGraduation(
        address owner,
        address factory,
        address curve,
        address feeRouter,
        address poolManager,
        address positionManager,
        address templateRegistry,
        address locker,
        uint64 rescueDelay
    ) internal returns (IPerkGraduationManager graduation) {
        bytes memory initCode = bytes.concat(
            VM_GRAD.getCode("GraduationManager.sol:GraduationManager"),
            abi.encode(
                owner, factory, curve, feeRouter, poolManager, positionManager, templateRegistry, locker, rescueDelay
            )
        );
        address addr;
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (addr == address(0)) revert GraduationDeployFailed();
        graduation = IPerkGraduationManager(addr);
    }
}
