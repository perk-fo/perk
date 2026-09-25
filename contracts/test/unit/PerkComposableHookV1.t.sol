// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {PerkComposableHookV1} from "../../src/hook/PerkComposableHookV1.sol";
import {IPerkComposableHook} from "../../src/interfaces/IPerkComposableHook.sol";
import {IPerkFeeRouter} from "../../src/interfaces/IPerkFeeRouter.sol";
import {FeeRouter} from "../../src/fees/FeeRouter.sol";
import {CommunityTreasury} from "../../src/treasury/CommunityTreasury.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {HookDeployer} from "../utils/HookDeployer.sol";
import {MockDistributor} from "../utils/MockDistributor.sol";
import {MockERC20} from "../utils/MockERC20.sol";

contract PerkComposableHookV1Test is Test, Deployers, HookDeployer {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 1500;
    uint24 internal constant HOOK_FEE_BPS = 85;
    uint24 internal constant TOTAL_FEE_BPS = 100;
    int24 internal constant TICK_SPACING = 60;
    int256 internal constant LIQUIDITY = 1e21;
    uint256 internal constant SPLIT_DENOM = 8500;

    PerkComposableHookV1 internal hook;
    FeeRouter internal feeRouter;
    MockDistributor internal distributor;
    CommunityTreasury internal treasury;

    address internal protocolFeeRecipient;
    address internal dev;
    address internal stranger;
    address internal swapper;
    address internal controlSwapper;

    bytes32 internal launchId;
    bytes32 internal configHash;

    PerkTypes.FeeSplit internal split;

    event OfficialPoolRegistered(
        bytes32 indexed launchId, PoolId indexed poolId, bytes32 configHash, uint256 moduleBitmap
    );
    event HookFeeTaken(PoolId indexed poolId, Currency indexed quote, uint256 amount, bool takenInBeforeSwap);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        protocolFeeRecipient = makeAddr("protocol");
        dev = makeAddr("dev");
        stranger = makeAddr("stranger");
        swapper = makeAddr("swapper");
        controlSwapper = makeAddr("controlSwapper");
        launchId = keccak256("launch");
        configHash = keccak256("config");
        split = PerkTypes.FeeSplit({devBps: 5000, rewardsBps: 2500, lpBps: 1500, treasuryBps: 500, protocolBps: 500});

        distributor = new MockDistributor();
        treasury = new CommunityTreasury(address(this), 1 days);
        feeRouter =
            new FeeRouter(address(this), address(this), address(distributor), address(treasury), protocolFeeRecipient);

        address hookAddr = predictedHookAddress();
        hook = deployHook(manager, address(feeRouter), address(this), hookAddr);
        feeRouter.wire(address(hook), address(this));

        vm.deal(address(this), 50_000 ether);
        _fundAccount(swapper, currency0, currency1);
        _fundAccount(controlSwapper, currency0, currency1);
    }

    // ---------------------------------------------------------------------
    // Guard
    // ---------------------------------------------------------------------

    function test_initialize_reverts_unregistered() public {
        PoolKey memory unreg = _hookKey(currency0, currency1, LP_FEE);
        _expectWrapped(
            IHooks.beforeInitialize.selector, abi.encodeWithSelector(IPerkComposableHook.PoolNotRegistered.selector)
        );
        manager.initialize(unreg, SQRT_PRICE_1_1);
    }

    function test_initialize_reverts_unauthorizedInitializer() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        address meme = Currency.unwrap(currency1);
        _registerLaunch(meme, currency0);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);

        _expectWrapped(
            IHooks.beforeInitialize.selector,
            abi.encodeWithSelector(IPerkComposableHook.UnauthorizedInitializer.selector, stranger)
        );
        vm.prank(stranger);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
    }

    function test_registerPool_reverts_notGraduationManager() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        vm.prank(stranger);
        vm.expectRevert(IPerkComposableHook.NotGraduationManager.selector);
        hook.registerPool(
            poolKey, launchId, Currency.unwrap(currency1), configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS
        );
    }

    function test_registerPool_reverts_hooksMismatch() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        poolKey.hooks = IHooks(address(0));
        vm.expectRevert(IPerkComposableHook.PoolKeyMismatch.selector);
        hook.registerPool(
            poolKey, launchId, Currency.unwrap(currency1), configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS
        );
    }

    function test_registerPool_reverts_memeNotInKey() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        vm.expectRevert(IPerkComposableHook.PoolKeyMismatch.selector);
        hook.registerPool(
            poolKey, launchId, makeAddr("notInPool"), configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS
        );
    }

    function test_registerPool_reverts_sameKeyTwice() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        address meme = Currency.unwrap(currency1);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        vm.expectRevert(IPerkComposableHook.PoolAlreadyRegistered.selector);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
    }

    function test_registerPool_reverts_secondKeySameMeme() public {
        address meme = Currency.unwrap(currency1);
        PoolKey memory first = _hookKey(currency0, currency1, LP_FEE);
        PoolKey memory second = _hookKey(currency0, currency1, 3000);
        hook.registerPool(first, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        vm.expectRevert(IPerkComposableHook.PoolAlreadyRegistered.selector);
        hook.registerPool(second, keccak256("launch2"), meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
    }

    function test_initialize_setsPoolInfoAndEmits() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        address meme = Currency.unwrap(currency1);
        _registerLaunch(meme, currency0);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        PoolId id = poolKey.toId();

        vm.expectEmit(true, true, false, true, address(hook));
        emit OfficialPoolRegistered(launchId, id, configHash, PerkConstants.CORE_MODULES_V1);
        manager.initialize(poolKey, SQRT_PRICE_1_1);

        IPerkComposableHook.PoolInfo memory info = hook.poolInfo(id);
        assertTrue(info.initialized);
        assertEq(PoolId.unwrap(hook.poolIdOf(meme)), PoolId.unwrap(id));
    }

    function test_initialize_reverts_alreadyInitialized() public {
        PoolKey memory poolKey = _hookKey(currency0, currency1, LP_FEE);
        address meme = Currency.unwrap(currency1);
        _registerLaunch(meme, currency0);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        manager.initialize(poolKey, SQRT_PRICE_1_1);

        _expectWrapped(
            IHooks.beforeInitialize.selector,
            abi.encodeWithSelector(IPerkComposableHook.PoolAlreadyInitialized.selector)
        );
        manager.initialize(poolKey, SQRT_PRICE_1_1);
    }

    function test_getHookPermissions_matchesFlags() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertTrue(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertTrue(p.beforeSwapReturnDelta);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
        assertEq(uint160(address(hook)) & uint160((1 << 14) - 1), HOOK_FLAGS);
    }

    function test_deploy_reverts_wrongFlags() public {
        address wrong = address((HOOK_FLAGS | Hooks.BEFORE_DONATE_FLAG) ^ (0x4444 << 144));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrong));
        deployHook(manager, address(feeRouter), address(this), wrong);
    }

    // ---------------------------------------------------------------------
    // Fees — ERC-20 quote, meme = currency1
    // ---------------------------------------------------------------------

    function test_swap_exactInBuy_erc20_memeCurrency1() public {
        _testExactInBuy(false);
    }

    function test_swap_exactOutBuy_erc20_memeCurrency1() public {
        _testExactOutBuy(false);
    }

    function test_swap_exactInSell_erc20_memeCurrency1() public {
        _testExactInSell(false);
    }

    function test_swap_exactOutSell_erc20_memeCurrency1() public {
        _testExactOutSell(false);
    }

    /// @dev Documented behaviour: when the quote is the specified currency the fee is fixed on the whole specified
    ///      amount before the swap runs. A binding price limit stops the swap early, and the swapper still pays the
    ///      fee on the part that never traded, which is why routers size exact-input buys instead of relying on one.
    function test_swap_exactInBuyWithABindingPriceLimit_paysTheFeeOnTheWholeSpecifiedAmount() public {
        (PoolKey memory poolKey,, Currency quoteC) = _setupErc20(false); // quote is currency0: a buy is zeroForOne
        uint256 specified = 100e18;
        uint256 fee = (specified * HOOK_FEE_BPS) / PerkConstants.BPS;
        uint160 limit = uint160((uint256(SQRT_PRICE_1_1) * 99) / 100);
        uint256 before = quoteC.balanceOf(swapper);

        vm.expectEmit(true, true, false, true, address(hook));
        emit HookFeeTaken(poolKey.toId(), quoteC, fee, true);
        vm.prank(swapper);
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(specified), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        (uint160 sqrtP,,,) = StateLibrary.getSlot0(manager, poolKey.toId());
        assertEq(sqrtP, limit, "the limit stopped the swap");
        uint256 paid = before - quoteC.balanceOf(swapper);
        assertLt(paid, specified / 5, "most of the specified amount never traded");
        uint256 traded = paid - fee;
        assertGt(fee * PerkConstants.BPS, traded * HOOK_FEE_BPS * 5, "the fee is far above 0.85% of what traded");
    }

    // ---------------------------------------------------------------------
    // Reference price
    // ---------------------------------------------------------------------

    function test_referencePrice_startsAtTheInitialTick() public {
        (PoolKey memory poolKey,,) = _setupErc20(false);
        (int24 spot, int24 ref) = hook.referencePrice(poolKey.toId());
        assertEq(ref, spot);
    }

    /// @dev Everything inside one timestamp is invisible to the reference: a swap, a second swap, and a read after
    ///      them all leave it on the price the pool held before the block's first swap.
    function test_referencePrice_ignoresSwapsWithinTheSameTimestamp() public {
        (PoolKey memory poolKey,,) = _setupErc20(false);
        (int24 spotBefore,) = hook.referencePrice(poolKey.toId());
        vm.warp(block.timestamp + 1 hours);

        _swap(poolKey, true, -50e18, 0);
        _swap(poolKey, true, -50e18, 0);
        (int24 spot, int24 ref) = hook.referencePrice(poolKey.toId());
        assertLt(spot, spotBefore - 500); // the price really moved
        assertEq(ref, spotBefore);
    }

    /// @dev Across timestamps the reference moves, but never faster than its limit, whether it is a swap or a read
    ///      that applies the elapsed time.
    function test_referencePrice_followsNoFasterThanTheLimit() public {
        (PoolKey memory poolKey,,) = _setupErc20(false);
        PoolId id = poolKey.toId();
        (int24 start,) = hook.referencePrice(id);
        uint24 speed = hook.REFERENCE_MAX_TICKS_PER_SECOND();
        vm.warp(block.timestamp + 1 hours);
        _swap(poolKey, true, -100e18, 0);
        (int24 spot,) = hook.referencePrice(id);

        vm.warp(block.timestamp + 10); // a read applies the elapsed time without any swap
        (, int24 ref) = hook.referencePrice(id);
        assertEq(ref, start - int24(speed) * 10);

        _swap(poolKey, true, -1e15, 0); // a swap persists the same step
        (, ref) = hook.referencePrice(id);
        assertEq(ref, start - int24(speed) * 10);

        vm.warp(block.timestamp + 5);
        _swap(poolKey, false, -1e15, 0);
        (, ref) = hook.referencePrice(id);
        assertEq(ref, start - int24(speed) * 15);

        vm.warp(block.timestamp + 1 days); // given time it arrives, and stops there
        (spot, ref) = hook.referencePrice(id);
        assertEq(ref, spot);
    }

    function test_referencePrice_followsUpwardsToo() public {
        (PoolKey memory poolKey,,) = _setupErc20(false);
        PoolId id = poolKey.toId();
        (int24 start,) = hook.referencePrice(id);
        vm.warp(block.timestamp + 1 hours);
        _swap(poolKey, false, -100e18, 0);
        (int24 spot,) = hook.referencePrice(id);
        assertGt(spot, start + 500);
        vm.warp(block.timestamp + 7);
        (, int24 ref) = hook.referencePrice(id);
        assertEq(ref, start + int24(hook.REFERENCE_MAX_TICKS_PER_SECOND()) * 7);
    }

    /// @dev The reference is kept for every official pool, fee module or not.
    function test_referencePrice_trackedWithFeeModuleDisabled() public {
        MockERC20 extra = new MockERC20("Meme2", "M2", 18);
        extra.mint(address(this), 1e30);
        extra.mint(swapper, 1e24);
        extra.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.prank(swapper);
        extra.approve(address(swapRouter), type(uint256).max);
        Currency memeC = Currency.wrap(address(extra));
        (Currency c0, Currency c1) = memeC < currency0 ? (memeC, currency0) : (currency0, memeC);
        PoolKey memory poolKey = _hookKey(c0, c1, LP_FEE);
        _registerLaunch(address(extra), currency0);
        uint256 bitmap = PerkConstants.CORE_MODULES_V1 & ~PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1;
        hook.registerPool(poolKey, keccak256("disabled-ref"), address(extra), configHash, bitmap, HOOK_FEE_BPS);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        _addLiquidity(poolKey);

        PoolId id = poolKey.toId();
        (int24 start,) = hook.referencePrice(id);
        vm.warp(block.timestamp + 1 hours);
        _swap(poolKey, true, -100e18, 0);
        vm.warp(block.timestamp + 3);
        _swap(poolKey, true, -1e15, 0);
        (, int24 ref) = hook.referencePrice(id);
        assertEq(ref, start - int24(hook.REFERENCE_MAX_TICKS_PER_SECOND()) * 3);
    }

    // ---------------------------------------------------------------------
    // Fees — ERC-20 quote, meme = currency0
    // ---------------------------------------------------------------------

    function test_swap_exactInBuy_erc20_memeCurrency0() public {
        _testExactInBuy(true);
    }

    function test_swap_exactOutBuy_erc20_memeCurrency0() public {
        _testExactOutBuy(true);
    }

    function test_swap_exactInSell_erc20_memeCurrency0() public {
        _testExactInSell(true);
    }

    function test_swap_exactOutSell_erc20_memeCurrency0() public {
        _testExactOutSell(true);
    }

    function test_swap_feeModuleDisabled_noHookFee() public {
        MockERC20 extra = new MockERC20("Meme2", "M2", 18);
        extra.mint(address(this), 1e30);
        extra.mint(swapper, 1e24);
        extra.approve(address(swapRouter), type(uint256).max);
        extra.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.prank(swapper);
        extra.approve(address(swapRouter), type(uint256).max);

        Currency memeC = Currency.wrap(address(extra));
        Currency quoteC = currency0;
        (Currency c0, Currency c1) = memeC < quoteC ? (memeC, quoteC) : (quoteC, memeC);
        PoolKey memory poolKey = _hookKey(c0, c1, LP_FEE);
        _registerLaunch(address(extra), quoteC);
        uint256 bitmap = PerkConstants.CORE_MODULES_V1 & ~PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1;
        hook.registerPool(poolKey, keccak256("disabled"), address(extra), configHash, bitmap, HOOK_FEE_BPS);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        _addLiquidity(poolKey);

        bool memeIs0 = Currency.unwrap(c0) == address(extra);
        bool buyZfo = !memeIs0;
        uint256 routerBefore = quoteC.balanceOf(address(feeRouter));
        uint256 distBefore = distributor.callCount();

        _swap(poolKey, buyZfo, -1e18, 0);
        _swap(poolKey, buyZfo, 1e18, 0);
        _swap(poolKey, !buyZfo, -1e18, 0);
        _swap(poolKey, !buyZfo, int256(1e17), 0);

        assertEq(quoteC.balanceOf(address(feeRouter)), routerBefore);
        assertEq(distributor.callCount(), distBefore);
        assertEq(feeRouter.launchFees(address(extra)).devClaimable, 0);
    }

    function test_swap_tinyAmount_doesNotCallFeeRouter() public {
        (PoolKey memory poolKey,,) = _setupErc20(false);
        vm.expectCall(address(feeRouter), abi.encodeWithSelector(IPerkFeeRouter.collectFee.selector), 0);
        _swap(poolKey, true, -100, 0);
    }

    // ---------------------------------------------------------------------
    // Fees — native quote
    // ---------------------------------------------------------------------

    function test_swap_exactInBuy_native() public {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupNative();
        uint256 fee = 8.5e15;
        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = Currency.wrap(meme).balanceOf(swapper);
        uint256 routerEth = address(feeRouter).balance;
        uint256 distEth = address(distributor).balance;
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.expectCall(address(feeRouter), 0, abi.encodeWithSelector(IPerkFeeRouter.collectFee.selector));
        vm.expectEmit(true, true, false, true, address(hook));
        emit HookFeeTaken(poolKey.toId(), quoteC, fee, true);
        _swap(poolKey, true, -1e18, 1e18);

        assertEq(swapperQ - quoteC.balanceOf(swapper), 1e18);
        assertGt(Currency.wrap(meme).balanceOf(swapper), swapperM);
        uint256 routerDelta = address(feeRouter).balance - routerEth;
        uint256 distDelta = address(distributor).balance - distEth;
        assertEq(routerDelta + distDelta, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        (,, uint256 recordedValue) = distributor.calls(distCalls);
        assertEq(recordedValue, Math.mulDiv(fee, 2500, SPLIT_DENOM));
    }

    function test_swap_exactInSell_native() public {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupNative();
        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = Currency.wrap(meme).balanceOf(swapper);
        uint256 routerEth = address(feeRouter).balance;
        uint256 distEth = address(distributor).balance;
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.expectCall(address(feeRouter), 0, abi.encodeWithSelector(IPerkFeeRouter.collectFee.selector));
        vm.recordLogs();
        _swap(poolKey, false, -1e18, 0);
        (uint256 fee, bool takenBefore, uint256 poolQuote) = _feeFromLogs(poolKey.toId(), true);

        assertFalse(takenBefore);
        assertEq(fee, (poolQuote * HOOK_FEE_BPS) / PerkConstants.BPS);
        assertEq(swapperM - Currency.wrap(meme).balanceOf(swapper), 1e18);
        assertEq(quoteC.balanceOf(swapper) - swapperQ, poolQuote - fee);
        uint256 routerDelta = address(feeRouter).balance - routerEth;
        uint256 distDelta = address(distributor).balance - distEth;
        assertEq(routerDelta + distDelta, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        (,, uint256 recordedValue) = distributor.calls(distCalls);
        assertEq(recordedValue, Math.mulDiv(fee, 2500, SPLIT_DENOM));
    }

    // ---------------------------------------------------------------------
    // Internal fee cases
    // ---------------------------------------------------------------------

    function _testExactInBuy(bool memeIsCurrency0) internal {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupErc20(memeIsCurrency0);
        Currency memeC = Currency.wrap(meme);
        bool zfo = !memeIsCurrency0;
        uint256 fee = 8.5e15;

        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = memeC.balanceOf(swapper);
        uint256 routerQ = quoteC.balanceOf(address(feeRouter));
        uint256 distQ = quoteC.balanceOf(address(distributor));
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.expectEmit(true, true, false, true, address(hook));
        emit HookFeeTaken(poolKey.toId(), quoteC, fee, true);
        _swap(poolKey, zfo, -1e18, 0, memeIsCurrency0 ? "" : "swap_exactInBuy_erc20");

        uint256 hookedQuoteAbs = swapperQ - quoteC.balanceOf(swapper);
        uint256 hookedMemeAbs = memeC.balanceOf(swapper) - swapperM;
        assertEq(hookedQuoteAbs, 1e18);
        uint256 received =
            (quoteC.balanceOf(address(feeRouter)) - routerQ) + (quoteC.balanceOf(address(distributor)) - distQ);
        assertEq(received, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        _assertNearOnePercent(poolKey, quoteC, memeC, zfo, -1e18, 0, hookedQuoteAbs, hookedMemeAbs);
    }

    function _testExactOutBuy(bool memeIsCurrency0) internal {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupErc20(memeIsCurrency0);
        Currency memeC = Currency.wrap(meme);
        bool zfo = !memeIsCurrency0;

        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = memeC.balanceOf(swapper);
        uint256 routerQ = quoteC.balanceOf(address(feeRouter));
        uint256 distQ = quoteC.balanceOf(address(distributor));
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.recordLogs();
        _swap(poolKey, zfo, int256(1e18), 0, memeIsCurrency0 ? "" : "swap_exactOutBuy_erc20");
        (uint256 fee, bool takenBefore, uint256 poolQuote) = _feeFromLogs(poolKey.toId(), !memeIsCurrency0);

        assertFalse(takenBefore);
        assertEq(fee, (poolQuote * HOOK_FEE_BPS) / PerkConstants.BPS);
        uint256 hookedQuoteAbs = swapperQ - quoteC.balanceOf(swapper);
        uint256 hookedMemeAbs = memeC.balanceOf(swapper) - swapperM;
        assertEq(hookedMemeAbs, 1e18);
        assertEq(hookedQuoteAbs, poolQuote + fee);
        uint256 received =
            (quoteC.balanceOf(address(feeRouter)) - routerQ) + (quoteC.balanceOf(address(distributor)) - distQ);
        assertEq(received, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        _assertNearOnePercent(poolKey, quoteC, memeC, zfo, int256(1e18), 0, hookedQuoteAbs, hookedMemeAbs);
    }

    function _testExactInSell(bool memeIsCurrency0) internal {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupErc20(memeIsCurrency0);
        Currency memeC = Currency.wrap(meme);
        bool zfo = memeIsCurrency0;

        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = memeC.balanceOf(swapper);
        uint256 routerQ = quoteC.balanceOf(address(feeRouter));
        uint256 distQ = quoteC.balanceOf(address(distributor));
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.recordLogs();
        _swap(poolKey, zfo, -1e18, 0, memeIsCurrency0 ? "" : "swap_exactInSell_erc20");
        (uint256 fee, bool takenBefore, uint256 poolQuote) = _feeFromLogs(poolKey.toId(), !memeIsCurrency0);

        assertFalse(takenBefore);
        assertEq(fee, (poolQuote * HOOK_FEE_BPS) / PerkConstants.BPS);
        uint256 hookedQuoteAbs = quoteC.balanceOf(swapper) - swapperQ;
        uint256 hookedMemeAbs = swapperM - memeC.balanceOf(swapper);
        assertEq(hookedMemeAbs, 1e18);
        assertEq(hookedQuoteAbs, poolQuote - fee);
        uint256 received =
            (quoteC.balanceOf(address(feeRouter)) - routerQ) + (quoteC.balanceOf(address(distributor)) - distQ);
        assertEq(received, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        _assertNearOnePercent(poolKey, quoteC, memeC, zfo, -1e18, 0, hookedQuoteAbs, hookedMemeAbs);
    }

    function _testExactOutSell(bool memeIsCurrency0) internal {
        (PoolKey memory poolKey, address meme, Currency quoteC) = _setupErc20(memeIsCurrency0);
        Currency memeC = Currency.wrap(meme);
        bool zfo = memeIsCurrency0;
        uint256 fee = 8.5e14;

        uint256 swapperQ = quoteC.balanceOf(swapper);
        uint256 swapperM = memeC.balanceOf(swapper);
        uint256 routerQ = quoteC.balanceOf(address(feeRouter));
        uint256 distQ = quoteC.balanceOf(address(distributor));
        uint256 distCalls = distributor.callCount();
        uint256 devBefore = feeRouter.launchFees(meme).devClaimable;

        vm.expectEmit(true, true, false, true, address(hook));
        emit HookFeeTaken(poolKey.toId(), quoteC, fee, true);
        _swap(poolKey, zfo, int256(1e17), 0, memeIsCurrency0 ? "" : "swap_exactOutSell_erc20");

        uint256 hookedQuoteAbs = quoteC.balanceOf(swapper) - swapperQ;
        uint256 hookedMemeAbs = swapperM - memeC.balanceOf(swapper);
        assertEq(hookedQuoteAbs, 1e17);
        uint256 received =
            (quoteC.balanceOf(address(feeRouter)) - routerQ) + (quoteC.balanceOf(address(distributor)) - distQ);
        assertEq(received, fee);
        assertEq(feeRouter.launchFees(meme).devClaimable - devBefore, Math.mulDiv(fee, 5000, SPLIT_DENOM));
        assertEq(distributor.callCount(), distCalls + 1);
        assertEq(distributor.lastAccrueAmount(), Math.mulDiv(fee, 2500, SPLIT_DENOM));
        _assertNearOnePercent(poolKey, quoteC, memeC, zfo, int256(1e17), 0, hookedQuoteAbs, hookedMemeAbs);
    }

    // ---------------------------------------------------------------------
    // Setup helpers
    // ---------------------------------------------------------------------

    function _setupErc20(bool memeIsCurrency0)
        internal
        returns (PoolKey memory poolKey, address meme, Currency quoteC)
    {
        meme = memeIsCurrency0 ? Currency.unwrap(currency0) : Currency.unwrap(currency1);
        quoteC = memeIsCurrency0 ? currency1 : currency0;
        distributor.setQuoteToken(IERC20(Currency.unwrap(quoteC)));
        poolKey = _hookKey(currency0, currency1, LP_FEE);
        _registerLaunch(meme, quoteC);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        _addLiquidity(poolKey);

        PoolKey memory control = PoolKey(currency0, currency1, 0, TICK_SPACING, IHooks(address(0)));
        manager.initialize(control, SQRT_PRICE_1_1);
        _addLiquidity(control);
    }

    function _setupNative() internal returns (PoolKey memory poolKey, address meme, Currency quoteC) {
        MockERC20 token = new MockERC20("Meme", "MEME", 18);
        token.mint(address(this), 1e30);
        token.mint(swapper, 1e24);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.prank(swapper);
        token.approve(address(swapRouter), type(uint256).max);

        meme = address(token);
        quoteC = CurrencyLibrary.ADDRESS_ZERO;
        poolKey = _hookKey(quoteC, Currency.wrap(meme), LP_FEE);
        _registerLaunch(meme, quoteC);
        hook.registerPool(poolKey, launchId, meme, configHash, PerkConstants.CORE_MODULES_V1, HOOK_FEE_BPS);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        _addLiquidity(poolKey);
        vm.deal(swapper, 10_000 ether);
    }

    function _hookKey(Currency c0, Currency c1, uint24 fee) internal view returns (PoolKey memory) {
        return PoolKey(c0, c1, fee, TICK_SPACING, IHooks(address(hook)));
    }

    function _registerLaunch(address meme, Currency quoteC) internal {
        feeRouter.registerLaunch(meme, quoteC, dev, address(0xC0FFEE), TOTAL_FEE_BPS, split);
    }

    function _addLiquidity(PoolKey memory poolKey) internal {
        ModifyLiquidityParams memory liq =
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: LIQUIDITY, salt: 0});
        uint256 value = poolKey.currency0.isAddressZero() ? 5000 ether : 0;
        modifyLiquidityRouter.modifyLiquidity{value: value}(poolKey, liq, ZERO_BYTES);
    }

    function _fundAccount(address account, Currency c0, Currency c1) internal {
        vm.deal(account, 10_000 ether);
        _fundToken(account, c0);
        _fundToken(account, c1);
    }

    function _fundToken(address account, Currency c) internal {
        if (c.isAddressZero()) return;
        IERC20 token = IERC20(Currency.unwrap(c));
        token.transfer(account, 1e24);
        vm.prank(account);
        token.approve(address(swapRouter), type(uint256).max);
    }

    function _swap(PoolKey memory poolKey, bool zeroForOne, int256 amountSpecified, uint256 value) internal {
        _swap(poolKey, zeroForOne, amountSpecified, value, "");
    }

    function _swap(
        PoolKey memory poolKey,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 value,
        string memory gasLabel
    ) internal {
        _swapAs(swapper, poolKey, zeroForOne, amountSpecified, value, gasLabel);
    }

    function _swapAs(address who, PoolKey memory poolKey, bool zeroForOne, int256 amountSpecified, uint256 value)
        internal
    {
        _swapAs(who, poolKey, zeroForOne, amountSpecified, value, "");
    }

    function _swapAs(
        address who,
        PoolKey memory poolKey,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 value,
        string memory gasLabel
    ) internal {
        vm.startPrank(who);
        bool meter = bytes(gasLabel).length != 0;
        if (meter) vm.startSnapshotGas(gasLabel);
        swapRouter.swap{value: value}(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        if (meter) emit log_named_uint(gasLabel, vm.stopSnapshotGas());
        vm.stopPrank();
    }

    function _assertNearOnePercent(
        PoolKey memory hooked,
        Currency quoteC,
        Currency memeC,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 value,
        uint256 hookedQuoteAbs,
        uint256 hookedMemeAbs
    ) internal {
        PoolKey memory control = PoolKey(hooked.currency0, hooked.currency1, 0, TICK_SPACING, IHooks(address(0)));
        uint256 cq = quoteC.balanceOf(controlSwapper);
        uint256 cm = memeC.balanceOf(controlSwapper);
        _swapAs(controlSwapper, control, zeroForOne, amountSpecified, value);
        uint256 controlQuoteAbs = _absDiff(cq, quoteC.balanceOf(controlSwapper));
        uint256 controlMemeAbs = _absDiff(cm, memeC.balanceOf(controlSwapper));

        bool specifiedIs0 = (amountSpecified < 0) == zeroForOne;
        bool quoteIs0 = Currency.unwrap(quoteC) == Currency.unwrap(hooked.currency0);
        if (specifiedIs0 == quoteIs0) {
            assertEq(hookedQuoteAbs, controlQuoteAbs);
            _assertBpsBand(controlMemeAbs, hookedMemeAbs);
        } else {
            assertEq(hookedMemeAbs, controlMemeAbs);
            _assertBpsBand(controlQuoteAbs, hookedQuoteAbs);
        }
    }

    function _assertBpsBand(uint256 baseline, uint256 other) internal pure {
        uint256 delta = baseline > other ? baseline - other : other - baseline;
        assertGe(delta * PerkConstants.BPS, baseline * 99);
        assertLe(delta * PerkConstants.BPS, baseline * 101);
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _feeFromLogs(PoolId id, bool quoteIs0)
        internal
        view
        returns (uint256 fee, bool takenBefore, uint256 poolQuote)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool foundFee;
        bool foundSwap;
        int128 amount0;
        int128 amount1;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == HookFeeTaken.selector) {
                assertEq(logs[i].topics[1], PoolId.unwrap(id));
                (fee, takenBefore) = abi.decode(logs[i].data, (uint256, bool));
                foundFee = true;
            }
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == IPoolManager.Swap.selector) {
                (amount0, amount1,,,,) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                foundSwap = true;
            }
        }
        assertTrue(foundFee);
        assertTrue(foundSwap);
        int128 quoteDelta = quoteIs0 ? amount0 : amount1;
        poolQuote = quoteDelta < 0 ? uint256(uint128(-quoteDelta)) : uint256(uint128(quoteDelta));
    }

    function _expectWrapped(bytes4 hookFn, bytes memory reason) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                hookFn,
                reason,
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }
}
