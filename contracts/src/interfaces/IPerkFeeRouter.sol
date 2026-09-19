// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title IPerkFeeRouter
/// @notice Records and routes the fixed 50/25/15/5/5 split (PRD 7.1) for both the curve stage and the hook stage.
/// @dev Funds-first convention: the authorized caller makes the quote arrive at this contract (native value, ERC-20
///      transfer, or PoolManager.take to this address) and then calls `collectFee` to account for it.
///      The rewards share is forwarded to the distributor inside `collectFee`; every other share is pull-claimed.
///      Rounding remainder goes to the protocol bucket so that sum(shares) == amount exactly (PRD 12.5).
interface IPerkFeeRouter {
    struct LaunchFees {
        Currency quote;
        address dev;
        address curve;
        uint24 totalFeeBps;
        PerkTypes.FeeSplit split;
        bool registered;
        uint256 devClaimable;
        /// @dev Curve-stage LP share, released to GraduationManager at graduation (PRD 7.2).
        uint256 lpReserve;
        uint256 treasuryPending;
    }

    event LaunchRegistered(address indexed meme, Currency indexed quote, address dev, address curve);
    event FeesRouted(
        address indexed meme,
        PerkTypes.FeeSource source,
        uint256 amount,
        uint256 devShare,
        uint256 rewardsShare,
        uint256 lpShare,
        uint256 treasuryShare,
        uint256 protocolShare
    );
    event DevFeesClaimed(address indexed meme, address indexed dev, uint256 amount);
    event DevRecipientUpdated(address indexed meme, address indexed oldDev, address indexed newDev);
    event TreasuryFeesPushed(address indexed meme, uint256 amount);
    event ProtocolFeesClaimed(Currency indexed quote, address indexed to, uint256 amount);
    event LpReserveReleased(address indexed meme, address indexed to, uint256 amount);

    error NotFactory();
    error NotAuthorizedSource();
    error NotDev();
    error NotGraduationManager();
    error NotRegistered();
    error AlreadyRegistered();
    error NativeAmountMismatch();
    error ZeroAddress();

    function factory() external view returns (address);
    function hook() external view returns (address);
    function graduationManager() external view returns (address);
    function treasury() external view returns (address);
    function distributor() external view returns (address);
    function protocolFeeRecipient() external view returns (address);

    /// @notice Factory only.
    function registerLaunch(
        address meme,
        Currency quote,
        address dev,
        address curve,
        uint24 totalFeeBps,
        PerkTypes.FeeSplit calldata split
    ) external;

    /// @notice Curve (source CURVE) or hook (source HOOK) only. `amount` must already be held by this contract.
    /// @dev CURVE: `amount` is the whole 1.00% fee, split 5 ways, LP share kept as lpReserve.
    ///      HOOK: `amount` is the 0.85% hook fee, split 4 ways over (10_000 - lpBps).
    function collectFee(address meme, PerkTypes.FeeSource source, uint256 amount) external payable;

    /// @notice Anyone may trigger; pays the dev of record.
    function claimDevFees(address meme) external returns (Currency quote, uint256 quotePaid);

    /// @notice Current dev only. Affects future claims only (PRD 7.5).
    function setDevRecipient(address meme, address newDev) external;

    /// @notice Anyone may trigger; sends pending treasury share to CommunityTreasury with launchId as ref.
    function pushTreasuryFees(address meme) external returns (uint256 amount);

    /// @notice Anyone may trigger; pays protocolFeeRecipient.
    function claimProtocolFees(Currency quote) external returns (uint256 amount);

    /// @notice GraduationManager only.
    function releaseLpReserve(address meme, address to) external returns (uint256 amount);

    function launchFees(address meme) external view returns (LaunchFees memory);
    function protocolClaimable(Currency quote) external view returns (uint256);
}
