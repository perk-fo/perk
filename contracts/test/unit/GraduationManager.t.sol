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

import {InitialLpLocker} from "../../src/graduation/InitialLpLocker.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {IPerkComposableHook} from "../../src/interfaces/IPerkComposableHook.sol";
import {IPerkBondingCurve} from "../../src/interfaces/IPerkBondingCurve.sol";
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

    function test_graduate_resumable_liquidityAddedFails() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("resume-a"));

        vm.mockCallRevert(
            address(t.positionManager),
            abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector),
            "LIQUIDITY_ADDED"
        );
        // Liquidity stage reverts inside a self-call; FUNDED + POOL_INITIALIZED stay committed.
        t.graduation.graduate(meme);

        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.POOL_INITIALIZED));
        assertGt(g.memeReceived, 0);
        assertGt(IERC20(meme).balanceOf(t.graduationManager), 0);
        assertGt(t.erc20Quote.balanceOf(t.graduationManager), 0);

        vm.clearMockedCalls();
        t.graduation.graduate(meme);
        g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        _assertGraduated(meme, t.erc20Quote);
    }

    /// @dev `graduate` succeeds even when a stage reverted, so the failure has to be visible on chain some other way.
    function test_graduate_emitsStageFailed_withTheRevertData() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("failed-event"));
        vm.mockCallRevert(
            address(t.positionManager), abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector), "STALL"
        );
        vm.expectEmit(true, false, false, true, address(t.graduation));
        emit IPerkGraduationManager.GraduationStageFailed(
            meme, IPerkGraduationManager.Stage.POOL_INITIALIZED, bytes("STALL")
        );
        t.graduation.graduate(meme);
    }

    /// @dev Security: the manager holds the funds of every launch that is between stages, in one balance per quote
    ///      currency. A launch that finishes must take only what is its own. It used to sweep the manager's whole
    ///      quote balance to the treasury as "dust", which emptied every other launch parked at FUNDED or
    ///      POOL_INITIALIZED and left it unable to ever add liquidity.
    function test_graduate_doesNotTouchAnotherLaunchsParkedFunds_erc20() public {
        _assertParkedFundsSurvive(t.erc20Quote);
    }

    function test_graduate_doesNotTouchAnotherLaunchsParkedFunds_native() public {
        _assertParkedFundsSurvive(t.nativeQuote);
    }

    function _assertParkedFundsSurvive(Currency quote) internal {
        address parked = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, keccak256("parked"));
        address other = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, keccak256("other"));

        // `parked` gets as far as POOL_INITIALIZED and stalls with its meme and quote sitting in the manager
        vm.mockCallRevert(
            address(t.positionManager), abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector), "STALL"
        );
        t.graduation.graduate(parked);
        vm.clearMockedCalls();
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(parked);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.POOL_INITIALIZED));
        uint256 parkedQuote = g.quoteReceived;
        assertGe(quote.balanceOf(t.graduationManager), parkedQuote);

        // another launch on the same quote graduates start to finish in the meantime
        t.graduation.graduate(other);
        assertEq(uint256(t.graduation.graduationOf(other).stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(t.graduation.graduationOf(other).quoteHeld, 0);
        assertGe(quote.balanceOf(t.graduationManager), parkedQuote, "the parked launch's quote was swept");

        // and the parked launch can still finish, with everything it was owed
        t.graduation.graduate(parked);
        _assertGraduated(parked, quote);
        g = t.graduation.graduationOf(parked);
        assertGt(g.liquidity, 0);
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

    function test_collectFees_sendsToFeeRecipient() public {
        address meme = _createAndFill(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("fees-a"));
        t.graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        bool quoteIs0 = g.key.currency0 == t.erc20Quote;

        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);
        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);
        _swapQuoteIn(g.key, quoteIs0, SWAP_IN, 0);

        uint256 beforeQ = t.erc20Quote.balanceOf(address(t.treasury));
        t.locker.collectFees(g.positionTokenId);
        assertGt(t.erc20Quote.balanceOf(address(t.treasury)), beforeQ);
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
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertTrue(t.hook.poolInfo(g.poolId).initialized);
        assertEq(IERC20(meme).balanceOf(t.graduationManager), 0);
        assertEq(quote.balanceOf(t.graduationManager), 0);
        assertEq(IERC721(address(t.positionManager)).ownerOf(g.positionTokenId), address(t.locker));
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
