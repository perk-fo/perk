// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";

/// @title HookAddress
/// @notice CREATE2 miner for a hook address whose bottom 14 bits equal `PerkComposableHookV1.getHookPermissions()`.
/// @dev Copied from `v4-periphery/test/shared/HookMiner.sol` so scripts do not import `test/shared`.
library HookAddress {
    /// @dev Arachnid's deterministic deployment proxy. `forge script` rewrites `new C{salt}` through this factory.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint160 internal constant FLAG_MASK = Hooks.ALL_HOOK_MASK;
    uint256 internal constant MAX_LOOP = 160_444;

    error SaltNotFound();

    /// @notice Permission flags encoded in `PerkComposableHookV1` (ADR-001 / ADR-005).
    function flags() internal pure returns (uint160) {
        return uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
    }

    /// @notice True when `hook` encodes exactly `flags()`.
    function hasExpectedFlags(address hook) internal pure returns (bool) {
        return uint160(hook) & FLAG_MASK == flags();
    }

    /// @notice Find a salt that deploys `creationCode + constructorArgs` with `flags()` from `deployer`.
    /// @param deployer CREATE2 origin: `CREATE2_DEPLOYER` in `forge script`, `address(this)` when a test calls the script.
    function find(address deployer, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        return find(deployer, flags(), creationCode, constructorArgs);
    }

    /// @notice Find a salt that produces a hook address with the desired `hookFlags`.
    function find(address deployer, uint160 hookFlags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        hookFlags = hookFlags & FLAG_MASK;
        bytes memory creationCodeWithArgs = abi.encodePacked(creationCode, constructorArgs);

        for (uint256 i; i < MAX_LOOP; ++i) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, creationCodeWithArgs);
            if (uint160(hookAddress) & FLAG_MASK == hookFlags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }

    /// @notice Precompute a CREATE2 address.
    function computeAddress(address deployer, bytes32 salt, bytes memory creationCodeWithArgs)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xFF), deployer, salt, keccak256(creationCodeWithArgs)))))
        );
    }
}
