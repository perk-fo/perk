// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {IPerkHolderRewardDistributor} from "../interfaces/IPerkHolderRewardDistributor.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";

/// @title HolderRewardDistributor
/// @notice Pull-based quote-reward accumulator shared by every registered meme token.
contract HolderRewardDistributor is IPerkHolderRewardDistributor, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    /// @inheritdoc IPerkHolderRewardDistributor
    address public immutable override factory;

    mapping(address meme => MemeRewardState state) private _rewardState;
    mapping(address meme => mapping(address account => bool)) private _excluded;
    mapping(address meme => mapping(address account => uint256)) private _eligibleBalance;
    mapping(address meme => mapping(address account => uint256)) private _rewardDebt;
    mapping(address meme => mapping(address account => uint256)) private _settled;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @param factory_ Launch factory that is allowed to register memes.
    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function registerMeme(
        address meme,
        Currency quote,
        address feeRouter,
        uint256 minEligibleBalance,
        address[] calldata excluded
    ) external onlyFactory {
        if (meme == address(0) || feeRouter == address(0)) revert ZeroAddress();
        MemeRewardState storage state_ = _rewardState[meme];
        if (state_.registered) revert AlreadyRegistered();

        state_.quote = quote;
        state_.feeRouter = feeRouter;
        state_.minEligibleBalance = minEligibleBalance;
        state_.registered = true;

        emit MemeRegistered(meme, quote, feeRouter, minEligibleBalance);

        uint256 len = excluded.length;
        for (uint256 i; i < len; ++i) {
            _exclude(meme, excluded[i]);
        }
        _exclude(meme, address(0));
        _exclude(meme, PerkConstants.DEAD_ADDRESS);
        _exclude(meme, address(this));
        _exclude(meme, meme);
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function onBalanceChange(address account, uint256, uint256 newBalance) external {
        address meme = msg.sender;
        MemeRewardState storage state_ = _rewardState[meme];
        if (!state_.registered) return;
        if (_excluded[meme][account]) return;

        _settle(meme, account, state_);

        uint256 eOld = _eligibleBalance[meme][account];
        uint256 eNew = newBalance >= state_.minEligibleBalance ? newBalance : 0;
        _eligibleBalance[meme][account] = eNew;
        _rewardDebt[meme][account] = Math.mulDiv(eNew, state_.accQuotePerShare, PerkConstants.REWARD_PRECISION);
        _adjustEligibleSupply(state_, eOld, eNew);
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function accrueQuoteRewards(address meme, uint256 quoteAmount) external payable {
        MemeRewardState storage state_ = _rewardState[meme];
        if (!state_.registered) revert NotRegistered();
        if (msg.sender != state_.feeRouter) revert NotFeeRouter();

        _pullQuote(state_, quoteAmount);
        _creditQuoteRewards(meme, state_, quoteAmount);
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function claimQuoteRewards(address meme) external nonReentrant returns (Currency quote, uint256 quotePaid) {
        (quote, quotePaid) = _claim(meme, msg.sender);
        if (quotePaid != 0) {
            CurrencyLibrary.transfer(quote, msg.sender, quotePaid);
        }
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function claimQuoteRewardsFor(address meme, address account)
        external
        nonReentrant
        returns (Currency quote, uint256 quotePaid)
    {
        (quote, quotePaid) = _claim(meme, account);
        if (quotePaid != 0) {
            CurrencyLibrary.transfer(quote, account, quotePaid);
        }
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function claimableQuoteRewards(address meme, address account)
        external
        view
        returns (Currency quote, uint256 quoteAmount)
    {
        MemeRewardState storage state_ = _rewardState[meme];
        quote = state_.quote;
        quoteAmount = _pendingQuote(meme, account, state_);
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function rewardState(address meme) external view returns (MemeRewardState memory) {
        return _rewardState[meme];
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function isExcluded(address meme, address account) external view returns (bool) {
        return _excluded[meme][account];
    }

    /// @inheritdoc IPerkHolderRewardDistributor
    function eligibleBalanceOf(address meme, address account) external view returns (uint256) {
        return _eligibleBalance[meme][account];
    }

    function _claim(address meme, address account) private returns (Currency quote, uint256 quotePaid) {
        MemeRewardState storage state_ = _rewardState[meme];
        quote = state_.quote;
        if (!state_.registered) {
            return (quote, 0);
        }

        _settle(meme, account, state_);
        _rewardDebt[meme][account] =
            Math.mulDiv(_eligibleBalance[meme][account], state_.accQuotePerShare, PerkConstants.REWARD_PRECISION);

        quotePaid = _settled[meme][account];
        if (quotePaid == 0) {
            return (quote, 0);
        }
        _settled[meme][account] = 0;

        // forge-lint: disable-next-line(reentrancy-events)
        emit QuoteRewardsClaimed(meme, account, quotePaid);
    }

    function _pullQuote(MemeRewardState storage state_, uint256 quoteAmount) private {
        if (state_.quote.isAddressZero()) {
            if (msg.value != quoteAmount) revert NativeAmountMismatch();
        } else {
            if (msg.value != 0) revert NativeAmountMismatch();
            IERC20(Currency.unwrap(state_.quote)).safeTransferFrom(msg.sender, address(this), quoteAmount);
        }
    }

    function _creditQuoteRewards(address meme, MemeRewardState storage state_, uint256 quoteAmount) private {
        uint256 total = quoteAmount + state_.pendingUndistributed;
        state_.pendingUndistributed = 0;

        uint256 supply = state_.eligibleSupply;
        if (supply == 0) {
            state_.pendingUndistributed = total;
            // forge-lint: disable-next-line(reentrancy-events)
            emit QuoteRewardsHeld(meme, total);
            return;
        }

        uint256 precision = PerkConstants.REWARD_PRECISION;
        // scaled = total * PRECISION + carry; acc += scaled / supply; carry = scaled % supply
        uint256 increment = Math.mulDiv(total, precision, supply);
        uint256 remSum = mulmod(total, precision, supply) + state_.carry;
        increment += remSum / supply;
        state_.carry = remSum % supply;
        state_.accQuotePerShare += increment;

        // forge-lint: disable-next-line(reentrancy-events)
        emit QuoteRewardsAccrued(meme, total, supply, state_.accQuotePerShare);
    }

    function _settle(address meme, address account, MemeRewardState storage state_) private {
        uint256 accumulated =
            Math.mulDiv(_eligibleBalance[meme][account], state_.accQuotePerShare, PerkConstants.REWARD_PRECISION);
        uint256 debt = _rewardDebt[meme][account];
        if (accumulated > debt) {
            unchecked {
                _settled[meme][account] += accumulated - debt;
            }
        }
    }

    function _pendingQuote(address meme, address account, MemeRewardState storage state_)
        private
        view
        returns (uint256)
    {
        uint256 accumulated = Math.mulDiv(
            _eligibleBalance[meme][account], state_.accQuotePerShare, PerkConstants.REWARD_PRECISION
        );
        uint256 debt = _rewardDebt[meme][account];
        uint256 unsettled = accumulated > debt ? accumulated - debt : 0;
        return _settled[meme][account] + unsettled;
    }

    function _adjustEligibleSupply(MemeRewardState storage state_, uint256 eOld, uint256 eNew) private {
        uint256 supply = state_.eligibleSupply;
        if (eNew >= eOld) {
            uint256 delta = eNew - eOld;
            if (supply > type(uint256).max - delta) {
                state_.eligibleSupply = type(uint256).max;
            } else {
                state_.eligibleSupply = supply + delta;
            }
        } else {
            uint256 delta = eOld - eNew;
            state_.eligibleSupply = supply >= delta ? supply - delta : 0;
        }
    }

    function _exclude(address meme, address account) private {
        if (_excluded[meme][account]) return;
        _excluded[meme][account] = true;
        emit RewardEligibilityUpdated(meme, account, true);
    }
}
