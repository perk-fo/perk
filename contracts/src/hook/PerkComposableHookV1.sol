// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IPerkComposableHook} from "../interfaces/IPerkComposableHook.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";

/// @title PerkComposableHookV1
/// @notice Official Pool Guard + Quote Fee Router + Holder Quote Reward adapter for every Perk V1 official pool.
/// @dev See ADR-001 (fee callbacks), ADR-002 (rewards ordering), ADR-005 (no liquidity callbacks).
///      The hook address must encode exactly `getHookPermissions()`; the constructor reverts otherwise.
contract PerkComposableHookV1 is IPerkComposableHook {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using StateLibrary for IPoolManager;

    uint32 public constant HOOK_VERSION = PerkConstants.HOOK_VERSION_V1;

    /// @inheritdoc IPerkComposableHook
    /// @dev 8 ticks is about 0.08%: the reference covers a 5% move in a minute and a halving or doubling in roughly
    ///      a quarter of an hour. Fast enough that an honest user waits minutes after a sharp move, slow enough that
    ///      steering it means carrying an off-market price through hundreds of blocks.
    uint24 public constant REFERENCE_MAX_TICKS_PER_SECOND = 8;

    IPoolManager internal immutable POOL_MANAGER;
    address public immutable feeRouter;
    address public immutable graduationManager;

    mapping(PoolId => PoolInfo) internal _pools;
    mapping(address meme => PoolId) internal _poolIdOf;
    mapping(PoolId => PriceReference) internal _references;

    error ZeroAddress();

    constructor(IPoolManager poolManager_, address feeRouter_, address graduationManager_) {
        if (address(poolManager_) == address(0) || feeRouter_ == address(0) || graduationManager_ == address(0)) {
            revert ZeroAddress();
        }
        POOL_MANAGER = poolManager_;
        feeRouter = feeRouter_;
        graduationManager = graduationManager_;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// @notice Permission set committed in the hook address (ADR-001, ADR-005).
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @inheritdoc IPerkComposableHook
    function poolManager() external view returns (address) {
        return address(POOL_MANAGER);
    }

    /// @inheritdoc IPerkComposableHook
    function registerPool(
        PoolKey calldata key,
        bytes32 launchId,
        address meme,
        bytes32 configHash,
        uint256 moduleBitmap,
        uint24 hookFeeBps
    ) external {
        if (msg.sender != graduationManager) revert NotGraduationManager();
        if (address(key.hooks) != address(this)) revert PoolKeyMismatch();

        bool memeIs0 = Currency.unwrap(key.currency0) == meme;
        if (!memeIs0 && Currency.unwrap(key.currency1) != meme) revert PoolKeyMismatch();
        Currency quote = memeIs0 ? key.currency1 : key.currency0;

        PoolId id = key.toId();
        if (_pools[id].registered) revert PoolAlreadyRegistered();
        if (PoolId.unwrap(_poolIdOf[meme]) != bytes32(0)) revert PoolAlreadyRegistered();

        _pools[id] = PoolInfo({
            launchId: launchId,
            meme: meme,
            quote: quote,
            configHash: configHash,
            moduleBitmap: moduleBitmap,
            hookFeeBps: hookFeeBps,
            memeIsCurrency0: memeIs0,
            registered: true,
            initialized: false
        });
        _poolIdOf[meme] = id;

        emit PoolRegistered(id, launchId, meme, quote, configHash, moduleBitmap, hookFeeBps);
    }

    /// @inheritdoc IPerkComposableHook
    function poolInfo(PoolId poolId) external view returns (PoolInfo memory) {
        return _pools[poolId];
    }

    /// @inheritdoc IPerkComposableHook
    function poolIdOf(address meme) external view returns (PoolId) {
        return _poolIdOf[meme];
    }

    // ---------------------------------------------------------------------
    // Official Pool Guard
    // ---------------------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        PoolInfo storage p = _pools[key.toId()];
        if (!p.registered) revert PoolNotRegistered();
        if (p.initialized) revert PoolAlreadyInitialized();
        if (sender != graduationManager) revert UnauthorizedInitializer(sender);
        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        PoolId id = key.toId();
        PoolInfo storage p = _pools[id];
        p.initialized = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        _references[id] = PriceReference({tick: tick, updatedAt: uint40(block.timestamp)});
        emit OfficialPoolRegistered(p.launchId, id, p.configHash, p.moduleBitmap);
        return IHooks.afterInitialize.selector;
    }

    // ---------------------------------------------------------------------
    // Quote Fee Router (ADR-001)
    // ---------------------------------------------------------------------

    /// @inheritdoc IHooks
    /// @dev Takes the hook fee when the quote is the *specified* currency: exact-in buy, exact-out sell.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        _followPrice(id); // before the swap moves it: the reference only ever learns prices that survived a block
        PoolInfo storage p = _pools[id];
        if (p.moduleBitmap & PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1 == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        bool exactIn = params.amountSpecified < 0;
        bool specifiedIs0 = exactIn == params.zeroForOne;
        bool quoteIs0 = !p.memeIsCurrency0;
        if (specifiedIs0 != quoteIs0) {
            // quote is the unspecified currency, afterSwap handles it
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // exactIn => amountSpecified < 0; the PoolManager never passes type(int256).min, so negation cannot overflow.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 amount = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = (amount * p.hookFeeBps) / PerkConstants.BPS;
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        _takeFee(id, p, fee, true);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    /// @inheritdoc IHooks
    /// @dev Takes the hook fee when the quote is the *unspecified* currency: exact-out buy, exact-in sell.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolInfo storage p = _pools[id];
        if (p.moduleBitmap & PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1 == 0) return (IHooks.afterSwap.selector, 0);

        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        bool quoteIs0 = !p.memeIsCurrency0;
        if (specifiedIs0 == quoteIs0) return (IHooks.afterSwap.selector, 0); // handled in beforeSwap

        int128 quoteDelta = quoteIs0 ? delta.amount0() : delta.amount1();
        // quoteDelta is an int128 swap delta; both branches cast a non-negative value.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 amount = quoteDelta < 0 ? uint256(uint128(-quoteDelta)) : uint256(uint128(quoteDelta));
        uint256 fee = (amount * p.hookFeeBps) / PerkConstants.BPS;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        _takeFee(id, p, fee, false);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    /// @dev Moves `fee` of quote from the PoolManager to the FeeRouter and accounts it. The positive delta returned
    ///      by the caller nets the take, so the hook itself never holds funds.
    function _takeFee(PoolId id, PoolInfo storage p, uint256 fee, bool inBeforeSwap) internal {
        emit HookFeeTaken(id, p.quote, fee, inBeforeSwap);
        POOL_MANAGER.take(p.quote, feeRouter, fee);
        IPerkFeeRouter(feeRouter).collectFee(p.meme, PerkTypes.FeeSource.HOOK, fee);
    }

    // ---------------------------------------------------------------------
    // Reference price
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkComposableHook
    function referencePrice(PoolId poolId) external view returns (int24 spotTick, int24 referenceTick) {
        PriceReference storage r = _references[poolId];
        (, spotTick,,) = POOL_MANAGER.getSlot0(poolId);
        referenceTick = _follow(r.tick, spotTick, block.timestamp - r.updatedAt);
    }

    /// @dev Once per timestamp, ahead of the first swap: step the reference towards the price the pool closed the
    ///      previous activity at. Later swaps in the same timestamp find `updatedAt` current and change nothing, so
    ///      nothing done inside a block can reach the reference before the block is over.
    function _followPrice(PoolId id) internal {
        PriceReference storage r = _references[id];
        if (r.updatedAt == block.timestamp) return;
        (, int24 spotTick,,) = POOL_MANAGER.getSlot0(id);
        r.tick = _follow(r.tick, spotTick, block.timestamp - r.updatedAt);
        // forge-lint: disable-next-line(unsafe-typecast)
        r.updatedAt = uint40(block.timestamp);
    }

    /// @dev `refTick` moved towards `spotTick` by at most `elapsed * REFERENCE_MAX_TICKS_PER_SECOND` ticks.
    function _follow(int24 refTick, int24 spotTick, uint256 elapsed) internal pure returns (int24) {
        // ticks span +-887272, so the gap fits 24 bits with room to spare
        int256 gap = int256(spotTick) - int256(refTick);
        uint256 distance = gap < 0 ? uint256(-gap) : uint256(gap);
        uint256 reach = elapsed * REFERENCE_MAX_TICKS_PER_SECOND;
        if (reach >= distance) return spotTick;
        // forge-lint: disable-next-line(unsafe-typecast)
        return gap < 0 ? refTick - int24(uint24(reach)) : refTick + int24(uint24(reach));
    }

    // ---------------------------------------------------------------------
    // Callbacks this hook does not subscribe to (ADR-005). Never reached because the address flags are off.
    // ---------------------------------------------------------------------

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
