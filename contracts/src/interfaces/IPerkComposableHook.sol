// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @title IPerkComposableHook
/// @notice One versioned hook address serving every official pool; per-pool behaviour is fixed by the registered
///         PoolInfo (PRD 8.2). V1 modules: Official Pool Guard, Quote Fee Router, Holder Quote Reward adapter.
/// @dev Permissions (ADR-001, ADR-005): beforeInitialize, afterInitialize, beforeSwap, afterSwap,
///      beforeSwapReturnDelta, afterSwapReturnDelta. NO liquidity or donate callbacks.
///      Quote-side fee: when the quote is the *specified* currency (exact-in buy, exact-out sell) the fee is taken in
///      beforeSwap via BeforeSwapDelta; when the quote is *unspecified* (exact-out buy, exact-in sell) it is taken in
///      afterSwap via the returned int128. Either way the quote is `take`n to the FeeRouter and accounted with
///      FeeSource.HOOK inside the same callback.
interface IPerkComposableHook is IHooks {
    struct PoolInfo {
        bytes32 launchId;
        address meme;
        Currency quote;
        bytes32 configHash;
        uint256 moduleBitmap;
        /// @dev Hook fee in bps of the quote amount (85 = 0.85%).
        uint24 hookFeeBps;
        bool memeIsCurrency0;
        bool registered;
        bool initialized;
    }

    event PoolRegistered(
        PoolId indexed poolId,
        bytes32 indexed launchId,
        address indexed meme,
        Currency quote,
        bytes32 configHash,
        uint256 moduleBitmap,
        uint24 hookFeeBps
    );
    event OfficialPoolRegistered(
        bytes32 indexed launchId, PoolId indexed poolId, bytes32 configHash, uint256 moduleBitmap
    );
    event HookFeeTaken(PoolId indexed poolId, Currency indexed quote, uint256 amount, bool takenInBeforeSwap);

    error NotPoolManager();
    error NotGraduationManager();
    error PoolNotRegistered();
    error PoolAlreadyRegistered();
    error PoolAlreadyInitialized();
    error UnauthorizedInitializer(address sender);
    error PoolKeyMismatch();
    error HookNotImplemented();

    function HOOK_VERSION() external view returns (uint32);
    function poolManager() external view returns (address);
    function feeRouter() external view returns (address);
    function graduationManager() external view returns (address);

    /// @notice GraduationManager only, before PoolManager.initialize. Commits the official PoolKey for a launch.
    function registerPool(
        PoolKey calldata key,
        bytes32 launchId,
        address meme,
        bytes32 configHash,
        uint256 moduleBitmap,
        uint24 hookFeeBps
    ) external;

    function poolInfo(PoolId poolId) external view returns (PoolInfo memory);
    function poolIdOf(address meme) external view returns (PoolId);
}
