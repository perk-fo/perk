// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IPerkGraduationManager
/// @notice Two-phase, resumable graduation (PRD 5.7). Anyone can call `graduate` and retry after a failed stage.
/// @dev Stages:
///      FUNDED            pulled unsold meme + poolReserve + realQuote from the curve and lpReserve from FeeRouter
///      POOL_INITIALIZED  hook.registerPool + PoolManager.initialize at the curve's final price
///      LIQUIDITY_ADDED   minted the locked initial position(s) to InitialLpLocker
///      DONE              leftover handled per template policy, factory status GRADUATED
///      Seeding math: memeToPool = min(memeReceived, quoteReceived * 1e18 / priceX18); quoteToPool = memeToPool * price.
///      Leftover quote (if meme-limited) goes into a quote-only range below current price (ISSUE #1 TODO decision);
///      leftover meme follows PoolParams.leftoverPolicy (V1: BURN).
interface IPerkGraduationManager {
    enum Stage {
        NONE,
        FUNDED,
        POOL_INITIALIZED,
        LIQUIDITY_ADDED,
        DONE
    }

    struct Graduation {
        Stage stage;
        PoolKey key;
        PoolId poolId;
        uint160 sqrtPriceX96;
        uint256 memeReceived;
        uint256 quoteReceived;
        uint256 memeToPool;
        uint256 quoteToPool;
        uint256 memeLeftover;
        uint256 quoteLeftover;
        uint256 positionTokenId;
        uint256 quoteOnlyPositionTokenId;
        uint128 liquidity;
    }

    event GraduationStageAdvanced(address indexed meme, Stage stage);
    event LaunchGraduated(
        address indexed meme,
        bytes32 indexed launchId,
        PoolId indexed poolId,
        uint256 memeToPool,
        uint256 quoteToPool,
        uint128 liquidity
    );
    event LeftoverHandled(address indexed meme, uint256 memeBurned, uint256 quoteInRangeOrder);

    error NotGraduationPending();
    error AlreadyDone();
    error InvalidStage(Stage current);

    function graduate(address meme) external;
    function graduationOf(address meme) external view returns (Graduation memory);
    function initialLpLocker() external view returns (address);
    function factory() external view returns (address);
    function curve() external view returns (address);
    function hook() external view returns (address);
    function feeRouter() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
}
