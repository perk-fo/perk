// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @dev Deploys a contract from its compiled artifact (for contracts compiled under a restricted profile).
library ArtifactDeployer {
    error ArtifactDeployFailed(string artifact);

    function deploy(Vm vm_, string memory artifact, bytes memory constructorArgs) internal returns (address addr) {
        bytes memory initCode = bytes.concat(vm_.getCode(artifact), constructorArgs);
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (addr == address(0)) revert ArtifactDeployFailed(artifact);
    }
}
