// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {SlippageCheck} from "v4-periphery/src/libraries/SlippageCheck.sol";

import {InitialLpLocker} from "../../src/graduation/InitialLpLocker.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {IPerkComposableHook} from "../../src/interfaces/IPerkComposableHook.sol";
import {IPerkBondingCurve} from "../../src/interfaces/IPerkBondingCurve.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkMemeToken} from "../../src/token/PerkMemeToken.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkDeployer} from "../utils/PerkDeployer.sol";

contract GraduationManagerTest is PerkDeployer, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    bytes32 internal constant SALT = keccak256("grad-salt");
    uint256 internal constant BUY_GROSS = 200 ether;
    uint256 internal constant SWAP_IN = 1e18;

    Topology internal t;
    address internal creator;
    address internal buyer;
    address internal swapper;
    address internal stranger;

    event GraduationStageAdvanced(address indexed meme, IPerkGraduationManager.Stage stage);
    event LaunchGraduated(
        address indexed meme,
        bytes32 indexed launchId,
        PoolId indexed poolId,
        uint256 memeToPool,
        uint256 quoteToPool,
        uint128 liquidity
    );
    event LeftoverHandled(address indexed meme, uint256 memeBurned, uint256 quoteInRangeOrder);
    event HookFeeTaken(PoolId indexed poolId, Currency indexed quote, uint256 amount, bool takenInBeforeSwap);

    function setUp() public {
        deployFreshManagerAndRouters();
        creator = makeAddr("creator");
        buyer = makeAddr("buyer");
        swapper = makeAddr("swapper");
        stranger = makeAddr("stranger");
        vm.deal(creator, 1000 ether);
        vm.deal(buyer, 1000 ether);
        vm.deal(swapper, 1000 ether);

        t = deployPerkV1(address(this), address(manager));
        t.quoteToken.mint(creator, 1_000_000 ether);
        t.quoteToken.mint(buyer, 1_000_000 ether);
        t.quoteToken.mint(swapper, 1_000_000 ether);
        vm.prank(creator);
        t.quoteToken.approve(address(t.factory), type(uint256).max);
        vm.prank(buyer);
        t.quoteToken.approve(address(t.curve), type(uint256).max);
        vm.prank(swapper);
        t.quoteToken.approve(address(swapRouter), type(uint256).max);
    }

    function test_graduate_reverts_notGraduationPending() public {
        address meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT);
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.graduate(meme);
    }

    function test_graduate_happyPath_perkErc20() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, SALT);
        _assertHappyPath(meme, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, "graduate_perk_erc20");
    }

    function test_graduate_happyPath_standardErc20_leftoverLargerBy15pct() public {
        address perkMeme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("perk-a"));
        uint256 perkLeftover = _expectedMemeLeftover(perkMeme);
        t.graduation.graduate(perkMeme);
        IPerkGraduationManager.Graduation memory perkG = t.graduation.graduationOf(perkMeme);

        address stdMeme = _createAndFill(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("std-a"));
        uint256 stdLeftover = _expectedMemeLeftover(stdMeme);
        uint256 supplyBefore = IERC20(stdMeme).totalSupply();
        t.graduation.graduate(stdMeme);
        IPerkGraduationManager.Graduation memory stdG = t.graduation.graduationOf(stdMeme);

        uint256 extra = t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1).supply.totalSupply
            * 1500 / PerkConstants.BPS;
        assertEq(
            t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1).supply.poolReserveSupply
                - t.templateRegistry.getTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1).supply.poolReserveSupply,
            extra
        );
        assertEq(stdG.memeReceived - perkG.memeReceived, extra);
        // Same Q for both launches. lpReserve can seed extra meme into Standard, so leftover
        // grows by exactly 15% of supply minus any extra memeToPool.
        uint256 extraSeeded = stdG.memeToPool > perkG.memeToPool ? stdG.memeToPool - perkG.memeToPool : 0;
        assertEq(stdLeftover, perkLeftover + extra - extraSeeded);
        assertEq(stdG.memeLeftover, perkG.memeLeftover + extra - extraSeeded);
        uint256 burned = supplyBefore - IERC20(stdMeme).totalSupply();
        assertGe(burned, stdG.memeLeftover);
        _assertGraduated(stdMeme, t.erc20Quote);
    }

    function test_graduate_happyPath_nativeQuote() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.nativeQuote, keccak256("native-a"));
        _assertHappyPath(meme, PerkConstants.TEMPLATE_PERK_GRANT_V1, t.nativeQuote, "graduate_perk_native");
    }

    /// @dev Graduation is atomic: a failure while seeding the pool reverts the whole call, the curve keeps its funds
    ///      and no pool exists. Once the failure clears, the launch graduates in full.
    function test_graduate_revertsAsAWhole_whenSeedingFails_thenGraduatesInFull() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("resume-a"));
        uint256 curveQuote = t.erc20Quote.balanceOf(address(t.curve));

        vm.mockCallRevert(
            address(t.positionManager),
            abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector),
            "LIQUIDITY_ADDED"
        );
        vm.expectRevert(bytes("LIQUIDITY_ADDED"));
        t.graduation.graduate(meme);
        _assertUntouched(meme, t.erc20Quote);
        assertEq(t.erc20Quote.balanceOf(address(t.curve)), curveQuote, "the curve still holds the raise");

        vm.clearMockedCalls();
        t.graduation.graduate(meme);
        _assertGraduated(meme, t.erc20Quote);
    }

    /// @dev Nothing is swallowed: the caller sees the failing call's own revert data, whichever step it came from.
    function test_graduate_reverts_withTheFailingCallsReason() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("failed-event"));
        vm.mockCallRevert(address(manager), abi.encodeWithSelector(IPoolManager.initialize.selector), "INIT");
        vm.expectRevert(bytes("INIT"));
        t.graduation.graduate(meme);
        vm.clearMockedCalls();

        vm.mockCallRevert(address(t.vault), abi.encodeWithSelector(IPerkLPGrantVault.initCampaign.selector), "CAMPAIGN");
        vm.expectRevert(bytes("CAMPAIGN"));
        t.graduation.graduate(meme);
        _assertUntouched(meme, t.erc20Quote);
    }

    /// @dev Security: a graduation split by a gas-limited call. With stages committed one by one, a caller who gave
    ///      `graduate` just too little gas stopped it after the pool was initialised and before it was seeded; the
    ///      empty official pool could then be moved to any price for free, and the resumed mint seeded it there,
    ///      selling the leftover meme meant for the burn at a fraction of the curve's price. Every gas limit across
    ///      the whole range now either graduates the launch in full or leaves it exactly as it was, with no pool.
    function test_graduate_underEveryGasLimit_isAllOrNothing_standardErc20() public {
        _assertAllOrNothingUnderGasLimits(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, 7919);
    }

    function test_graduate_underEveryGasLimit_isAllOrNothing_perkNative() public {
        _assertAllOrNothingUnderGasLimits(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.nativeQuote, 24_989);
    }

    function _assertAllOrNothingUnderGasLimits(bytes32 templateId, Currency quote, uint256 step) internal {
        address meme = _createAndFill(templateId, quote, keccak256(abi.encode("gas-sweep", templateId)));

        uint256 snap = vm.snapshotState();
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory honest = t.graduation.graduationOf(meme);
        uint256 honestSupply = IERC20(meme).totalSupply();
        vm.revertToState(snap);

        uint256 successes;
        uint256 failures;
        for (uint256 gasLimit = 60_000; gasLimit < 3_200_000; gasLimit += step) {
            snap = vm.snapshotState();
            (bool ok,) =
                address(t.graduation).call{gas: gasLimit}(abi.encodeCall(IPerkGraduationManager.graduate, (meme)));
            if (ok) {
                ++successes;
                _assertGraduated(meme, quote);
                IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
                assertEq(g.liquidity, honest.liquidity, "seeded exactly as an honest graduation");
                assertEq(IERC20(meme).totalSupply(), honestSupply, "the whole leftover was burned");
            } else {
                ++failures;
                _assertUntouched(meme, quote);
                // and nothing is there to be priced: the official pool was never initialised
                (uint160 sqrtP,,,) = manager.getSlot0(honest.poolId);
                assertEq(sqrtP, 0);
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0);
        assertGt(failures, 0);
    }

    /// @dev The empty-pool attack itself: a 1-wei swap cannot reach the official pool before graduation, because it
    ///      does not exist until the same call that seeds it; after graduation it holds the full seed at the planned
    ///      price, so there is nothing cheap to buy back.
    function test_graduate_leavesNoEmptyOfficialPoolToPrice() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("empty"));
        uint256 snap = vm.snapshotState();
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        vm.revertToState(snap);
        bool quoteIs0 = g.key.currency0 == t.erc20Quote;

        vm.prank(buyer);
        IERC20(meme).transfer(swapper, 1);
        vm.startPrank(swapper);
        IERC20(meme).approve(address(swapRouter), type(uint256).max);
        vm.expectRevert(); // PoolNotInitialized: there is no pool to move
        swapRouter.swap(
            g.key,
            SwapParams({
                zeroForOne: !quoteIs0,
                amountSpecified: -1,
                sqrtPriceLimitX96: quoteIs0
                    ? uint160(Math.mulDiv(g.sqrtPriceX96, 17_500, 10_000))
                    : uint160(Math.mulDiv(g.sqrtPriceX96, 10_000, 17_500))
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        vm.stopPrank();

        t.graduation.graduate(meme);
        (uint160 sqrtP,,,) = manager.getSlot0(g.poolId);
        assertEq(sqrtP, g.sqrtPriceX96, "the pool opens at the curve's final price");
        assertGt(manager.getLiquidity(g.poolId), 0, "and opens seeded");
    }

    /// @dev The seeding step refuses a pool that is not at the planned price, rather than minting into it.
    function test_graduate_reverts_whenThePoolIsNotAtThePlannedPrice() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("mismatch"));
        IPerkGraduationManager.Graduation memory plan = _plan(meme);
        uint160 other = plan.sqrtPriceX96 / 2;
        vm.mockCall(
            address(manager),
            abi.encodeWithSignature("extsload(bytes32)", _poolStateSlot(plan.poolId)),
            abi.encode(bytes32(uint256(other)))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IPerkGraduationManager.PoolPriceMismatch.selector, other, plan.sqrtPriceX96)
        );
        t.graduation.graduate(meme);
    }

    /// @dev Defence in depth: even with the pool at another price and the price check blinded to it, the mint cannot
    ///      take more of either token than the plan. At a meme price three times too cheap, seeding the planned
    ///      liquidity would need far more meme than planned (the leftover meant for the burn); the cap refuses it.
    function test_graduate_seedMint_isCappedAtThePlannedAmounts() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("capped"));
        IPerkGraduationManager.Graduation memory plan = _plan(meme);
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);
        bool quoteIs0 = plan.key.currency0 == t.erc20Quote;
        uint160 cheap = quoteIs0
            ? uint160(Math.mulDiv(plan.sqrtPriceX96, 17_500, 10_000))
            : uint160(Math.mulDiv(plan.sqrtPriceX96, 10_000, 17_500));

        // the official pool, forced into existence at the cheap price (only the manager could do this for real)
        vm.startPrank(t.graduationManager);
        t.hook.registerPool(plan.key, rec.launchId, meme, rec.configHash, rec.moduleBitmap, 85);
        manager.initialize(plan.key, cheap);
        vm.stopPrank();
        // the manager's own register/initialise calls pass through, and its price check reads the planned price
        vm.mockCall(address(t.hook), abi.encodeWithSelector(IPerkComposableHook.registerPool.selector), "");
        vm.mockCall(address(manager), abi.encodeWithSelector(IPoolManager.initialize.selector), abi.encode(int24(0)));
        vm.mockCall(
            address(manager),
            abi.encodeWithSignature("extsload(bytes32)", _poolStateSlot(plan.poolId)),
            abi.encode(bytes32(uint256(plan.sqrtPriceX96)))
        );
        vm.expectPartialRevert(SlippageCheck.MaximumAmountExceeded.selector);
        t.graduation.graduate(meme);
    }

    /// @dev Security: the final stage must never be the one that strands a launch. Here a launch is recorded at
    ///      LIQUIDITY_ADDED with a leftover larger than the meme the manager holds (what the split graduation used to
    ///      produce) and quote still held for it. `graduate` completes it: it burns what there is, marks the launch
    ///      GRADUATED and sweeps the quote, instead of reverting on the burn forever.
    function test_graduate_completesALaunchAtLiquidityAdded_andDoneCannotFailOnTheBurn() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("done"));
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);

        // rewind to LIQUIDITY_ADDED: launch pending again, leftover larger than the balance, quote stranded
        bytes32 base = keccak256(abi.encode(meme, uint256(3))); // GraduationManager._graduations
        vm.store(t.graduationManager, base, bytes32(uint256(uint8(IPerkGraduationManager.Stage.LIQUIDITY_ADDED))));
        vm.store(t.graduationManager, bytes32(uint256(base) + 10), bytes32(g.memeLeftover * 2)); // memeLeftover
        vm.store(t.graduationManager, bytes32(uint256(base) + 15), bytes32(uint256(7 ether))); // quoteHeld
        t.quoteToken.mint(t.graduationManager, 7 ether);
        uint256 memeHeld = 1000 ether;
        vm.prank(buyer);
        IERC20(meme).transfer(t.graduationManager, memeHeld);
        _setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING);
        IPerkGraduationManager.Graduation memory stuck = t.graduation.graduationOf(meme);
        assertEq(uint256(stuck.stage), uint256(IPerkGraduationManager.Stage.LIQUIDITY_ADDED));
        assertEq(stuck.memeLeftover, g.memeLeftover * 2);
        assertEq(stuck.quoteHeld, 7 ether);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));

        uint256 treasuryBefore = t.erc20Quote.balanceOf(address(t.treasury));
        uint256 supplyBefore = IERC20(meme).totalSupply();
        vm.expectEmit(true, false, false, true, t.graduationManager);
        emit LeftoverHandled(meme, memeHeld, g.quoteLeftover);
        vm.prank(stranger); // permissionless
        t.graduation.graduate(meme);

        _assertGraduated(meme, t.erc20Quote);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), memeHeld, "burned what was there, no more");
        assertEq(t.erc20Quote.balanceOf(address(t.treasury)) - treasuryBefore, 7 ether, "stranded quote swept");
        assertEq(t.graduation.graduationOf(meme).quoteHeld, 0);
    }

    /// @dev Security: the manager holds the funds of every launch it is refunding, in one balance per quote currency.
    ///      A launch that graduates must take only what is its own. It used to sweep the manager's whole quote
    ///      balance to the treasury as "dust", which emptied every other launch's funds.
    function test_graduate_doesNotTouchAnotherLaunchsParkedFunds_erc20() public {
        _assertParkedFundsSurvive(t.erc20Quote);
    }

    function test_graduate_doesNotTouchAnotherLaunchsParkedFunds_native() public {
        _assertParkedFundsSurvive(t.nativeQuote);
    }

    function _assertParkedFundsSurvive(Currency quote) internal {
        address parked = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, keccak256("parked"));
        address other = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, keccak256("other"));

        // `parked` is rescued: its quote now sits in the manager for its holders to redeem
        t.graduation.proposeRescue(parked);
        vm.warp(vm.getBlockTimestamp() + RESCUE_DELAY);
        t.graduation.executeRescue(parked);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(parked);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.REFUNDING));
        uint256 parkedQuote = g.quoteHeld;
        assertGt(parkedQuote, 0);
        assertEq(quote.balanceOf(t.graduationManager), parkedQuote);

        // another launch on the same quote graduates start to finish in the meantime
        t.graduation.graduate(other);
        _assertGraduated(other, quote, parkedQuote);
        assertEq(t.graduation.graduationOf(other).quoteHeld, 0);
        assertEq(quote.balanceOf(t.graduationManager), parkedQuote, "the parked launch's quote was swept");

        // and the parked launch's holder still redeems everything it was owed
        uint256 bal = IERC20(parked).balanceOf(buyer);
        uint256 before = quote.balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(parked).approve(t.graduationManager, bal);
        t.graduation.redeem(parked, bal);
        vm.stopPrank();
        assertEq(quote.balanceOf(buyer) - before, parkedQuote);
        assertEq(quote.balanceOf(t.graduationManager), 0); // nothing of anyone's is left behind either
    }

    function test_graduate_swapTakesHookFee() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("swap-a"));
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);

        uint256 routerBefore = t.erc20Quote.balanceOf(address(t.feeRouter));
        bool quoteIs0 = g.key.currency0 == t.erc20Quote;
        vm.expectEmit(true, true, false, false, address(t.hook));
        emit HookFeeTaken(g.poolId, t.erc20Quote, 0, true);
        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);
        assertGt(t.erc20Quote.balanceOf(address(t.feeRouter)), routerBefore);
    }

    function test_collectFees_sendsToDev() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("fees-a"));
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        bool quoteIs0 = g.key.currency0 == t.erc20Quote;

        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);
        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);
        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);

        address dev = t.feeRouter.launchFees(meme).dev;
        assertEq(dev, creator);
        uint256 beforeQ = t.erc20Quote.balanceOf(dev);
        uint256 treasuryBefore = t.erc20Quote.balanceOf(address(t.treasury));
        t.locker.collectFees(g.positionTokenId);
        assertGt(t.erc20Quote.balanceOf(dev), beforeQ);
        assertEq(t.erc20Quote.balanceOf(address(t.treasury)), treasuryBefore);
        assertEq(IERC721(address(t.positionManager)).ownerOf(g.positionTokenId), address(t.locker));
        assertGt(t.positionManager.getPositionLiquidity(g.positionTokenId), 0);
    }

    function test_locker_reverts_onERC721Received_notPositionManager() public {
        vm.expectRevert(InitialLpLocker.NotPositionManager.selector);
        t.locker.onERC721Received(stranger, stranger, 1, "");
    }

    function test_locker_cannotMoveNft() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("nft-a"));
        t.graduation.graduate(meme);
        uint256 tokenId = t.graduation.graduationOf(meme).positionTokenId;

        vm.prank(stranger);
        vm.expectRevert();
        IERC721(address(t.positionManager)).transferFrom(address(t.locker), stranger, tokenId);

        vm.prank(stranger);
        vm.expectRevert();
        IERC721(address(t.positionManager)).safeTransferFrom(address(t.locker), stranger, tokenId);

        assertEq(IERC721(address(t.positionManager)).ownerOf(tokenId), address(t.locker));
        assertGt(t.positionManager.getPositionLiquidity(tokenId), 0);
    }

    function test_wire_reverts_alreadyWired() public {
        vm.expectRevert(IPerkGraduationManager.AlreadyWired.selector);
        t.graduation.wire(address(t.hook));
    }

    function _assertHappyPath(address meme, bytes32 templateId, Currency quote, string memory gasLabel) internal {
        uint256 expectedLeftover = _expectedMemeLeftover(meme);
        uint256 supplyBefore = IERC20(meme).totalSupply();
        PerkTypes.LaunchRecord memory rec = t.factory.getLaunch(meme);

        vm.startSnapshotGas(gasLabel);
        t.graduation.graduate(meme);
        emit log_named_uint(gasLabel, vm.stopSnapshotGas());

        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(g.memeLeftover, expectedLeftover);
        uint256 burned = supplyBefore - IERC20(meme).totalSupply();
        assertGe(burned, expectedLeftover);

        (uint160 sqrtPrice, int24 tick,,) = manager.getSlot0(g.poolId);
        assertEq(sqrtPrice, g.sqrtPriceX96);
        int24 expectedTick = TickMath.getTickAtSqrtPrice(g.sqrtPriceX96);
        int24 spacing = t.templateRegistry.getTemplate(templateId).pool.tickSpacing;
        int256 tickDelta = int256(tick) - int256(expectedTick);
        if (tickDelta < 0) tickDelta = -tickDelta;
        assertLe(uint256(tickDelta), uint256(int256(spacing)));

        uint256 priceX18 = t.curve.priceX18(meme);
        bool quoteIs0 = quote == g.key.currency0;
        uint160 fromPrice = _expectedSqrt(priceX18, quoteIs0);
        int24 priceTick = TickMath.getTickAtSqrtPrice(fromPrice);
        int256 priceDelta = int256(tick) - int256(priceTick);
        if (priceDelta < 0) priceDelta = -priceDelta;
        assertLe(uint256(priceDelta), uint256(int256(spacing)));

        assertEq(IERC721(address(t.positionManager)).ownerOf(g.positionTokenId), address(t.locker));
        if (g.quoteOnlyPositionTokenId != 0) {
            assertEq(IERC721(address(t.positionManager)).ownerOf(g.quoteOnlyPositionTokenId), address(t.locker));
        }
        rec = t.factory.getLaunch(meme);
        assertEq(uint256(rec.status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertEq(PoolId.unwrap(rec.poolId), PoolId.unwrap(g.poolId));
        assertTrue(t.hook.poolInfo(g.poolId).initialized);
        assertEq(IERC20(meme).balanceOf(t.graduationManager), 0);
        assertEq(quote.balanceOf(t.graduationManager), 0);
    }

    function _assertGraduated(address meme, Currency quote) internal view {
        _assertGraduated(meme, quote, 0);
    }

    /// @dev `othersQuote`: quote the manager holds for other launches, which must still be there.
    function _assertGraduated(address meme, Currency quote, uint256 othersQuote) internal view {
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertTrue(t.hook.poolInfo(g.poolId).initialized);
        assertEq(IERC20(meme).balanceOf(t.graduationManager), 0);
        assertEq(quote.balanceOf(t.graduationManager), othersQuote);
        assertEq(IERC721(address(t.positionManager)).ownerOf(g.positionTokenId), address(t.locker));
    }

    /// @dev Pending, at stage NONE, nothing moved: the curve still holds everything and there is no pool.
    function _assertUntouched(address meme, Currency quote) internal view {
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.NONE));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
        assertEq(IERC20(meme).balanceOf(t.graduationManager), 0);
        assertEq(quote.balanceOf(t.graduationManager), 0);
        assertEq(PoolId.unwrap(t.hook.poolIdOf(meme)), bytes32(0), "no official pool registered");
        assertFalse(t.curve.curveState(meme).finalized);
    }

    /// @dev What an honest graduation of `meme` would record, without graduating it.
    function _plan(address meme) internal returns (IPerkGraduationManager.Graduation memory plan) {
        uint256 snap = vm.snapshotState();
        t.graduation.graduate(meme);
        plan = t.graduation.graduationOf(meme);
        vm.revertToState(snap);
    }

    function _poolStateSlot(PoolId poolId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PoolId.unwrap(poolId), bytes32(uint256(6)))); // StateLibrary.POOLS_SLOT
    }

    /// @dev LaunchFactory._launches[meme].status: slot 10 mapping, record word 9, byte offset 21.
    function _setLaunchStatus(address meme, PerkTypes.LaunchStatus status) internal {
        bytes32 slot = bytes32(uint256(keccak256(abi.encode(meme, uint256(10)))) + 9);
        uint256 word = uint256(vm.load(address(t.factory), slot));
        word = (word & ~(uint256(0xff) << 168)) | (uint256(uint8(status)) << 168);
        vm.store(address(t.factory), slot, bytes32(word));
    }

    function _expectedMemeLeftover(address meme) internal view returns (uint256) {
        IPerkBondingCurve.CurveState memory st = t.curve.curveState(meme);
        IPerkBondingCurve.CurveConfig memory cfg = t.curve.curveConfig(meme);
        uint256 m = (cfg.curveSupply - st.memeSold) + cfg.poolReserveSupply;
        uint256 q = st.realQuote + t.feeRouter.launchFees(meme).lpReserve;
        uint256 cap = Math.mulDiv(q, st.virtualMeme, st.virtualQuote); // same reserve ratio the manager seeds with
        uint256 memeToPool = cap < m ? cap : m;
        return m - memeToPool;
    }

    function _expectedSqrt(uint256 priceX18, bool quoteIs0) internal pure returns (uint160) {
        uint256 q96 = uint256(1) << 96;
        uint256 ratioX192 = quoteIs0
            ? Math.mulDiv(Math.mulDiv(1e18, q96, priceX18), q96, 1)
            : Math.mulDiv(Math.mulDiv(priceX18, q96, 1e18), q96, 1);
        uint256 sqrt_ = Math.sqrt(ratioX192);
        uint256 minP = uint256(TickMath.MIN_SQRT_PRICE) + 1;
        uint256 maxP = uint256(TickMath.MAX_SQRT_PRICE) - 1;
        if (sqrt_ < minP) sqrt_ = minP;
        if (sqrt_ > maxP) sqrt_ = maxP;
        return uint160(sqrt_);
    }

    function _createAndFill(bytes32 templateId, Currency quote, bytes32 salt) internal returns (address meme) {
        meme = _createLaunch(templateId, quote, salt);
        _buyToGraduation(meme, quote);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
    }

    function _createLaunch(bytes32 templateId, Currency quote, bytes32 salt) internal returns (address meme) {
        PerkTypes.CreateLaunchParams memory p;
        p.templateId = templateId;
        p.quote = quote;
        p.moduleParams = "";
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.devBuyQuote = 0;
        p.salt = salt;
        vm.prank(creator);
        (,,, bytes32 configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (meme,) = t.factory.createLaunch(p);
    }

    function _buyToGraduation(address meme, Currency quote) internal {
        if (quote.isAddressZero()) {
            vm.prank(buyer);
            t.curve.buy{value: BUY_GROSS}(meme, BUY_GROSS, 0, buyer);
        } else {
            vm.prank(buyer);
            t.curve.buy(meme, BUY_GROSS, 0, buyer);
        }
    }

    function _swapQuoteIn(PoolKey memory key, bool quoteIs0, uint256 amount, uint256 value) internal {
        vm.prank(swapper);
        swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }
}
