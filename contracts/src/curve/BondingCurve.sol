// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IPerkBondingCurve} from "../interfaces/IPerkBondingCurve.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";
import {IPerkLaunchFactory} from "../interfaces/IPerkLaunchFactory.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title BondingCurve
/// @notice Singleton constant-product curve with virtual reserves; one independent state per meme.
contract BondingCurve is IPerkBondingCurve, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    error AlreadyWired();
    error ZeroAddress();

    /// @inheritdoc IPerkBondingCurve
    address public immutable override factory;
    /// @inheritdoc IPerkBondingCurve
    address public immutable override feeRouter;
    /// @inheritdoc IPerkBondingCurve
    address public override graduationManager;

    mapping(address meme => CurveConfig) private _configs;
    mapping(address meme => CurveState) private _states;

    struct BuyPreview {
        uint256 memeOut;
        uint256 gross;
        uint256 fee;
        uint256 net;
        uint256 refund;
        uint256 newVirtualQuote;
        uint256 newVirtualMeme;
    }

    struct SellPreview {
        uint256 quoteGross;
        uint256 fee;
        uint256 net;
        uint256 newVirtualQuote;
        uint256 newVirtualMeme;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyGraduationManager() {
        if (msg.sender != graduationManager) revert NotGraduationManager();
        _;
    }

    /// @param factory_ Launch factory allowed to init curves and wire once.
    /// @param feeRouter_ Fee router that receives the full curve fee before trader balances change.
    constructor(address factory_, address feeRouter_) {
        if (factory_ == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        factory = factory_;
        feeRouter = feeRouter_;
    }

    /// @notice One-time wiring of the graduation manager. Factory only.
    /// @param graduationManager_ Graduation manager allowed to finalize a graduated curve.
    function wire(address graduationManager_) external onlyFactory {
        if (graduationManager != address(0)) revert AlreadyWired();
        if (graduationManager_ == address(0)) revert ZeroAddress();
        // One-time wire; no interface event exists for this assignment.
        // forge-lint: disable-next-line(missing-events-access-control)
        graduationManager = graduationManager_;
    }

    /// @inheritdoc IPerkBondingCurve
    function initCurve(address meme, CurveConfig calldata config) external override onlyFactory {
        CurveState storage st = _states[meme];
        if (st.initialized) revert AlreadyInitialized();
        if (!_isValidConfig(config)) revert InvalidConfig();
        uint256 required = config.curveSupply + config.poolReserveSupply;
        if (IERC20(meme).balanceOf(address(this)) < required) revert InsufficientMemeEscrow();

        _configs[meme] = config;
        st.virtualQuote = config.virtualQuoteReserve;
        st.virtualMeme = config.virtualMemeReserve;
        st.initialized = true;

        // `balanceOf` above is a view; no state-changing external call precedes this emit.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CurveInitialized(meme, config);
    }

    /// @inheritdoc IPerkBondingCurve
    function buy(address meme, uint256 quoteIn, uint256 minMemeOut, address recipient)
        external
        payable
        override
        nonReentrant
        returns (uint256 memeOut, uint256 quoteUsed, uint256 quoteRefund)
    {
        CurveState storage st = _states[meme];
        _requireActive(st);
        if (quoteIn == 0) revert ZeroAmount();
        if (recipient == address(0)) recipient = msg.sender;

        CurveConfig memory cfg = _configs[meme];
        _pullQuote(cfg.quote, quoteIn);

        BuyPreview memory preview = _previewBuy(cfg, st, quoteIn);
        if (preview.memeOut < minMemeOut) revert SlippageExceeded();

        return _settleBuy(meme, recipient, cfg, st, preview);
    }

    /// @inheritdoc IPerkBondingCurve
    function sell(address meme, uint256 memeIn, uint256 minQuoteOut, address recipient)
        external
        override
        nonReentrant
        returns (uint256 quoteOut)
    {
        CurveState storage st = _states[meme];
        _requireActive(st);
        if (memeIn == 0) revert ZeroAmount();
        if (recipient == address(0)) recipient = msg.sender;
        if (memeIn > st.memeSold) revert ZeroAmount();

        CurveConfig memory cfg = _configs[meme];
        SellPreview memory preview = _previewSell(st, cfg.totalFeeBps, memeIn);
        if (preview.net < minQuoteOut) revert SlippageExceeded();
        if (preview.quoteGross > st.realQuote) revert InvalidConfig();

        st.virtualMeme = preview.newVirtualMeme;
        st.virtualQuote = preview.newVirtualQuote;
        st.realQuote -= preview.quoteGross;
        st.memeSold -= memeIn;

        _payFee(cfg.quote, meme, preview.fee);
        IERC20(meme).safeTransferFrom(msg.sender, address(this), memeIn);
        if (preview.net != 0) {
            CurrencyLibrary.transfer(cfg.quote, recipient, preview.net);
        }

        // forge-lint: disable-next-line(reentrancy-events)
        emit CurveSell(meme, msg.sender, recipient, memeIn, preview.quoteGross, preview.fee, preview.net);
        return preview.net;
    }

    /// @inheritdoc IPerkBondingCurve
    function finalizeForGraduation(address meme, address to)
        external
        override
        onlyGraduationManager
        returns (uint256 memeOut, uint256 quoteOut)
    {
        CurveState storage st = _states[meme];
        if (!st.graduated) revert NotGraduated();
        if (st.finalized) revert AlreadyFinalized();

        CurveConfig memory cfg = _configs[meme];
        memeOut = (cfg.curveSupply - st.memeSold) + cfg.poolReserveSupply;
        quoteOut = st.realQuote;
        st.finalized = true;
        st.realQuote = 0;

        emit CurveFinalized(meme, to, memeOut, quoteOut);

        if (memeOut != 0) IERC20(meme).safeTransfer(to, memeOut);
        if (quoteOut != 0) CurrencyLibrary.transfer(cfg.quote, to, quoteOut);
    }

    /// @inheritdoc IPerkBondingCurve
    function quoteBuy(address meme, uint256 quoteIn)
        external
        view
        override
        returns (uint256 memeOut, uint256 quoteUsed, uint256 fee)
    {
        CurveState storage st = _states[meme];
        _requireActive(st);
        if (quoteIn == 0) revert ZeroAmount();
        BuyPreview memory preview = _previewBuy(_configs[meme], st, quoteIn);
        return (preview.memeOut, preview.gross, preview.fee);
    }

    /// @inheritdoc IPerkBondingCurve
    function quoteSell(address meme, uint256 memeIn) external view override returns (uint256 quoteOut, uint256 fee) {
        CurveState storage st = _states[meme];
        _requireActive(st);
        if (memeIn == 0) revert ZeroAmount();
        SellPreview memory preview = _previewSell(st, _configs[meme].totalFeeBps, memeIn);
        return (preview.net, preview.fee);
    }

    /// @inheritdoc IPerkBondingCurve
    function priceX18(address meme) external view override returns (uint256) {
        CurveState storage st = _states[meme];
        return _priceX18(st.virtualQuote, st.virtualMeme);
    }

    /// @inheritdoc IPerkBondingCurve
    function progressBps(address meme) external view override returns (uint256) {
        CurveState storage st = _states[meme];
        uint256 threshold = _configs[meme].graduationQuoteThreshold;
        if (threshold == 0) return 0;
        return Math.mulDiv(st.realQuote, PerkConstants.BPS, threshold);
    }

    /// @inheritdoc IPerkBondingCurve
    function curveConfig(address meme) external view override returns (CurveConfig memory) {
        return _configs[meme];
    }

    /// @inheritdoc IPerkBondingCurve
    function curveState(address meme) external view override returns (CurveState memory) {
        return _states[meme];
    }

    function _isValidConfig(CurveConfig calldata cfg) private pure returns (bool) {
        if (
            cfg.virtualQuoteReserve == 0 || cfg.virtualMemeReserve == 0 || cfg.graduationQuoteThreshold == 0
                || cfg.curveSupply == 0
        ) {
            return false;
        }
        if (cfg.totalFeeBps == 0 || cfg.totalFeeBps > 100) return false;
        uint256 memeSoldAtGraduation = Math.mulDiv(
            cfg.virtualMemeReserve, cfg.graduationQuoteThreshold, cfg.virtualQuoteReserve + cfg.graduationQuoteThreshold
        );
        if (memeSoldAtGraduation > cfg.curveSupply) return false;
        return true;
    }

    function _settleBuy(
        address meme,
        address recipient,
        CurveConfig memory cfg,
        CurveState storage st,
        BuyPreview memory preview
    ) private returns (uint256 memeOut, uint256 quoteUsed, uint256 quoteRefund) {
        st.virtualQuote = preview.newVirtualQuote;
        st.virtualMeme = preview.newVirtualMeme;
        st.realQuote += preview.net;
        st.memeSold += preview.memeOut;

        bool graduated_ = st.realQuote >= cfg.graduationQuoteThreshold;
        if (graduated_) st.graduated = true;

        uint256 realQuote_ = st.realQuote;
        uint256 memeSold_ = st.memeSold;
        uint256 finalPriceX18 = _priceX18(st.virtualQuote, st.virtualMeme);

        _payFee(cfg.quote, meme, preview.fee);
        IERC20(meme).safeTransfer(recipient, preview.memeOut);
        _refundQuote(cfg.quote, msg.sender, preview.refund);

        // Interactions above are guarded by nonReentrant; event order follows the task.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CurveBuy(meme, msg.sender, recipient, preview.gross, preview.fee, preview.net, preview.memeOut);
        if (graduated_) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit CurveGraduationReached(meme, realQuote_, memeSold_, finalPriceX18);
            IPerkLaunchFactory(factory)
                .setLaunchStatus(meme, PerkTypes.LaunchStatus.GRADUATION_PENDING, PoolId.wrap(bytes32(0)));
        }

        return (preview.memeOut, preview.gross, preview.refund);
    }

    function _requireActive(CurveState storage st) private view {
        if (!st.initialized || st.graduated) revert CurveNotActive();
    }

    function _previewBuy(CurveConfig memory cfg, CurveState memory st, uint256 quoteIn)
        private
        pure
        returns (BuyPreview memory preview)
    {
        uint256 bps = PerkConstants.BPS;
        uint256 fee = Math.mulDiv(quoteIn, cfg.totalFeeBps, bps, Math.Rounding.Ceil);
        uint256 net = quoteIn - fee;
        uint256 gross = quoteIn;
        uint256 refund = 0;

        uint256 room = cfg.graduationQuoteThreshold - st.realQuote;
        if (net > room) {
            net = room;
            gross = Math.mulDiv(net, bps, bps - cfg.totalFeeBps, Math.Rounding.Ceil);
            fee = gross - net;
            refund = quoteIn - gross;
        }

        // Floor amount-out (Uniswap-style). Equivalent to `Mv - ceil(Qv*Mv/(Qv+qn))`; floor on the
        // inner product would credit the trader extra wei and can make quoteGross > realQuote.
        uint256 memeOut = Math.mulDiv(st.virtualMeme, net, st.virtualQuote + net);
        uint256 remaining = cfg.curveSupply - st.memeSold;
        if (memeOut > remaining) memeOut = remaining;

        preview.memeOut = memeOut;
        preview.gross = gross;
        preview.fee = fee;
        preview.net = net;
        preview.refund = refund;
        preview.newVirtualQuote = st.virtualQuote + net;
        preview.newVirtualMeme = st.virtualMeme - memeOut;
    }

    function _previewSell(CurveState memory st, uint24 totalFeeBps, uint256 memeIn)
        private
        pure
        returns (SellPreview memory preview)
    {
        uint256 quoteGross = Math.mulDiv(st.virtualQuote, memeIn, st.virtualMeme + memeIn);
        uint256 fee = Math.mulDiv(quoteGross, totalFeeBps, PerkConstants.BPS, Math.Rounding.Ceil);
        preview.quoteGross = quoteGross;
        preview.fee = fee;
        preview.net = quoteGross - fee;
        preview.newVirtualMeme = st.virtualMeme + memeIn;
        preview.newVirtualQuote = st.virtualQuote - quoteGross;
    }

    function _priceX18(uint256 virtualQuote, uint256 virtualMeme) private pure returns (uint256) {
        return Math.mulDiv(virtualQuote, 1e18, virtualMeme);
    }

    function _pullQuote(Currency quote, uint256 quoteIn) private {
        if (quote.isAddressZero()) {
            if (msg.value != quoteIn) revert NativeAmountMismatch();
        } else {
            if (msg.value != 0) revert NativeAmountMismatch();
            IERC20(Currency.unwrap(quote)).safeTransferFrom(msg.sender, address(this), quoteIn);
        }
    }

    function _payFee(Currency quote, address meme, uint256 fee) private {
        if (fee == 0) return;
        if (quote.isAddressZero()) {
            IPerkFeeRouter(feeRouter).collectFee{value: fee}(meme, PerkTypes.FeeSource.CURVE, fee);
        } else {
            IERC20(Currency.unwrap(quote)).safeTransfer(feeRouter, fee);
            IPerkFeeRouter(feeRouter).collectFee(meme, PerkTypes.FeeSource.CURVE, fee);
        }
    }

    function _refundQuote(Currency quote, address to, uint256 amount) private {
        if (amount == 0) return;
        if (quote.isAddressZero()) {
            CurrencyLibrary.transfer(quote, to, amount);
        } else {
            IERC20(Currency.unwrap(quote)).safeTransfer(to, amount);
        }
    }
}
