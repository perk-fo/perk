// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";

/// @dev Minimal PositionManager + Permit2 deploy copied from v4-periphery `PosmTestSetup`.
abstract contract PosmDeployer is DeployPermit2 {
    Vm private constant VM_POSM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error PositionManagerDeployFailed();
    uint256 internal constant POSM_UNSUBSCRIBE_GAS_LIMIT = 100_000;

    function deployPosm(IPoolManager poolManager) internal returns (IPositionManager posm, IAllowanceTransfer permit2) {
        permit2 = IAllowanceTransfer(deployPermit2());
        // Wrap/unwrap is unused; native quote is settled as ETH on modifyLiquidities.
        address weth = address(uint160(uint256(keccak256("WETH"))));
        // Deployed from the artifact rather than imported: PositionManager is compiled under its own 500-runs profile
        // (foundry.toml compilation_restrictions) and must not share a compilation job with PoolManager.
        bytes memory initCode = bytes.concat(
            VM_POSM.getCode("PositionManager.sol:PositionManager"),
            abi.encode(poolManager, permit2, POSM_UNSUBSCRIBE_GAS_LIMIT, IPositionDescriptor(address(0)), IWETH9(weth))
        );
        address addr;
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (addr == address(0)) revert PositionManagerDeployFailed();
        posm = IPositionManager(addr);
    }
}
