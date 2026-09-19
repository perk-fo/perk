// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {IPerkBondingCurve} from "../../src/interfaces/IPerkBondingCurve.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {MockFactoryStatus} from "../utils/MockFactoryStatus.sol";

/// @dev Records `collectFee` and the watched account's meme balance at call time (ADR-002).
contract MockFeeRouterRecorder {
    struct CollectCall {
        address meme;
        PerkTypes.FeeSource source;
        uint256 amount;
        uint256 value;
        uint256 watchedMemeBalance;
    }

    CollectCall[] public calls;
    address public watched;

    function setWatched(address account) external {
        watched = account;
    }

    function collectFee(address meme, PerkTypes.FeeSource source, uint256 amount) external payable {
        uint256 bal = watched == address(0) ? 0 : IERC20(meme).balanceOf(watched);
        calls.push(CollectCall({meme: meme, source: source, amount: amount, value: msg.value, watchedMemeBalance: bal}));
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function lastWatchedMemeBalance() external view returns (uint256) {
        return calls[calls.length - 1].watchedMemeBalance;
    }

    receive() external payable {}
}

contract BondingCurveTest is Test {
    uint256 internal constant VIRTUAL_QUOTE = 100 ether;
    uint256 internal constant VIRTUAL_MEME = 1_000_000 ether;
    uint256 internal constant CURVE_SUPPLY = 800_000 ether;
    uint256 internal constant POOL_RESERVE = 200_000 ether;
    uint256 internal constant THRESHOLD = 99 ether;
    uint24 internal constant FEE_BPS = 100;
    uint256 internal constant EXACT_GROSS = 100 ether;

    struct Fixture {
        BondingCurve curve;
        MockFactoryStatus factory;
        MockFeeRouterRecorder feeRouter;
        MockERC20 meme;
        MockERC20 quoteToken;
        Currency quote;
        bool native;
        address buyer;
        address recipient;
        address graduationManager;
        address stranger;
        uint256 initialK;
    }

    event CurveInitialized(address indexed meme, IPerkBondingCurve.CurveConfig config);
    event CurveBuy(
        address indexed meme,
        address indexed buyer,
        address indexed recipient,
        uint256 quoteGross,
        uint256 fee,
        uint256 quoteNet,
        uint256 memeOut
    );
    event CurveSell(
        address indexed meme,
        address indexed seller,
        address indexed recipient,
        uint256 memeIn,
        uint256 quoteGross,
        uint256 fee,
        uint256 quoteNet
    );
    event CurveGraduationReached(address indexed meme, uint256 realQuote, uint256 memeSold, uint256 finalPriceX18);
    event CurveFinalized(address indexed meme, address indexed to, uint256 memeOut, uint256 quoteOut);

    function test_initCurve_onlyFactory() public {
        _test_initCurve_onlyFactory(true);
        _test_initCurve_onlyFactory(false);
    }

    function test_initCurve_reverts_alreadyInitialized() public {
        _test_initCurve_reverts_alreadyInitialized(true);
        _test_initCurve_reverts_alreadyInitialized(false);
    }

    function test_initCurve_reverts_invalidConfig_zeroVirtualQuote() public {
        _test_initCurve_reverts_invalidConfig(_zeroVirtualQuote, true);
        _test_initCurve_reverts_invalidConfig(_zeroVirtualQuote, false);
    }

    function test_initCurve_reverts_invalidConfig_zeroVirtualMeme() public {
        _test_initCurve_reverts_invalidConfig(_zeroVirtualMeme, true);
        _test_initCurve_reverts_invalidConfig(_zeroVirtualMeme, false);
    }

    function test_initCurve_reverts_invalidConfig_zeroThreshold() public {
        _test_initCurve_reverts_invalidConfig(_zeroThreshold, true);
        _test_initCurve_reverts_invalidConfig(_zeroThreshold, false);
    }

    function test_initCurve_reverts_invalidConfig_zeroCurveSupply() public {
        _test_initCurve_reverts_invalidConfig(_zeroCurveSupply, true);
        _test_initCurve_reverts_invalidConfig(_zeroCurveSupply, false);
    }

    function test_initCurve_reverts_invalidConfig_zeroFee() public {
        _test_initCurve_reverts_invalidConfig(_zeroFee, true);
        _test_initCurve_reverts_invalidConfig(_zeroFee, false);
    }

    function test_initCurve_reverts_invalidConfig_feeTooHigh() public {
        _test_initCurve_reverts_invalidConfig(_feeTooHigh, true);
        _test_initCurve_reverts_invalidConfig(_feeTooHigh, false);
    }

    function test_initCurve_reverts_insufficientMemeEscrow() public {
        _test_initCurve_reverts_insufficientMemeEscrow(true);
        _test_initCurve_reverts_insufficientMemeEscrow(false);
    }

    function test_initCurve_reverts_memeSoldAtGraduationExceedsSupply() public {
        _test_initCurve_reverts_memeSoldAtGraduationExceedsSupply(true);
        _test_initCurve_reverts_memeSoldAtGraduationExceedsSupply(false);
    }

    function test_buy_happyPath() public {
        _test_buy_happyPath(true);
        _test_buy_happyPath(false);
    }

    function test_buy_reverts_slippageExceeded() public {
        _test_buy_reverts_slippageExceeded(true);
        _test_buy_reverts_slippageExceeded(false);
    }

    function test_buy_reverts_nativeAmountMismatch() public {
        Fixture memory f = _setup(true);
        _fund(f, f.buyer, 1 ether);
        vm.prank(f.buyer);
        vm.expectRevert(IPerkBondingCurve.NativeAmountMismatch.selector);
        f.curve.buy{value: 0.5 ether}(address(f.meme), 1 ether, 0, f.buyer);
    }

    function test_buy_reverts_erc20WithMsgValue() public {
        Fixture memory f = _setup(false);
        _fund(f, f.buyer, 1 ether);
        vm.deal(f.buyer, 1);
        vm.prank(f.buyer);
        vm.expectRevert(IPerkBondingCurve.NativeAmountMismatch.selector);
        f.curve.buy{value: 1}(address(f.meme), 1 ether, 0, f.buyer);
    }

    function test_buy_crossesThreshold_partialFill() public {
        _test_buy_crossesThreshold_partialFill(true);
        _test_buy_crossesThreshold_partialFill(false);
    }

    function test_buy_landsExactlyOnThreshold() public {
        _test_buy_landsExactlyOnThreshold(true);
        _test_buy_landsExactlyOnThreshold(false);
    }

    function test_buy_sell_feeOrdering() public {
        _test_buy_sell_feeOrdering(true);
        _test_buy_sell_feeOrdering(false);
    }

    function test_sell_happyPath() public {
        _test_sell_happyPath(true);
        _test_sell_happyPath(false);
    }

    function test_roundTrip_feesLeakAndRealQuoteNonNegative() public {
        _test_roundTrip_feesLeakAndRealQuoteNonNegative(true);
        _test_roundTrip_feesLeakAndRealQuoteNonNegative(false);
    }

    function testFuzz_quoteBuy_matchesBuy(bool nativeQuote, uint256 quoteIn) public {
        Fixture memory f = _setup(nativeQuote);
        quoteIn = bound(quoteIn, 1, 200 ether);
        (uint256 qMeme, uint256 qUsed, uint256 qFee) = f.curve.quoteBuy(address(f.meme), quoteIn);
        _fund(f, f.buyer, quoteIn);
        (uint256 memeOut, uint256 used, uint256 refund) = _buy(f, quoteIn, 0, address(0));
        assertEq(memeOut, qMeme);
        assertEq(used, qUsed);
        assertEq(refund, quoteIn - qUsed);
        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertEq(st.realQuote, qUsed - qFee);
        assertEq(f.meme.balanceOf(f.buyer), memeOut);
    }

    function testFuzz_quoteSell_matchesSell(bool nativeQuote, uint256 memeIn) public {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 10 ether;
        _fund(f, f.buyer, quoteIn);
        (uint256 bought,,) = _buy(f, quoteIn, 0, f.buyer);
        memeIn = bound(memeIn, 1, bought);
        uint256 realBefore = f.curve.curveState(address(f.meme)).realQuote;
        (uint256 qOut, uint256 qFee) = f.curve.quoteSell(address(f.meme), memeIn);
        uint256 paid = _sell(f, memeIn, 0, f.buyer);
        assertEq(paid, qOut);
        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertEq(st.memeSold, bought - memeIn);
        assertEq(st.realQuote, realBefore - (qOut + qFee));
    }

    function test_finalizeForGraduation() public {
        _test_finalizeForGraduation(true);
        _test_finalizeForGraduation(false);
    }

    function testFuzz_invariant_kAndRealQuote(bool nativeQuote, uint256 seed) public {
        Fixture memory f = _setup(nativeQuote);
        _fund(f, f.buyer, 1000 ether);
        vm.prank(f.buyer);
        f.meme.approve(address(f.curve), type(uint256).max);

        uint256 sumNetBuys;
        uint256 sumGrossSells;

        for (uint256 i; i < 12; ++i) {
            IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
            if (st.graduated) break;
            uint256 roll = uint256(keccak256(abi.encode(seed, i)));
            uint256 memeBal = f.meme.balanceOf(f.buyer);
            bool doSell = memeBal > 0 && st.realQuote > 0 && (roll % 3 == 0);
            if (doSell) {
                uint256 sellAmt = bound(roll >> 8, 1, memeBal);
                (uint256 qOut, uint256 fee) = f.curve.quoteSell(address(f.meme), sellAmt);
                _sell(f, sellAmt, 0, f.buyer);
                sumGrossSells += qOut + fee;
            } else {
                uint256 buyAmt = bound(roll >> 8, 1, 25 ether);
                _fund(f, f.buyer, buyAmt);
                (, uint256 used, uint256 fee) = f.curve.quoteBuy(address(f.meme), buyAmt);
                _buy(f, buyAmt, 0, f.buyer);
                sumNetBuys += used - fee;
            }
        }

        IPerkBondingCurve.CurveState memory end = f.curve.curveState(address(f.meme));
        (bool ok, uint256 k) = Math.tryMul(end.virtualQuote, end.virtualMeme);
        assertTrue(ok);
        // Flooring amount-out means k is non-decreasing.
        assertGe(k, f.initialK);
        assertEq(end.realQuote, sumNetBuys - sumGrossSells);
    }

    function test_gas_buy_sell_native() public {
        Fixture memory f = _setup(true);
        _fund(f, f.buyer, 10 ether);
        vm.prank(f.buyer);
        f.meme.approve(address(f.curve), type(uint256).max);

        vm.startSnapshotGas("curve_buy_native");
        vm.prank(f.buyer);
        (uint256 memeOut,,) = f.curve.buy{value: 1 ether}(address(f.meme), 1 ether, 0, f.buyer);
        uint256 buyGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("curve_sell_native");
        vm.prank(f.buyer);
        f.curve.sell(address(f.meme), memeOut / 2, 0, f.buyer);
        uint256 sellGas = vm.stopSnapshotGas();

        emit log_named_uint("buy_native_gas", buyGas);
        emit log_named_uint("sell_native_gas", sellGas);
        assertGt(buyGas, 0);
        assertGt(sellGas, 0);
    }

    // ------------------------------------------------------------------
    // Internal cases
    // ------------------------------------------------------------------

    function _test_initCurve_onlyFactory(bool nativeQuote) internal {
        Fixture memory f = _fresh(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = _defaultConfig(f.quote);
        f.meme.mint(address(f.curve), cfg.curveSupply + cfg.poolReserveSupply);
        vm.prank(f.stranger);
        vm.expectRevert(IPerkBondingCurve.NotFactory.selector);
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _test_initCurve_reverts_alreadyInitialized(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = _defaultConfig(f.quote);
        f.meme.mint(address(f.curve), cfg.curveSupply + cfg.poolReserveSupply);
        vm.prank(address(f.factory));
        vm.expectRevert(IPerkBondingCurve.AlreadyInitialized.selector);
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _test_initCurve_reverts_invalidConfig(
        function(IPerkBondingCurve.CurveConfig memory)
            internal
            pure returns (IPerkBondingCurve.CurveConfig memory) mutator,
        bool nativeQuote
    ) internal {
        Fixture memory f = _fresh(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = mutator(_defaultConfig(f.quote));
        f.meme.mint(address(f.curve), CURVE_SUPPLY + POOL_RESERVE);
        vm.prank(address(f.factory));
        vm.expectRevert(IPerkBondingCurve.InvalidConfig.selector);
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _test_initCurve_reverts_insufficientMemeEscrow(bool nativeQuote) internal {
        Fixture memory f = _fresh(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = _defaultConfig(f.quote);
        vm.prank(address(f.factory));
        vm.expectRevert(IPerkBondingCurve.InsufficientMemeEscrow.selector);
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _test_initCurve_reverts_memeSoldAtGraduationExceedsSupply(bool nativeQuote) internal {
        Fixture memory f = _fresh(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = _defaultConfig(f.quote);
        cfg.curveSupply = 1;
        f.meme.mint(address(f.curve), cfg.curveSupply + cfg.poolReserveSupply);
        vm.prank(address(f.factory));
        vm.expectRevert(IPerkBondingCurve.InvalidConfig.selector);
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _test_buy_happyPath(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 10 ether;
        uint256 fee = Math.mulDiv(quoteIn, FEE_BPS, PerkConstants.BPS, Math.Rounding.Ceil);
        uint256 net = quoteIn - fee;
        uint256 expectedMeme = Math.mulDiv(VIRTUAL_MEME, net, VIRTUAL_QUOTE + net);

        _fund(f, f.buyer, quoteIn);
        (uint256 qMeme, uint256 qUsed, uint256 qFee) = f.curve.quoteBuy(address(f.meme), quoteIn);
        assertEq(qMeme, expectedMeme);
        assertEq(qFee, fee);
        assertEq(qUsed, quoteIn);

        vm.expectEmit(true, true, true, true, address(f.curve));
        emit CurveBuy(address(f.meme), f.buyer, f.buyer, quoteIn, fee, net, expectedMeme);

        (uint256 memeOut, uint256 used, uint256 refund) = _buy(f, quoteIn, 0, address(0));
        assertEq(memeOut, expectedMeme);
        assertEq(used, quoteIn);
        assertEq(refund, 0);
        assertEq(f.meme.balanceOf(f.buyer), expectedMeme);

        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertEq(st.realQuote, net);
        assertEq(st.memeSold, expectedMeme);
        assertEq(st.virtualQuote, VIRTUAL_QUOTE + net);
        assertEq(st.virtualMeme, VIRTUAL_MEME - expectedMeme);
        assertFalse(st.graduated);
        assertEq(f.curve.progressBps(address(f.meme)), Math.mulDiv(net, PerkConstants.BPS, THRESHOLD));
    }

    function _test_buy_reverts_slippageExceeded(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 1 ether;
        _fund(f, f.buyer, quoteIn);
        (uint256 expectedMeme,,) = f.curve.quoteBuy(address(f.meme), quoteIn);
        vm.prank(f.buyer);
        vm.expectRevert(IPerkBondingCurve.SlippageExceeded.selector);
        if (f.native) {
            f.curve.buy{value: quoteIn}(address(f.meme), quoteIn, expectedMeme + 1, f.buyer);
        } else {
            f.curve.buy(address(f.meme), quoteIn, expectedMeme + 1, f.buyer);
        }
    }

    function _test_buy_crossesThreshold_partialFill(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 150 ether;
        _fund(f, f.buyer, quoteIn);

        uint256 net = THRESHOLD;
        uint256 gross = Math.mulDiv(net, PerkConstants.BPS, PerkConstants.BPS - FEE_BPS, Math.Rounding.Ceil);
        uint256 fee = gross - net;
        uint256 refund = quoteIn - gross;
        uint256 expectedMeme = Math.mulDiv(VIRTUAL_MEME, net, VIRTUAL_QUOTE + net);
        uint256 finalPrice = Math.mulDiv(VIRTUAL_QUOTE + net, 1e18, VIRTUAL_MEME - expectedMeme);

        uint256 buyerQuoteBefore = _quoteBalance(f, f.buyer);

        vm.expectEmit(true, true, true, true, address(f.curve));
        emit CurveBuy(address(f.meme), f.buyer, f.buyer, gross, fee, net, expectedMeme);
        vm.expectEmit(true, false, false, true, address(f.curve));
        emit CurveGraduationReached(address(f.meme), THRESHOLD, expectedMeme, finalPrice);

        (uint256 memeOut, uint256 used, uint256 actualRefund) = _buy(f, quoteIn, 0, f.buyer);
        assertEq(memeOut, expectedMeme);
        assertEq(used, gross);
        assertEq(actualRefund, refund);
        assertEq(actualRefund, 50 ether);

        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertTrue(st.graduated);
        assertEq(st.realQuote, THRESHOLD);
        assertEq(_quoteBalance(f, f.buyer), buyerQuoteBefore - used);

        assertEq(f.factory.callCount(), 1);
        MockFactoryStatus.StatusCall memory statusCall = f.factory.lastCall();
        assertEq(statusCall.meme, address(f.meme));
        assertEq(uint256(statusCall.status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
        assertEq(PoolId.unwrap(statusCall.poolId), bytes32(0));

        _assertCurveInactive(f);
    }

    function _test_buy_landsExactlyOnThreshold(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        _fund(f, f.buyer, EXACT_GROSS);
        (uint256 memeOut, uint256 used, uint256 refund) = _buy(f, EXACT_GROSS, 0, f.buyer);
        assertEq(used, EXACT_GROSS);
        assertEq(refund, 0);
        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertTrue(st.graduated);
        assertEq(st.realQuote, THRESHOLD);
        assertEq(st.memeSold, memeOut);
        assertEq(f.factory.callCount(), 1);
        assertEq(uint256(f.factory.lastCall().status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
    }

    function _test_buy_sell_feeOrdering(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        f.feeRouter.setWatched(f.buyer);

        uint256 quoteIn = 10 ether;
        _fund(f, f.buyer, quoteIn);
        uint256 preBuyMeme = f.meme.balanceOf(f.buyer);
        (uint256 memeOut,,) = _buy(f, quoteIn, 0, f.buyer);
        assertEq(f.feeRouter.lastWatchedMemeBalance(), preBuyMeme);
        assertEq(preBuyMeme, 0);
        assertEq(f.meme.balanceOf(f.buyer), memeOut);

        uint256 preSellMeme = f.meme.balanceOf(f.buyer);
        _sell(f, memeOut / 2, 0, f.buyer);
        assertEq(f.feeRouter.lastWatchedMemeBalance(), preSellMeme);
        assertEq(preSellMeme, memeOut);
    }

    function _test_sell_happyPath(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 10 ether;
        _fund(f, f.buyer, quoteIn);
        (uint256 memeOut,,) = _buy(f, quoteIn, 0, f.buyer);

        IPerkBondingCurve.CurveState memory beforeSell = f.curve.curveState(address(f.meme));
        uint256 quoteGross = Math.mulDiv(beforeSell.virtualQuote, memeOut, beforeSell.virtualMeme + memeOut);
        uint256 fee = Math.mulDiv(quoteGross, FEE_BPS, PerkConstants.BPS, Math.Rounding.Ceil);
        uint256 net = quoteGross - fee;

        uint256 recipientQuoteBefore = _quoteBalance(f, f.recipient);

        vm.prank(f.buyer);
        f.meme.approve(address(f.curve), memeOut);
        vm.expectEmit(true, true, true, true, address(f.curve));
        emit CurveSell(address(f.meme), f.buyer, f.recipient, memeOut, quoteGross, fee, net);
        vm.prank(f.buyer);
        uint256 paid = f.curve.sell(address(f.meme), memeOut, 0, f.recipient);
        assertEq(paid, net);
        assertEq(_quoteBalance(f, f.recipient), recipientQuoteBefore + net);
        assertEq(f.meme.balanceOf(f.buyer), 0);

        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertEq(st.realQuote, beforeSell.realQuote - quoteGross);
        assertEq(st.memeSold, 0);
        assertEq(st.virtualMeme, beforeSell.virtualMeme + memeOut);
        assertEq(st.virtualQuote, beforeSell.virtualQuote - quoteGross);
    }

    function _test_roundTrip_feesLeakAndRealQuoteNonNegative(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);
        uint256 quoteIn = 10 ether;
        _fund(f, f.buyer, quoteIn);
        uint256 quoteBefore = _quoteBalance(f, f.buyer);
        (uint256 memeOut,,) = _buy(f, quoteIn, 0, f.buyer);
        uint256 quoteAfterBuy = _quoteBalance(f, f.buyer);
        uint256 paid = _sell(f, memeOut, 0, f.buyer);
        uint256 quoteAfterSell = _quoteBalance(f, f.buyer);

        assertLt(paid, quoteIn);
        assertLt(quoteAfterSell, quoteBefore);
        assertEq(quoteAfterBuy + paid, quoteAfterSell);

        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertGe(st.realQuote, 0);
        assertEq(st.memeSold, 0);
    }

    function _test_finalizeForGraduation(bool nativeQuote) internal {
        Fixture memory f = _setup(nativeQuote);

        MockERC20 other = new MockERC20("Other", "OTH", 18);
        IPerkBondingCurve.CurveConfig memory otherCfg = _defaultConfig(f.quote);
        other.mint(address(f.curve), otherCfg.curveSupply + otherCfg.poolReserveSupply);
        vm.prank(address(f.factory));
        f.curve.initCurve(address(other), otherCfg);
        uint256 otherBalBefore = other.balanceOf(address(f.curve));

        vm.prank(f.stranger);
        vm.expectRevert(IPerkBondingCurve.NotGraduationManager.selector);
        f.curve.finalizeForGraduation(address(f.meme), f.recipient);

        vm.prank(f.graduationManager);
        vm.expectRevert(IPerkBondingCurve.NotGraduated.selector);
        f.curve.finalizeForGraduation(address(f.meme), f.recipient);

        _fund(f, f.buyer, EXACT_GROSS);
        (uint256 sold,,) = _buy(f, EXACT_GROSS, 0, f.buyer);

        uint256 expectedMeme = (CURVE_SUPPLY - sold) + POOL_RESERVE;
        address to = makeAddr("finalizeTo");
        uint256 toQuoteBefore = _quoteBalance(f, to);

        vm.expectEmit(true, true, false, true, address(f.curve));
        emit CurveFinalized(address(f.meme), to, expectedMeme, THRESHOLD);

        vm.prank(f.graduationManager);
        (uint256 memeOut, uint256 quoteOut) = f.curve.finalizeForGraduation(address(f.meme), to);
        assertEq(memeOut, expectedMeme);
        assertEq(quoteOut, THRESHOLD);
        assertEq(f.meme.balanceOf(to), expectedMeme);
        assertEq(_quoteBalance(f, to), toQuoteBefore + THRESHOLD);
        assertEq(other.balanceOf(address(f.curve)), otherBalBefore);

        IPerkBondingCurve.CurveState memory st = f.curve.curveState(address(f.meme));
        assertTrue(st.finalized);
        assertEq(st.realQuote, 0);

        vm.prank(f.graduationManager);
        vm.expectRevert(IPerkBondingCurve.AlreadyFinalized.selector);
        f.curve.finalizeForGraduation(address(f.meme), to);
    }

    // ------------------------------------------------------------------
    // Config mutators
    // ------------------------------------------------------------------

    function _zeroVirtualQuote(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.virtualQuoteReserve = 0;
        return cfg;
    }

    function _zeroVirtualMeme(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.virtualMemeReserve = 0;
        return cfg;
    }

    function _zeroThreshold(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.graduationQuoteThreshold = 0;
        return cfg;
    }

    function _zeroCurveSupply(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.curveSupply = 0;
        return cfg;
    }

    function _zeroFee(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.totalFeeBps = 0;
        return cfg;
    }

    function _feeTooHigh(IPerkBondingCurve.CurveConfig memory cfg)
        internal
        pure
        returns (IPerkBondingCurve.CurveConfig memory)
    {
        cfg.totalFeeBps = 101;
        return cfg;
    }

    // ------------------------------------------------------------------
    // Fixture helpers
    // ------------------------------------------------------------------

    function _defaultConfig(Currency quote) internal pure returns (IPerkBondingCurve.CurveConfig memory) {
        return IPerkBondingCurve.CurveConfig({
            quote: quote,
            virtualQuoteReserve: VIRTUAL_QUOTE,
            virtualMemeReserve: VIRTUAL_MEME,
            curveSupply: CURVE_SUPPLY,
            poolReserveSupply: POOL_RESERVE,
            graduationQuoteThreshold: THRESHOLD,
            totalFeeBps: FEE_BPS
        });
    }

    function _fresh(bool nativeQuote) internal returns (Fixture memory f) {
        f.factory = new MockFactoryStatus();
        f.feeRouter = new MockFeeRouterRecorder();
        f.curve = new BondingCurve(address(f.factory), address(f.feeRouter));
        f.graduationManager = makeAddr("graduationManager");
        vm.prank(address(f.factory));
        f.curve.wire(f.graduationManager);

        f.meme = new MockERC20("Meme", "MEME", 18);
        f.native = nativeQuote;
        if (nativeQuote) {
            f.quote = Currency.wrap(address(0));
        } else {
            f.quoteToken = new MockERC20("Quote", "Q", 18);
            f.quote = Currency.wrap(address(f.quoteToken));
        }
        f.buyer = makeAddr("buyer");
        f.recipient = makeAddr("recipient");
        f.stranger = makeAddr("stranger");
        f.initialK = VIRTUAL_QUOTE * VIRTUAL_MEME;
    }

    function _setup(bool nativeQuote) internal returns (Fixture memory f) {
        f = _fresh(nativeQuote);
        IPerkBondingCurve.CurveConfig memory cfg = _defaultConfig(f.quote);
        f.meme.mint(address(f.curve), cfg.curveSupply + cfg.poolReserveSupply);
        vm.prank(address(f.factory));
        f.curve.initCurve(address(f.meme), cfg);
    }

    function _fund(Fixture memory f, address who, uint256 amount) internal {
        if (f.native) {
            vm.deal(who, who.balance + amount);
        } else {
            f.quoteToken.mint(who, amount);
            vm.prank(who);
            f.quoteToken.approve(address(f.curve), type(uint256).max);
        }
    }

    function _buy(Fixture memory f, uint256 quoteIn, uint256 minMemeOut, address recipient)
        internal
        returns (uint256 memeOut, uint256 quoteUsed, uint256 quoteRefund)
    {
        vm.prank(f.buyer);
        if (f.native) {
            return f.curve.buy{value: quoteIn}(address(f.meme), quoteIn, minMemeOut, recipient);
        }
        return f.curve.buy(address(f.meme), quoteIn, minMemeOut, recipient);
    }

    function _sell(Fixture memory f, uint256 memeIn, uint256 minQuoteOut, address recipient)
        internal
        returns (uint256 quoteOut)
    {
        vm.prank(f.buyer);
        f.meme.approve(address(f.curve), memeIn);
        vm.prank(f.buyer);
        return f.curve.sell(address(f.meme), memeIn, minQuoteOut, recipient);
    }

    function _quoteBalance(Fixture memory f, address who) internal view returns (uint256) {
        if (f.native) return who.balance;
        return f.quoteToken.balanceOf(who);
    }

    function _assertCurveInactive(Fixture memory f) internal {
        vm.prank(f.buyer);
        vm.expectRevert(IPerkBondingCurve.CurveNotActive.selector);
        if (f.native) {
            f.curve.buy{value: 1 ether}(address(f.meme), 1 ether, 0, f.buyer);
        } else {
            f.curve.buy(address(f.meme), 1 ether, 0, f.buyer);
        }

        vm.prank(f.buyer);
        f.meme.approve(address(f.curve), 1);
        vm.prank(f.buyer);
        vm.expectRevert(IPerkBondingCurve.CurveNotActive.selector);
        f.curve.sell(address(f.meme), 1, 0, f.buyer);
    }
}
