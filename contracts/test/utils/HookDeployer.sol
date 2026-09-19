// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PerkComposableHookV1} from "../../src/hook/PerkComposableHookV1.sol";

/// @dev Deploys `PerkComposableHookV1` at a flag-encoded address via `deployCodeTo`.
abstract contract HookDeployer is Test {
    uint160 internal constant HOOK_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    /// @notice Flag-encoded address used by the V1 hook (ADR-001 / ADR-005).
    function predictedHookAddress() internal pure returns (address) {
        return address(HOOK_FLAGS ^ (0x4444 << 144));
    }

    /// @notice Etches `PerkComposableHookV1` at `hookAddr` and runs its constructor.
    function deployHook(IPoolManager poolManager, address feeRouter, address graduationManager, address hookAddr)
        internal
        returns (PerkComposableHookV1 hook)
    {
        deployCodeTo(
            "PerkComposableHookV1.sol:PerkComposableHookV1",
            abi.encode(poolManager, feeRouter, graduationManager),
            hookAddr
        );
        hook = PerkComposableHookV1(hookAddr);
    }
}
