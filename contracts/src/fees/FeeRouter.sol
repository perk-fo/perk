// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {IPerkFeeRouter} from "../interfaces/IPerkFeeRouter.sol";
import {IPerkHolderRewardDistributor} from "../interfaces/IPerkHolderRewardDistributor.sol";
import {IPerkCommunityTreasury} from "../interfaces/IPerkCommunityTreasury.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";

/// @title FeeRouter
/// @notice Routes the 50/25/15/5/5 quote-fee split for curve and hook stages.
contract FeeRouter is IPerkFeeRouter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    error AlreadyWired();
    error InvalidSplit();

    /// @inheritdoc IPerkFeeRouter
    address public immutable override factory;
    /// @inheritdoc IPerkFeeRouter
    address public immutable override distributor;
    /// @inheritdoc IPerkFeeRouter
    address public immutable override treasury;
    /// @inheritdoc IPerkFeeRouter
    address public immutable override protocolFeeRecipient;

    /// @inheritdoc IPerkFeeRouter
    address public override hook;
    /// @inheritdoc IPerkFeeRouter
    address public override graduationManager;

    mapping(address meme => LaunchFees) private _launches;
    mapping(Currency quote => uint256) private _protocolClaimable;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @param owner_ Two-step Ownable owner.
    /// @param factory_ Launch factory allowed to register memes.
    /// @param distributor_ Holder-reward distributor that receives the rewards share.
    /// @param treasury_ Community treasury that receives the treasury share.
    /// @param protocolFeeRecipient_ Recipient of the protocol share.
    constructor(
        address owner_,
        address factory_,
        address distributor_,
        address treasury_,
        address protocolFeeRecipient_
    ) Ownable(_nonZero(owner_)) {
        if (
            factory_ == address(0) || distributor_ == address(0) || treasury_ == address(0)
                || protocolFeeRecipient_ == address(0)
        ) {
            revert ZeroAddress();
        }
        factory = factory_;
        distributor = distributor_;
        treasury = treasury_;
        protocolFeeRecipient = protocolFeeRecipient_;
    }

    /// @notice Accepts native quote taken by the hook before `collectFee`.
    receive() external payable {}

    /// @notice One-time wiring of the hook and graduation manager deployed after this router.
    /// @param hook_ Composable hook allowed to collect HOOK-source fees.
    /// @param graduationManager_ Graduation manager allowed to release the LP reserve.
    function wire(address hook_, address graduationManager_) external onlyOwner {
        if (hook != address(0)) revert AlreadyWired();
        if (hook_ == address(0) || graduationManager_ == address(0)) revert ZeroAddress();
        hook = hook_;
        // One-time wire; no interface event exists for this assignment.
        // forge-lint: disable-next-line(missing-events-access-control)
        graduationManager = graduationManager_;
    }

    /// @inheritdoc IPerkFeeRouter
    function registerLaunch(
        address meme,
        Currency quote,
        address dev,
        address curve,
        uint24 totalFeeBps,
        PerkTypes.FeeSplit calldata split
    ) external onlyFactory {
        if (meme == address(0) || dev == address(0) || curve == address(0)) revert ZeroAddress();
        LaunchFees storage launch = _launches[meme];
        if (launch.registered) revert AlreadyRegistered();
        if (
            uint256(split.devBps) + split.rewardsBps + split.lpBps + split.treasuryBps + split.protocolBps
                != PerkConstants.BPS
        ) {
            revert InvalidSplit();
        }

        launch.quote = quote;
        launch.dev = dev;
        launch.curve = curve;
        launch.totalFeeBps = totalFeeBps;
        launch.split = split;
        launch.registered = true;

        emit LaunchRegistered(meme, quote, dev, curve);

        if (!quote.isAddressZero()) {
            IERC20(Currency.unwrap(quote)).forceApprove(distributor, type(uint256).max);
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function collectFee(address meme, PerkTypes.FeeSource source, uint256 amount) external payable {
        LaunchFees storage launch = _launches[meme];
        if (!launch.registered) revert NotRegistered();

        if (source == PerkTypes.FeeSource.CURVE) {
            if (msg.sender != launch.curve) revert NotAuthorizedSource();
        } else if (source == PerkTypes.FeeSource.HOOK) {
            if (msg.sender != hook) revert NotAuthorizedSource();
        } else {
            revert NotAuthorizedSource();
        }

        bool native = launch.quote.isAddressZero();
        if (native) {
            if (source == PerkTypes.FeeSource.CURVE) {
                if (msg.value != amount) revert NativeAmountMismatch();
            } else if (msg.value != 0) {
                revert NativeAmountMismatch();
            }
        } else if (msg.value != 0) {
            revert NativeAmountMismatch();
        }

        (uint256 dev, uint256 rewards, uint256 lp, uint256 treasuryShare, uint256 protocol) =
            _splitFee(amount, source, launch.split);

        launch.devClaimable += dev;
        launch.lpReserve += lp;
        launch.treasuryPending += treasuryShare;
        _protocolClaimable[launch.quote] += protocol;

        // Accrue is the only external call, and it runs after this emit.
        // forge-lint: disable-next-line(reentrancy-events)
        emit FeesRouted(meme, source, amount, dev, rewards, lp, treasuryShare, protocol);

        if (rewards != 0) {
            if (native) {
                IPerkHolderRewardDistributor(distributor).accrueQuoteRewards{value: rewards}(meme, rewards);
            } else {
                IPerkHolderRewardDistributor(distributor).accrueQuoteRewards(meme, rewards);
            }
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function claimDevFees(address meme) external nonReentrant returns (Currency quote, uint256 quotePaid) {
        LaunchFees storage launch = _launches[meme];
        quote = launch.quote;
        quotePaid = launch.devClaimable;
        launch.devClaimable = 0;
        address to = launch.dev;
        emit DevFeesClaimed(meme, to, quotePaid);
        if (quotePaid != 0) {
            CurrencyLibrary.transfer(quote, to, quotePaid);
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function setDevRecipient(address meme, address newDev) external nonReentrant {
        LaunchFees storage launch = _launches[meme];
        if (msg.sender != launch.dev) revert NotDev();
        if (newDev == address(0)) revert ZeroAddress();
        address oldDev = launch.dev;
        launch.dev = newDev;
        emit DevRecipientUpdated(meme, oldDev, newDev);
    }

    /// @inheritdoc IPerkFeeRouter
    function pushTreasuryFees(address meme) external nonReentrant returns (uint256 amount) {
        LaunchFees storage launch = _launches[meme];
        amount = launch.treasuryPending;
        launch.treasuryPending = 0;
        bytes32 launchRef = keccak256(abi.encode(block.chainid, factory, meme));
        emit TreasuryFeesPushed(meme, amount);
        if (launch.quote.isAddressZero()) {
            IPerkCommunityTreasury(treasury).deposit{value: amount}(launch.quote, amount, launchRef);
        } else {
            IERC20(Currency.unwrap(launch.quote)).forceApprove(treasury, amount);
            IPerkCommunityTreasury(treasury).deposit(launch.quote, amount, launchRef);
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function claimProtocolFees(Currency quote) external nonReentrant returns (uint256 amount) {
        amount = _protocolClaimable[quote];
        _protocolClaimable[quote] = 0;
        emit ProtocolFeesClaimed(quote, protocolFeeRecipient, amount);
        if (amount != 0) {
            CurrencyLibrary.transfer(quote, protocolFeeRecipient, amount);
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function releaseLpReserve(address meme, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != graduationManager) revert NotGraduationManager();
        LaunchFees storage launch = _launches[meme];
        amount = launch.lpReserve;
        launch.lpReserve = 0;
        emit LpReserveReleased(meme, to, amount);
        if (amount != 0) {
            CurrencyLibrary.transfer(launch.quote, to, amount);
        }
    }

    /// @inheritdoc IPerkFeeRouter
    function launchFees(address meme) external view returns (LaunchFees memory) {
        return _launches[meme];
    }

    /// @inheritdoc IPerkFeeRouter
    function protocolClaimable(Currency quote) external view returns (uint256) {
        return _protocolClaimable[quote];
    }

    function _nonZero(address account) private pure returns (address) {
        if (account == address(0)) revert ZeroAddress();
        return account;
    }

    function _splitFee(uint256 amount, PerkTypes.FeeSource source, PerkTypes.FeeSplit memory split)
        private
        pure
        returns (uint256 dev, uint256 rewards, uint256 lp, uint256 treasuryShare, uint256 protocol)
    {
        if (source == PerkTypes.FeeSource.CURVE) {
            uint256 bps = PerkConstants.BPS;
            dev = Math.mulDiv(amount, split.devBps, bps);
            rewards = Math.mulDiv(amount, split.rewardsBps, bps);
            lp = Math.mulDiv(amount, split.lpBps, bps);
            treasuryShare = Math.mulDiv(amount, split.treasuryBps, bps);
            protocol = amount - dev - rewards - lp - treasuryShare;
        } else {
            uint256 d = PerkConstants.BPS - split.lpBps;
            dev = Math.mulDiv(amount, split.devBps, d);
            rewards = Math.mulDiv(amount, split.rewardsBps, d);
            treasuryShare = Math.mulDiv(amount, split.treasuryBps, d);
            protocol = amount - dev - rewards - treasuryShare;
        }
    }
}
