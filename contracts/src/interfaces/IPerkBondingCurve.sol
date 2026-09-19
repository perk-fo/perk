// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";

/// @title IPerkBondingCurve
/// @notice Singleton constant-product curve with virtual reserves; one independent state per meme (PRD 5.4).
/// @dev Fee handling (PRD 7.2): buys pay `totalFeeBps` of gross quote in; sells pay it out of gross quote out.
///      The whole fee is moved to the FeeRouter and accounted with FeeSource.CURVE BEFORE the meme balance of the
///      trader changes (ADR-002). Graduation triggers when realQuote reaches `graduationQuoteThreshold`; the last
///      buy is partially filled and the excess refunded (PRD 5.6).
interface IPerkBondingCurve {
    struct CurveConfig {
        Currency quote;
        uint256 virtualQuoteReserve;
        uint256 virtualMemeReserve;
        uint256 curveSupply;
        uint256 poolReserveSupply;
        uint256 graduationQuoteThreshold;
        uint24 totalFeeBps;
    }

    struct CurveState {
        uint256 virtualQuote;
        uint256 virtualMeme;
        /// @dev Net quote held for graduation. Never includes fees (PRD 7.2).
        uint256 realQuote;
        uint256 memeSold;
        bool initialized;
        bool graduated;
        bool finalized;
    }

    event CurveInitialized(address indexed meme, CurveConfig config);
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

    error NotFactory();
    error NotGraduationManager();
    error AlreadyInitialized();
    error CurveNotActive();
    error NotGraduated();
    error AlreadyFinalized();
    error ZeroAmount();
    error SlippageExceeded();
    error NativeAmountMismatch();
    error InvalidConfig();
    error InsufficientMemeEscrow();

    function factory() external view returns (address);
    function feeRouter() external view returns (address);
    function graduationManager() external view returns (address);

    /// @notice Factory only. Factory must have transferred curveSupply + poolReserveSupply meme to this contract.
    function initCurve(address meme, CurveConfig calldata config) external;

    /// @param quoteIn Gross quote including fee. Native: msg.value == quoteIn. ERC-20: transferFrom(msg.sender).
    /// @return memeOut Meme delivered to `recipient`.
    /// @return quoteUsed Gross quote actually consumed (less than quoteIn on the graduating buy).
    /// @return quoteRefund quoteIn - quoteUsed, returned to msg.sender.
    function buy(address meme, uint256 quoteIn, uint256 minMemeOut, address recipient)
        external
        payable
        returns (uint256 memeOut, uint256 quoteUsed, uint256 quoteRefund);

    /// @param memeIn Meme pulled from msg.sender via transferFrom.
    /// @return quoteOut Net quote delivered to `recipient`.
    function sell(address meme, uint256 memeIn, uint256 minQuoteOut, address recipient)
        external
        returns (uint256 quoteOut);

    function quoteBuy(address meme, uint256 quoteIn)
        external
        view
        returns (uint256 memeOut, uint256 quoteUsed, uint256 fee);
    function quoteSell(address meme, uint256 memeIn) external view returns (uint256 quoteOut, uint256 fee);

    /// @notice GraduationManager only. Sends unsold meme + poolReserveSupply and realQuote to `to`.
    function finalizeForGraduation(address meme, address to) external returns (uint256 memeOut, uint256 quoteOut);

    /// @notice Spot price in quote per 1e18 meme units, scaled by 1e18.
    function priceX18(address meme) external view returns (uint256);
    function progressBps(address meme) external view returns (uint256);
    function curveConfig(address meme) external view returns (CurveConfig memory);
    function curveState(address meme) external view returns (CurveState memory);
}
