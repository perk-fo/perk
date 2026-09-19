// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPositionDescriptor} from "v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";

import {XLayerAddresses} from "./lib/XLayerAddresses.sol";

/// @dev Shared testnet v4 bootstrap used by `DeployTestnetV4` and `DeployPerk`.
library TestnetV4Deployer {
    uint256 internal constant UNSUBSCRIBE_GAS_LIMIT = 100_000;

    error TestnetOnly();
    error Permit2Missing();
    error PositionManagerDeployFailed();

    /// @notice Deploy a fresh PoolManager + PositionManager. Etches canonical Permit2 when it is absent (tests / anvil).
    /// @param vm_ Foundry cheatcode instance (the calling script's `vm`).
    /// @param owner PoolManager initial owner.
    function deploy(Vm vm_, address owner)
        internal
        returns (address poolManager, address positionManager, address permit2)
    {
        if (block.chainid == XLayerAddresses.MAINNET_CHAIN_ID) revert TestnetOnly();
        poolManager = address(new PoolManager(owner));
        permit2 = ensurePermit2(vm_);
        positionManager = deployPositionManager(vm_, IPoolManager(poolManager), permit2);
    }

    /// @notice Deploy PositionManager against an existing PoolManager.
    /// @dev Deployed from the artifact rather than imported: PositionManager is compiled under its own 500-runs profile
    ///      (foundry.toml compilation_restrictions) and must not share a compilation job with PoolManager.
    function deployPositionManager(Vm vm_, IPoolManager poolManager, address permit2) internal returns (address addr) {
        address weth = address(uint160(uint256(keccak256("WETH"))));
        bytes memory initCode = bytes.concat(
            vm_.getCode("PositionManager.sol:PositionManager"),
            abi.encode(
                poolManager,
                IAllowanceTransfer(permit2),
                UNSUBSCRIBE_GAS_LIMIT,
                IPositionDescriptor(address(0)),
                IWETH9(weth)
            )
        );
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (addr == address(0)) revert PositionManagerDeployFailed();
    }

    /// @dev Canonical Permit2 if present; otherwise etch via `DeployPermit2` (cheatcode path, not broadcast).
    function ensurePermit2(Vm vm_) internal returns (address permit2) {
        permit2 = XLayerAddresses.PERMIT2;
        if (permit2.code.length != 0) return permit2;

        address helper = address(uint160(uint256(keccak256("perk.DeployPermit2"))));
        vm_.allowCheatcodes(helper);
        vm_.etch(helper, vm_.getDeployedCode("DeployPermit2.sol:DeployPermit2"));
        DeployPermit2(helper).deployPermit2();
        if (permit2.code.length == 0) revert Permit2Missing();
    }
}

/// @title DeployTestnetV4
/// @notice Deploys an unofficial Uniswap v4 stack for X Layer testnet / local use (v4-core BUSL, non-production).
contract DeployTestnetV4 is Script {
    /// @notice Broadcast a fresh testnet v4 stack from `DEPLOYER_PRIVATE_KEY`.
    /// @return poolManager New PoolManager.
    /// @return positionManager New PositionManager.
    /// @return permit2 Canonical Permit2 address (etched when missing).
    function run() public returns (address poolManager, address positionManager, address permit2) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        (poolManager, positionManager, permit2) = TestnetV4Deployer.deploy(vm, deployer);
        vm.stopBroadcast();

        console2.log("DeployTestnetV4 (non-production, v4-core BUSL)");
        console2.log("  poolManager      ", poolManager);
        console2.log("  positionManager  ", positionManager);
        console2.log("  permit2          ", permit2);
    }
}
