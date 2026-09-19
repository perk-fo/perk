// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// Time windows are the mechanism here (decay, delays, deadlines); every state-changing entry point is nonReentrant.
// forge-lint: disable-start(block-timestamp)
// forge-lint: disable-start(reentrancy-events)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Permit2Forwarder} from "v4-periphery/src/base/Permit2Forwarder.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

import {IPerkLPGrantVault} from "../interfaces/IPerkLPGrantVault.sol";
import {IPerkComposableHook} from "../interfaces/IPerkComposableHook.sol";
import {IPerkLaunchFactory} from "../interfaces/IPerkLaunchFactory.sol";
import {IPerkTemplateRegistry} from "../interfaces/IPerkTemplateRegistry.sol";
import {IPerkReferralRegistry} from "../interfaces/IPerkReferralRegistry.sol";
import {IPerkCommunityTreasury} from "../interfaces/IPerkCommunityTreasury.sol";
import {IPerkMemeToken} from "../interfaces/IPerkMemeToken.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";

/// @title LPGrantVault
/// @notice Grant reserve custody, Merkle allocations with linear decay, referral credits, locked full-range positions,
///         principal-capped exits and burns (PRD 6, ADR-007, ADR-008). One contract serves every launch.
/// @dev Owner == snapshot publisher (proposes roots). Everything else is permissionless or beneficiary-only.
contract LPGrantVault is IPerkLPGrantVault, Ownable2Step, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant PRECISION = 1e36;
    uint256 internal constant Q96 = 1 << 96; // v4 sqrt-price fixed point
    uint16 internal constant INVITEE_BOOST_BPS = 1000; // PRD 6.4: 10% of base
    uint16 internal constant INVITER_CREDIT_BPS = 1000; // PRD 6.4: 10% of invitee base activated
    uint16 internal constant INVITER_CAP_BPS = 5000; // PRD 6.4: 50% of inviter base

    address public immutable factory;
    address public immutable templateRegistry;
    address public immutable referralRegistry;
    address public immutable treasury;
    IPoolManager internal immutable POOL_MANAGER;
    address public immutable positionManager;
    IAllowanceTransfer internal immutable PERMIT2;
    Config private _config;

    address public graduationManager;

    mapping(address meme => Campaign) private _campaigns;
    mapping(address meme => mapping(address account => Allocation)) private _allocations;
    GrantPosition[] private _positions; // index 0 unused
    mapping(address beneficiary => uint256[]) private _positionsOf;
    mapping(address token => bool) private _permit2Approved;

    constructor(
        address owner_,
        address factory_,
        address templateRegistry_,
        address referralRegistry_,
        address treasury_,
        address poolManager_,
        address positionManager_,
        IPerkLPGrantVault.Config memory config_
    ) Ownable(owner_) {
        if (
            factory_ == address(0) || templateRegistry_ == address(0) || referralRegistry_ == address(0)
                || treasury_ == address(0) || poolManager_ == address(0) || positionManager_ == address(0)
        ) revert ZeroAddress();
        factory = factory_;
        templateRegistry = templateRegistry_;
        referralRegistry = referralRegistry_;
        treasury = treasury_;
        POOL_MANAGER = IPoolManager(poolManager_);
        positionManager = positionManager_;
        PERMIT2 = Permit2Forwarder(positionManager_).permit2();
        _config = config_;
        _positions.push(); // reserve id 0
    }

    receive() external payable {}

    /// @notice One-time wiring of the GraduationManager (deployed after the vault). Owner only.
    function wire(address graduationManager_) external onlyOwner {
        if (graduationManager != address(0)) revert AlreadyWired();
        if (graduationManager_ == address(0)) revert ZeroAddress();
        graduationManager = graduationManager_;
        emit Wired(graduationManager_);
    }

    /// @inheritdoc IPerkLPGrantVault
    function config() external view returns (Config memory) {
        return _config;
    }

    function poolManager() external view returns (address) {
        return address(POOL_MANAGER);
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function initCampaign(address meme, PoolKey calldata key, bool memeIsCurrency0, int24 tickLower, int24 tickUpper)
        external
    {
        if (msg.sender != graduationManager) revert NotGraduationManager();
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.NONE) revert CampaignExists();

        PerkTypes.LaunchRecord memory rec = IPerkLaunchFactory(factory).getLaunch(meme);
        PerkTypes.Template memory tmpl = IPerkTemplateRegistry(templateRegistry).getTemplate(rec.templateId);
        if (!tmpl.grant.enabled) revert InvalidStatus(CampaignStatus.NONE);
        uint256 reserve = tmpl.supply.grantReserveSupply;
        if (IERC20(meme).balanceOf(address(this)) < reserve) revert InsufficientLiquidity();

        uint256 referralBudget = (reserve * tmpl.grant.referralBudgetBps) / PerkConstants.BPS;
        c.status = CampaignStatus.AWAITING_ROOT;
        c.quote = rec.quote;
        c.key = key;
        c.poolId = key.toId();
        c.memeIsCurrency0 = memeIsCurrency0;
        c.tickLower = tickLower;
        c.tickUpper = tickUpper;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.graduatedAt = uint64(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        c.graduatedAtBlock = uint64(block.number);
        c.windowSeconds = tmpl.grant.windowSeconds;
        c.minLpSeconds = tmpl.grant.minLpSeconds;
        c.reserve = reserve;
        c.referralBudget = referralBudget;
        c.basePool = reserve - referralBudget;

        emit CampaignInitialized(meme, c.poolId, reserve, c.basePool, referralBudget);
    }

    /// @inheritdoc IPerkLPGrantVault
    function proposeRoot(address meme, bytes32 root, string calldata uri, uint256 totalBase, uint256 totalInviteeBoost)
        external
        onlyOwner
    {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.AWAITING_ROOT && c.status != CampaignStatus.ROOT_PROPOSED) {
            revert InvalidStatus(c.status);
        }
        if (totalBase > c.basePool || totalInviteeBoost > c.referralBudget) revert RootBudgetExceeded();
        c.status = CampaignStatus.ROOT_PROPOSED;
        c.root = root;
        c.rootUri = uri;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.rootProposedAt = uint64(block.timestamp);
        c.rootTotalBase = totalBase;
        c.rootTotalInviteeBoost = totalInviteeBoost;
        emit GrantRootProposed(
            meme, root, uri, totalBase, totalInviteeBoost, c.rootProposedAt + _config.rootDelaySeconds
        );
    }

    /// @inheritdoc IPerkLPGrantVault
    function cancelRoot(address meme) external onlyOwner {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ROOT_PROPOSED) revert InvalidStatus(c.status);
        bytes32 old = c.root;
        c.status = CampaignStatus.AWAITING_ROOT;
        c.root = bytes32(0);
        c.rootUri = "";
        c.rootProposedAt = 0;
        c.rootTotalBase = 0;
        c.rootTotalInviteeBoost = 0;
        emit GrantRootCancelled(meme, old);
    }

    /// @inheritdoc IPerkLPGrantVault
    function activateRoot(address meme) external {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ROOT_PROPOSED) revert InvalidStatus(c.status);
        uint64 activatableAt = c.rootProposedAt + _config.rootDelaySeconds;
        if (block.timestamp < activatableAt) revert RootDelayNotElapsed(activatableAt);
        c.status = CampaignStatus.ACTIVE;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.startTime = uint64(block.timestamp);
        c.endTime = c.startTime + c.windowSeconds;
        c.referralBudgetUsed = c.rootTotalInviteeBoost; // PRD 6.4: invitee boosts are reserved first
        emit GrantRootPublished(meme, c.root, c.startTime, c.endTime);
    }

    /// @inheritdoc IPerkLPGrantVault
    function cancelCampaign(address meme) external nonReentrant {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.AWAITING_ROOT && c.status != CampaignStatus.ROOT_PROPOSED) {
            revert InvalidStatus(c.status);
        }
        uint64 deadline = c.graduatedAt + _config.rootDeadlineSeconds;
        if (block.timestamp <= deadline) revert RootDeadlineNotReached(deadline);
        c.status = CampaignStatus.CANCELLED;
        uint256 amount = IERC20(meme).balanceOf(address(this));
        c.burned += amount;
        if (amount > 0) IPerkMemeToken(meme).burn(amount);
        emit GrantMemeBurned(meme, amount, "CANCELLED");
        emit CampaignCancelled(meme, amount);
    }

    /// @inheritdoc IPerkLPGrantVault
    function finalizeGrant(address meme) external nonReentrant returns (uint256 unactivatedMemeBurned) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ACTIVE) revert InvalidStatus(c.status);
        if (block.timestamp < c.endTime) revert WindowClosed();
        c.status = CampaignStatus.EXPIRED;
        unactivatedMemeBurned = IERC20(meme).balanceOf(address(this));
        c.burned += unactivatedMemeBurned;
        if (unactivatedMemeBurned > 0) IPerkMemeToken(meme).burn(unactivatedMemeBurned);
        emit GrantMemeBurned(meme, unactivatedMemeBurned, "EXPIRED");
        emit GrantFinalized(meme, unactivatedMemeBurned);
    }

    /// @inheritdoc IPerkLPGrantVault
    function sweepIncentive(address meme) external nonReentrant returns (uint256 toTreasury) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.EXPIRED) revert InvalidStatus(c.status);
        if (c.activeLiquidity != 0 || c.incentiveBalance == 0) revert NothingToSweep();
        toTreasury = c.incentiveBalance;
        c.incentiveBalance = 0;
        _depositTreasury(meme, c.quote, toTreasury);
        emit IncentiveSwept(meme, toTreasury);
    }

    // ---------------------------------------------------------------------
    // Allocations
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function registerAllocation(address meme, GrantLeaf calldata leaf, bytes32[] calldata proof) external {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ROOT_PROPOSED && c.status != CampaignStatus.ACTIVE) {
            revert InvalidStatus(c.status);
        }
        Allocation storage a = _allocations[meme][leaf.account];
        if (a.registered) revert AlreadyRegistered();
        if (!MerkleProof.verifyCalldata(proof, c.root, leafHash(leaf))) revert InvalidProof();
        a.registered = true;
        a.baseAllocation = leaf.baseAllocation;
        a.inviteeBoost = leaf.inviteeBoost;
        a.baseNominalRemaining = leaf.baseAllocation;
        a.boostNominalRemaining = leaf.inviteeBoost;
        emit AllocationRegistered(meme, leaf.account, leaf.baseAllocation, leaf.inviteeBoost);
    }

    /// @inheritdoc IPerkLPGrantVault
    function leafHash(GrantLeaf calldata leaf) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(leaf.account, leaf.baseAllocation, leaf.inviteeBoost))));
    }

    /// @inheritdoc IPerkLPGrantVault
    function decayFactorX18(address meme) public view returns (uint256) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ACTIVE || block.timestamp >= c.endTime) return 0;
        return ((c.endTime - block.timestamp) * 1e18) / (c.endTime - c.startTime);
    }

    /// @inheritdoc IPerkLPGrantVault
    function grantBreakdown(address meme, address account)
        public
        view
        returns (uint256 baseClaimable, uint256 inviteeBoostClaimable, uint256 inviterCreditClaimable)
    {
        uint256 f = decayFactorX18(meme);
        if (f == 0) return (0, 0, 0);
        Allocation storage a = _allocations[meme][account];
        baseClaimable = (a.baseNominalRemaining * f) / 1e18;
        inviteeBoostClaimable = (a.boostNominalRemaining * f) / 1e18;
        inviterCreditClaimable = a.inviterCreditEarned - a.inviterCreditActivated;
    }

    // ---------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function activateGrant(
        address meme,
        uint256 baseAmount,
        uint256 boostAmount,
        uint256 creditAmount,
        uint256 quoteMax,
        uint128 minLiquidity
    ) external payable nonReentrant returns (uint256 positionId) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ACTIVE || block.timestamp >= c.endTime) revert WindowClosed();
        uint256 total = baseAmount + boostAmount + creditAmount;
        if (total == 0) revert ZeroAmount();
        if (total < _config.minActivation) revert BelowMinimumActivation();
        // The grant meme is paired at the pool price, so a price crashed for the occasion pairs it with a fraction
        // of the quote and then sells it to the attacker on the way back up.
        _requireStablePrice(c);

        _consumeAllocation(meme, c, baseAmount, boostAmount, creditAmount);

        (uint256 quoteNeeded, uint128 liquidity) = quoteRequired(meme, total);
        if (liquidity == 0 || liquidity < minLiquidity) revert InsufficientLiquidity();
        if (quoteNeeded > quoteMax) revert QuoteExceedsMax(quoteNeeded, quoteMax);
        _pullQuote(c.quote, quoteMax);

        (uint256 tokenId, uint256 memeUsed, uint256 quoteUsed) = _mint(meme, c, liquidity, quoteMax);
        if (quoteUsed > quoteMax) revert QuoteExceedsMax(quoteUsed, quoteMax);
        if (quoteMax > quoteUsed) c.quote.transfer(msg.sender, quoteMax - quoteUsed);

        c.activeLiquidity += liquidity;
        c.totalActivated += memeUsed;

        positionId = _positions.length;
        _positions.push(
            GrantPosition({
                beneficiary: msg.sender,
                meme: meme,
                quote: c.quote,
                poolId: c.poolId,
                tokenId: tokenId,
                grantMemeAmount: memeUsed,
                baseMemeActivated: baseAmount,
                inviteeBoostActivated: boostAmount,
                inviterCreditActivated: creditAmount,
                quoteDeposited: quoteUsed,
                liquidity: liquidity,
                tickLower: c.tickLower,
                tickUpper: c.tickUpper,
                // forge-lint: disable-next-line(unsafe-typecast)
                activatedAt: uint64(block.timestamp),
                entrySqrtPriceX96: _sqrtPrice(c),
                incentiveDebt: Math.mulDiv(liquidity, c.accIncentivePerLiquidity, PRECISION),
                incentiveSettled: 0,
                exited: false
            })
        );
        _positionsOf[msg.sender].push(positionId);

        if (baseAmount > 0) _earnInviterCredit(meme, c, msg.sender, baseAmount);

        emit GrantActivated(positionId, meme, msg.sender, baseAmount, boostAmount, creditAmount, quoteUsed, liquidity);
    }

    /// @inheritdoc IPerkLPGrantVault
    function quoteRequired(address meme, uint256 memeAmount)
        public
        view
        returns (uint256 quoteAmount, uint128 liquidity)
    {
        Campaign storage c = _campaigns[meme];
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(c.poolId);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(c.tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(c.tickUpper);
        if (sqrtP <= sqrtLower) sqrtP = sqrtLower + 1;
        if (sqrtP >= sqrtUpper) sqrtP = sqrtUpper - 1;
        if (c.memeIsCurrency0) {
            liquidity = LiquidityAmounts.getLiquidityForAmount0(sqrtP, sqrtUpper, memeAmount);
            quoteAmount = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtP, liquidity, true);
        } else {
            liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtP, memeAmount);
            quoteAmount = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtUpper, liquidity, true);
        }
    }

    function _consumeAllocation(
        address meme,
        Campaign storage c,
        uint256 baseAmount,
        uint256 boostAmount,
        uint256 creditAmount
    ) private {
        Allocation storage a = _allocations[meme][msg.sender];
        if (baseAmount > 0 || boostAmount > 0) {
            if (!a.registered) revert NotRegistered();
            uint256 f = decayFactorX18(meme);
            if (baseAmount > 0) {
                if (baseAmount > (a.baseNominalRemaining * f) / 1e18) revert ExceedsClaimable();
                uint256 nominal = Math.mulDiv(baseAmount, 1e18, f, Math.Rounding.Ceil);
                a.baseNominalRemaining = nominal >= a.baseNominalRemaining ? 0 : a.baseNominalRemaining - nominal;
            }
            if (boostAmount > 0) {
                if (boostAmount > (a.boostNominalRemaining * f) / 1e18) revert ExceedsClaimable();
                uint256 nominal = Math.mulDiv(boostAmount, 1e18, f, Math.Rounding.Ceil);
                a.boostNominalRemaining = nominal >= a.boostNominalRemaining ? 0 : a.boostNominalRemaining - nominal;
            }
        }
        if (creditAmount > 0) {
            if (creditAmount > a.inviterCreditEarned - a.inviterCreditActivated) revert ExceedsClaimable();
            a.inviterCreditActivated += creditAmount;
        }
        c; // silence unused warning in case of future use
    }

    /// @dev PRD 6.4: only actually activated base allocation of a bound invitee earns the inviter a credit.
    function _earnInviterCredit(address meme, Campaign storage c, address invitee, uint256 baseActivated) private {
        IPerkReferralRegistry reg = IPerkReferralRegistry(referralRegistry);
        address inviter = reg.inviterOf(invitee);
        if (inviter == address(0) || !reg.isBoundBy(invitee, inviter, c.graduatedAtBlock)) return;
        Allocation storage ia = _allocations[meme][inviter];
        if (!ia.registered || ia.baseAllocation == 0) return; // ADR-007: inviter must have registered its own leaf

        uint256 requested = (baseActivated * INVITER_CREDIT_BPS) / PerkConstants.BPS;
        uint256 cap = (ia.baseAllocation * INVITER_CAP_BPS) / PerkConstants.BPS;
        uint256 capRoom = cap > ia.inviterCreditEarned ? cap - ia.inviterCreditEarned : 0;
        uint256 budgetRoom = c.referralBudget > c.referralBudgetUsed ? c.referralBudget - c.referralBudgetUsed : 0;
        uint256 granted = Math.min(requested, Math.min(capRoom, budgetRoom));
        if (granted < requested) emit ReferralCreditCapped(meme, inviter, requested, granted);
        if (granted == 0) return;
        ia.inviterCreditEarned += granted;
        c.referralBudgetUsed += granted;
        emit InviterCreditEarned(meme, inviter, invitee, granted);
    }

    // ---------------------------------------------------------------------
    // Fees and exits
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function collectGrantFees(uint256 positionId)
        public
        nonReentrant
        returns (uint256 quoteFeesPaid, uint256 memeFeesPaid, uint256 incentivePaid)
    {
        GrantPosition storage p = _positions[positionId];
        if (p.exited) revert AlreadyExited();
        (quoteFeesPaid, memeFeesPaid) = _collect(p);
        incentivePaid = _payIncentive(p);
        emit GrantFeesCollected(positionId, quoteFeesPaid, memeFeesPaid, incentivePaid);
    }

    /// @inheritdoc IPerkLPGrantVault
    function exitGrantPosition(uint256 positionId, uint256 minQuoteOut, uint256 minMemeOut)
        external
        nonReentrant
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 excessQuote, uint256 memeBurned)
    {
        GrantPosition storage p = _positions[positionId];
        if (msg.sender != p.beneficiary) revert NotBeneficiary();
        if (p.exited) revert AlreadyExited();
        uint64 exitableAt = p.activatedAt + _campaigns[p.meme].minLpSeconds;
        if (block.timestamp < exitableAt) revert MinLpNotElapsed(exitableAt);

        // The settlement below is indifferent to the exit price, but the excess it routes to the incentive pool is
        // not: a price pumped for the occasion turns the attacker's own swaps into "excess" that a second position
        // of theirs collects.
        _requireStablePrice(_campaigns[p.meme]);

        // fees first so principal and fees are accounted separately (PRD 6.8); both sides go to the beneficiary
        (uint256 quoteFees, uint256 memeFees) = _collect(p);
        emit GrantFeesCollected(positionId, quoteFees, memeFees, 0);

        Campaign storage c = _campaigns[p.meme];
        (uint256 memeOut, uint256 quoteOut) = _burnPosition(p);
        p.exited = true;
        c.activeLiquidity -= p.liquidity;

        // ADR-008 §5: the beneficiary is owed their quote deposit. Quote pays it first; grant meme covers whatever
        // the position's quote side no longer can, converted at the geometric mean of the entry and exit prices.
        //
        // That conversion price is not a free choice. The exit price is the exiting LP's to move, and every swap
        // they make is partly a trade against their own position. Priced at spot, a crash before exiting bought the
        // shortfall a multiple of the meme it was worth; priced at entry, a pump before exiting converted a meme
        // top-up into quote. With liquidity l the round trip from the true price P to p and back costs exactly
        // l(sqrt(P) - sqrt(p))^2 / sqrt(p), and meme = shortfall / sqrt(P_entry * P_exit) is the one payout whose
        // change cancels that cost in both directions: moving the price around an exit gains nothing before swap
        // fees and loses them after. It never asks for more meme than the position returns (the top-up is
        // G(1-q)/q against G/q withdrawn, q = sqrt(P_exit / P_entry)); the clamp below only absorbs rounding.
        quoteToUser = Math.min(quoteOut, p.quoteDeposited);
        excessQuote = quoteOut - quoteToUser;
        uint256 shortfall = p.quoteDeposited - quoteToUser;
        if (shortfall > 0) {
            memeToUser = Math.min(_shortfallInMeme(c, shortfall, p.entrySqrtPriceX96, _sqrtPrice(c)), memeOut);
        }
        memeBurned = memeOut - memeToUser;
        if (quoteToUser < minQuoteOut || memeToUser < minMemeOut) revert SlippageExceeded();

        // `c.burned` deliberately tracks only reserve meme that never became a position (cancel / finalize);
        // meme burned here is already accounted for by the position's `grantMemeAmount`.
        if (memeBurned > 0) IPerkMemeToken(p.meme).burn(memeBurned);
        emit GrantMemeBurned(p.meme, memeBurned, "EXIT");

        uint256 incentivePaid = _payIncentive(p);
        _routeExcess(p.meme, c, excessQuote);
        if (quoteToUser > 0) p.quote.transfer(p.beneficiary, quoteToUser);
        if (memeToUser > 0) IERC20(p.meme).safeTransfer(p.beneficiary, memeToUser);

        emit GrantPositionExited(positionId, quoteToUser, memeToUser, excessQuote, memeBurned, incentivePaid);
    }

    /// @dev Reverts while the pool price is away from the hook's rate-limited reference, i.e. while it is a price
    ///      that has not yet held long enough to be believed.
    function _requireStablePrice(Campaign storage c) private view {
        (int24 spotTick, int24 referenceTick) = IPerkComposableHook(address(c.key.hooks)).referencePrice(c.poolId);
        int256 gap = int256(spotTick) - int256(referenceTick);
        if ((gap < 0 ? uint256(-gap) : uint256(gap)) > _config.maxPriceDeviationTicks) {
            revert PriceUnstable(spotTick, referenceTick);
        }
    }

    function _sqrtPrice(Campaign storage c) private view returns (uint160 sqrtP) {
        (sqrtP,,,) = POOL_MANAGER.getSlot0(c.poolId);
    }

    /// @dev Meme units worth `quoteAmount` at the geometric mean of two pool prices, given as v4 sqrt prices. The
    ///      geometric mean of the prices is the product of their square roots, so no root is taken here. v4 quotes
    ///      currency0 in currency1: the product is the meme price when meme is currency0 and its inverse otherwise.
    ///      Both sides are raw token units, so a quote with fewer than 18 decimals needs no special case.
    function _shortfallInMeme(Campaign storage c, uint256 quoteAmount, uint160 sqrtEntry, uint160 sqrtExit)
        private
        view
        returns (uint256)
    {
        if (c.memeIsCurrency0) {
            return Math.mulDiv(Math.mulDiv(quoteAmount, Q96, sqrtEntry), Q96, sqrtExit);
        }
        return Math.mulDiv(Math.mulDiv(quoteAmount, sqrtEntry, Q96), sqrtExit, Q96);
    }

    /// @dev ADR-008: exit excess is recycled to grant liquidity that is still working; the rest (or all of it once
    ///      nobody is left) goes to the Community Treasury.
    function _routeExcess(address meme, Campaign storage c, uint256 excess) private {
        if (excess == 0) return;
        uint256 toPool = (excess * _config.excessToIncentiveBps) / PerkConstants.BPS;
        if (c.activeLiquidity == 0) toPool = 0;
        uint256 toTreasury = excess - toPool;
        if (toPool > 0) {
            c.incentiveBalance += toPool;
            c.accIncentivePerLiquidity += Math.mulDiv(toPool, PRECISION, c.activeLiquidity);
        }
        if (toTreasury > 0) _depositTreasury(meme, c.quote, toTreasury);
        emit ExcessQuoteRouted(meme, toPool, toTreasury);
    }

    function _payIncentive(GrantPosition storage p) private returns (uint256 paid) {
        Campaign storage c = _campaigns[p.meme];
        uint256 accrued = Math.mulDiv(p.liquidity, c.accIncentivePerLiquidity, PRECISION);
        uint256 pending = p.incentiveSettled + (accrued > p.incentiveDebt ? accrued - p.incentiveDebt : 0);
        p.incentiveDebt = accrued;
        p.incentiveSettled = 0;
        if (pending == 0) return 0;
        if (pending > c.incentiveBalance) pending = c.incentiveBalance; // rounding guard
        c.incentiveBalance -= pending;
        p.quote.transfer(p.beneficiary, pending);
        return pending;
    }

    /// @inheritdoc IPerkLPGrantVault
    function pendingIncentive(uint256 positionId) external view returns (uint256) {
        GrantPosition storage p = _positions[positionId];
        Campaign storage c = _campaigns[p.meme];
        uint256 accrued = Math.mulDiv(p.liquidity, c.accIncentivePerLiquidity, PRECISION);
        return p.incentiveSettled + (accrued > p.incentiveDebt ? accrued - p.incentiveDebt : 0);
    }

    // ---------------------------------------------------------------------
    // PositionManager plumbing
    // ---------------------------------------------------------------------

    function _mint(address meme, Campaign storage c, uint128 liquidity, uint256 quoteMax)
        private
        returns (uint256 tokenId, uint256 memeUsed, uint256 quoteUsed)
    {
        _approvePosm(c.key.currency0);
        _approvePosm(c.key.currency1);
        tokenId = IPositionManager(positionManager).nextTokenId();

        bytes memory actions = abi.encodePacked(
            _actionByte(Actions.MINT_POSITION),
            _actionByte(Actions.SETTLE_PAIR),
            _actionByte(Actions.SWEEP),
            _actionByte(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(
            c.key,
            c.tickLower,
            c.tickUpper,
            uint256(liquidity),
            type(uint128).max,
            type(uint128).max,
            address(this),
            bytes("")
        );
        params[1] = abi.encode(c.key.currency0, c.key.currency1);
        params[2] = abi.encode(c.key.currency0, address(this));
        params[3] = abi.encode(c.key.currency1, address(this));

        uint256 memeBefore = IERC20(meme).balanceOf(address(this));
        uint256 quoteBefore = c.quote.balanceOfSelf();
        uint256 nativeValue = c.quote.isAddressZero() ? quoteMax : 0;
        // Deadline is the current block; the modifier is `>` so equality is valid.
        // forge-lint: disable-next-line(block-timestamp)
        IPositionManager(positionManager).modifyLiquidities{value: nativeValue}(
            abi.encode(actions, params), block.timestamp
        );
        memeUsed = memeBefore - IERC20(meme).balanceOf(address(this));
        quoteUsed = quoteBefore - c.quote.balanceOfSelf();
    }

    /// @dev Collects accrued fees only (decrease by 0). Quote fees go to the beneficiary, meme fees are burned.
    function _collect(GrantPosition storage p) private returns (uint256 quoteFees, uint256 memeFees) {
        Campaign storage c = _campaigns[p.meme];
        bytes memory actions = abi.encodePacked(_actionByte(Actions.DECREASE_LIQUIDITY), _actionByte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(p.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(c.key.currency0, c.key.currency1, address(this));
        (uint256 memeDelta, uint256 quoteDelta) = _run(p.meme, c.quote, abi.encode(actions, params));
        memeFees = memeDelta;
        quoteFees = quoteDelta;
        // ADR-008 §5: trading fees settle separately from principal and go to the beneficiary on both sides.
        if (memeFees > 0) IERC20(p.meme).safeTransfer(p.beneficiary, memeFees);
        if (quoteFees > 0) p.quote.transfer(p.beneficiary, quoteFees);
    }

    function _burnPosition(GrantPosition storage p) private returns (uint256 memeOut, uint256 quoteOut) {
        Campaign storage c = _campaigns[p.meme];
        bytes memory actions = abi.encodePacked(_actionByte(Actions.BURN_POSITION), _actionByte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(p.tokenId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(c.key.currency0, c.key.currency1, address(this));
        (memeOut, quoteOut) = _run(p.meme, c.quote, abi.encode(actions, params));
    }

    function _run(address meme, Currency quote, bytes memory payload)
        private
        returns (uint256 memeDelta, uint256 quoteDelta)
    {
        uint256 memeBefore = IERC20(meme).balanceOf(address(this));
        uint256 quoteBefore = quote.balanceOfSelf();
        // forge-lint: disable-next-line(block-timestamp)
        IPositionManager(positionManager).modifyLiquidities(payload, block.timestamp);
        memeDelta = IERC20(meme).balanceOf(address(this)) - memeBefore;
        quoteDelta = quote.balanceOfSelf() - quoteBefore;
    }

    function _pullQuote(Currency quote, uint256 amount) private {
        if (quote.isAddressZero()) {
            if (msg.value != amount) revert NativeAmountMismatch();
        } else {
            if (msg.value != 0) revert NativeAmountMismatch();
            IERC20(Currency.unwrap(quote)).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _depositTreasury(address meme, Currency quote, uint256 amount) private {
        bytes32 ref = keccak256(abi.encode(block.chainid, factory, meme));
        if (quote.isAddressZero()) {
            IPerkCommunityTreasury(treasury).deposit{value: amount}(quote, amount, ref);
        } else {
            IERC20(Currency.unwrap(quote)).forceApprove(treasury, amount);
            IPerkCommunityTreasury(treasury).deposit(quote, amount, ref);
        }
    }

    function _approvePosm(Currency currency) private {
        if (currency.isAddressZero()) return;
        address token = Currency.unwrap(currency);
        if (_permit2Approved[token]) return;
        _permit2Approved[token] = true;
        IERC20(token).forceApprove(address(PERMIT2), type(uint256).max);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        PERMIT2.approve(token, positionManager, type(uint160).max, type(uint48).max);
    }

    function _actionByte(uint256 action) private pure returns (bytes1) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes1(uint8(action));
    }

    /// @notice Accepts position NFTs minted by the PositionManager only.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != positionManager) revert NotPositionManager();
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function campaign(address meme) external view returns (Campaign memory) {
        return _campaigns[meme];
    }

    /// @inheritdoc IPerkLPGrantVault
    function allocation(address meme, address account) external view returns (Allocation memory) {
        return _allocations[meme][account];
    }

    /// @inheritdoc IPerkLPGrantVault
    function position(uint256 positionId) external view returns (GrantPosition memory) {
        return _positions[positionId];
    }

    /// @inheritdoc IPerkLPGrantVault
    function positionsOf(address beneficiary) external view returns (uint256[] memory) {
        return _positionsOf[beneficiary];
    }
}
// forge-lint: disable-end(reentrancy-events)
// forge-lint: disable-end(block-timestamp)
