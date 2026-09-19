// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";

/// @title IPerkHolderRewardDistributor
/// @notice Pull-based Quote Rewards accumulator (PRD 7.4). One immutable contract serves every meme.
/// @dev Invariants (PRD 11.1 #12 #13 #14 #15):
///      - only the registered meme token can checkpoint its holders;
///      - only the meme's FeeRouter can accrue quote;
///      - excluded addresses never count toward eligible supply;
///      - a new holder never receives rewards accrued before their balance changed;
///      - `onBalanceChange` MUST NOT revert for a registered meme and MUST silently return for an unregistered caller.
interface IPerkHolderRewardDistributor {
    struct MemeRewardState {
        Currency quote;
        address feeRouter;
        uint256 minEligibleBalance;
        uint256 eligibleSupply;
        /// @dev Scaled by PerkConstants.REWARD_PRECISION.
        uint256 accQuotePerShare;
        /// @dev Integer remainder carried into the next accrual (PRD 7.4).
        uint256 carry;
        /// @dev Quote received while eligibleSupply == 0, folded into the next accrual (PRD 7.4).
        uint256 pendingUndistributed;
        bool registered;
    }

    event MemeRegistered(address indexed meme, Currency indexed quote, address feeRouter, uint256 minEligibleBalance);
    event RewardEligibilityUpdated(address indexed meme, address indexed account, bool excluded);
    event QuoteRewardsAccrued(
        address indexed meme, uint256 quoteAmount, uint256 eligibleSupply, uint256 accQuotePerShare
    );
    event QuoteRewardsHeld(address indexed meme, uint256 quoteAmount);
    event QuoteRewardsClaimed(address indexed meme, address indexed account, uint256 quoteAmount);

    error NotFactory();
    error NotFeeRouter();
    error AlreadyRegistered();
    error NotRegistered();
    error NativeAmountMismatch();
    error ZeroAddress();

    function factory() external view returns (address);

    /// @notice Registers a meme before its token is deployed (address is CREATE2-predicted). Factory only.
    /// @param excluded System addresses that never count as holders: PoolManager, curve, factory, vault, locker,
    ///        fee router, treasury, this distributor, address(0), 0xdead. Fixed at registration (PRD 7.5).
    function registerMeme(
        address meme,
        Currency quote,
        address feeRouter,
        uint256 minEligibleBalance,
        address[] calldata excluded
    ) external;

    /// @notice Checkpoint hook called by the meme token (msg.sender) for each side of a transfer, after balances moved.
    /// @dev Settles `account`'s accrued rewards at its OLD eligible balance, then re-bases reward debt at the NEW one.
    function onBalanceChange(address account, uint256 oldBalance, uint256 newBalance) external;

    /// @notice Adds quote to the meme's accumulator. FeeRouter only.
    /// @dev Native quote: msg.value == quoteAmount. ERC-20 quote: pulled via transferFrom(msg.sender).
    function accrueQuoteRewards(address meme, uint256 quoteAmount) external payable;

    function claimQuoteRewards(address meme) external returns (Currency quote, uint256 quotePaid);

    /// @notice Anyone may trigger a claim; funds always go to `account` (PRD 7.4).
    function claimQuoteRewardsFor(address meme, address account) external returns (Currency quote, uint256 quotePaid);

    function claimableQuoteRewards(address meme, address account)
        external
        view
        returns (Currency quote, uint256 quoteAmount);
    function rewardState(address meme) external view returns (MemeRewardState memory);
    function isExcluded(address meme, address account) external view returns (bool);
    function eligibleBalanceOf(address meme, address account) external view returns (uint256);
}
