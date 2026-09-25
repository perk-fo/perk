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
/// @notice Grant reserve custody, Merkle allocations with linear decay, earned invitee boosts and inviter credits drawn
///         from one shared inventory, locked full-range positions co-owned with the protocol, exits valued at the
///         hook's reference price, and burns (PRD 6 v0.14, ADR-007, ADR-008). One contract serves every launch.
/// @dev Owner == snapshot publisher (proposes roots). Everything else is permissionless or beneficiary-only.
contract LPGrantVault is IPerkLPGrantVault, Ownable2Step, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q96 = 1 << 96; // v4 sqrt-price fixed point
    uint16 internal constant INVITEE_BOOST_BPS = 1000; // PRD 6.4: 10% of base activated, up to the leaf's boost
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
    /// @inheritdoc IPerkLPGrantVault
    address public publisher;

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
    function setPublisher(address publisher_) external onlyOwner {
        emit PublisherUpdated(publisher, publisher_);
        publisher = publisher_;
    }

    /// @dev Roots are published by the appointed publisher (an automated key) or by the owner.
    modifier onlyPublisher() {
        if (msg.sender != publisher && msg.sender != owner()) revert NotPublisher();
        _;
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
        onlyPublisher
    {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.AWAITING_ROOT && c.status != CampaignStatus.ROOT_PROPOSED) {
            revert InvalidStatus(c.status);
        }
        // Measured from graduation, so re-proposing restarts the review of the new root but never the deadline.
        uint64 deadline = _rootDeadline(c);
        if (block.timestamp > deadline) revert RootDeadlinePassed(deadline);
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
    function cancelRoot(address meme) external onlyPublisher {
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
        emit GrantRootPublished(meme, c.root, c.startTime, c.endTime);
    }

    /// @inheritdoc IPerkLPGrantVault
    /// @dev A pending root blocks this: it was proposed before the deadline and becomes activatable after its delay,
    ///      so activation and cancellation never compete for the same moment.
    function cancelCampaign(address meme) external nonReentrant {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.AWAITING_ROOT) revert InvalidStatus(c.status);
        uint64 deadline = _rootDeadline(c);
        if (block.timestamp <= deadline) revert RootDeadlineNotReached(deadline);
        _burnReserve(meme, c, "CANCELLED");
    }

    /// @inheritdoc IPerkLPGrantVault
    /// @dev A rescued launch never reaches `initCampaign`, so without this its reserve would sit here for good. The
    ///      burn changes no holder's refund: GraduationManager already leaves this vault's balance out of the supply
    ///      that shares the refund, and burning it lowers that balance and the total supply alike.
    function burnRefundedReserve(address meme) external nonReentrant returns (uint256 burned) {
        if (IPerkLaunchFactory(factory).getLaunch(meme).status != PerkTypes.LaunchStatus.REFUNDING) {
            revert LaunchNotRefunding();
        }
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.NONE) revert InvalidStatus(c.status);
        burned = _burnReserve(meme, c, "REFUNDED");
    }

    /// @dev Cancels the campaign and burns everything the vault holds of `meme`, which is that launch's reserve.
    function _burnReserve(address meme, Campaign storage c, bytes32 reason) private returns (uint256 amount) {
        c.status = CampaignStatus.CANCELLED;
        amount = _burnHeld(meme, c, reason);
        emit CampaignCancelled(meme, amount);
    }

    /// @dev Burns the vault's whole balance of `meme`: reserve meme that never became a position.
    function _burnHeld(address meme, Campaign storage c, bytes32 reason) private returns (uint256 amount) {
        amount = IERC20(meme).balanceOf(address(this));
        c.burned += amount;
        if (amount > 0) IPerkMemeToken(meme).burn(amount);
        emit GrantMemeBurned(meme, amount, reason);
    }

    function _rootDeadline(Campaign storage c) private view returns (uint64) {
        return c.graduatedAt + _config.rootDeadlineSeconds;
    }

    /// @inheritdoc IPerkLPGrantVault
    /// @dev Exits settle their meme in the same transaction (paid out or burned), so the vault's balance of `meme` is
    ///      exactly reserve - totalActivated here.
    function finalizeGrant(address meme) external nonReentrant returns (uint256 unactivatedMemeBurned) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ACTIVE) revert InvalidStatus(c.status);
        if (block.timestamp < c.endTime) revert WindowClosed();
        c.status = CampaignStatus.EXPIRED;
        unactivatedMemeBurned = _burnHeld(meme, c, "EXPIRED");
        emit GrantFinalized(meme, unactivatedMemeBurned);
    }

    // ---------------------------------------------------------------------
    // Allocations
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function registerAllocation(address meme, GrantLeaf calldata leaf, bytes32[] calldata proof) external {
        Campaign storage c = _campaigns[meme];
        // Only the active root: it can no longer be cancelled or replaced, so a registration can never outlive it.
        if (c.status != CampaignStatus.ACTIVE) revert InvalidStatus(c.status);
        Allocation storage a = _allocations[meme][leaf.account];
        if (a.registered) revert AlreadyRegistered();
        if (!MerkleProof.verifyCalldata(proof, c.root, leafHash(leaf))) revert InvalidProof();
        // A tree whose leaves add up to more than it declared cannot hand out more than it declared.
        uint256 registeredBase = c.registeredBase + leaf.baseAllocation;
        uint256 registeredBoost = c.registeredInviteeBoost + leaf.inviteeBoost;
        if (registeredBase > c.rootTotalBase || registeredBoost > c.rootTotalInviteeBoost) revert RootBudgetExceeded();
        c.registeredBase = registeredBase;
        c.registeredInviteeBoost = registeredBoost;
        a.registered = true;
        a.baseAllocation = leaf.baseAllocation;
        a.inviteeBoost = leaf.inviteeBoost;
        a.baseNominalRemaining = leaf.baseAllocation;
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
        inviteeBoostClaimable = a.boostEarned - a.boostActivated;
        inviterCreditClaimable = a.inviterCreditEarned - a.inviterCreditActivated;
    }

    /// @inheritdoc IPerkLPGrantVault
    function inventoryRemaining(address meme) public view returns (uint256) {
        Campaign storage c = _campaigns[meme];
        if (c.status != CampaignStatus.ACTIVE) return 0;
        return c.reserve > c.totalActivated ? c.reserve - c.totalActivated : 0;
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
        // emergency pause stops new positions only: exits and fee collection stay open
        if (IPerkLaunchFactory(factory).isPaused(PerkConstants.PAUSE_GRANT_JOIN)) {
            revert IPerkLaunchFactory.Paused(PerkConstants.PAUSE_GRANT_JOIN);
        }
        uint256 total = baseAmount + boostAmount + creditAmount;
        if (total == 0) revert ZeroAmount();
        if (total < _config.minActivation) revert BelowMinimumActivation();
        // Checked first so a price off the reference is the error reported; read again below, after the pull.
        _requireStablePrice(c);
        // One shared inventory, first come first served: base, boost and credit all draw from the same reserve.
        uint256 remaining = inventoryRemaining(meme);
        if (total > remaining) revert InsufficientInventory(remaining);

        _consumeAllocation(meme, baseAmount, boostAmount, creditAmount);
        // Pulled before any price is read, so no outside call sits between the prices below and the mint.
        _pullQuote(c.quote, quoteMax);

        // The grant meme is paired at the pool price, so a price crashed for the occasion pairs it with a fraction
        // of the quote and then sells it to the attacker on the way back up. The prices read here, once, are the
        // ones the position opens at and its protocol share is fixed at.
        (uint160 sqrtP, int24 referenceTick) = _requireStablePrice(c);
        (uint256 quoteNeeded, uint128 liquidity) = _quoteRequiredAt(c, sqrtP, total);
        if (liquidity == 0 || liquidity < minLiquidity) revert InsufficientLiquidity();
        if (quoteNeeded > quoteMax) revert QuoteExceedsMax(quoteNeeded, quoteMax);

        (uint256 tokenId, uint256 memeUsed, uint256 quoteUsed) = _mint(meme, c, liquidity, quoteMax);
        if (quoteUsed > quoteMax) revert QuoteExceedsMax(quoteUsed, quoteMax);

        c.totalActivated += memeUsed;
        uint64 protocolShareWad = _protocolShare(c.memeIsCurrency0, memeUsed, quoteUsed, sqrtP, referenceTick);

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
                protocolShareWad: protocolShareWad,
                entrySqrtPriceX96: sqrtP,
                exited: false
            })
        );
        _positionsOf[msg.sender].push(positionId);

        if (baseAmount > 0) _earnInviterCredit(meme, c, msg.sender, baseAmount);

        emit GrantActivated(
            positionId, meme, msg.sender, baseAmount, boostAmount, creditAmount, quoteUsed, liquidity, protocolShareWad
        );
        // Last: the refund is the one call to the caller, made once every state change above is written.
        if (quoteMax > quoteUsed) c.quote.transfer(msg.sender, quoteMax - quoteUsed);
    }

    /// @dev g = memeValue / (memeValue + quoteDeposited): the grant meme's share of the position's value when it
    ///      opens, about 0.5 for a full-range position. The grant meme is valued both at the activation spot price
    ///      and at the hook's reference price and the larger share is kept, rounded up, so neither pushing the pool
    ///      down inside the activation band nor rounding shifts value to the beneficiary. Clamped to [1, 1e18 - 1].
    function _protocolShare(bool memeIsCurrency0, uint256 memeUsed, uint256 quoteUsed, uint160 sqrtP, int24 refTick)
        private
        pure
        returns (uint64)
    {
        uint256 atSpot = _share(_memeToQuote(memeIsCurrency0, memeUsed, sqrtP), quoteUsed);
        uint256 atRef = _share(_memeToQuote(memeIsCurrency0, memeUsed, TickMath.getSqrtPriceAtTick(refTick)), quoteUsed);
        uint256 g = Math.max(atSpot, atRef);
        if (g == 0) g = 1;
        else if (g >= WAD) g = WAD - 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(g);
    }

    function _share(uint256 memeValue, uint256 quoteUsed) private pure returns (uint256) {
        if (memeValue + quoteUsed == 0) return WAD / 2;
        return Math.mulDiv(memeValue, WAD, memeValue + quoteUsed, Math.Rounding.Ceil);
    }

    /// @inheritdoc IPerkLPGrantVault
    function quoteRequired(address meme, uint256 memeAmount)
        public
        view
        returns (uint256 quoteAmount, uint128 liquidity)
    {
        Campaign storage c = _campaigns[meme];
        return _quoteRequiredAt(c, _sqrtPrice(c), memeAmount);
    }

    function _quoteRequiredAt(Campaign storage c, uint160 sqrtP, uint256 memeAmount)
        private
        view
        returns (uint256 quoteAmount, uint128 liquidity)
    {
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

    /// @dev Base first (decaying nominal), then the invitee boost it earns, so a call can activate base and the
    ///      boost that base earns together. Boost and credit never earn anything themselves.
    function _consumeAllocation(address meme, uint256 baseAmount, uint256 boostAmount, uint256 creditAmount) private {
        Allocation storage a = _allocations[meme][msg.sender];
        if (baseAmount > 0) {
            if (!a.registered) revert NotRegistered();
            uint256 f = decayFactorX18(meme);
            if (baseAmount > (a.baseNominalRemaining * f) / 1e18) revert ExceedsClaimable();
            uint256 nominal = Math.mulDiv(baseAmount, 1e18, f, Math.Rounding.Ceil);
            a.baseNominalRemaining = nominal >= a.baseNominalRemaining ? 0 : a.baseNominalRemaining - nominal;
            a.baseActivated += baseAmount;
            // PRD 6.4 v0.14: the invitee boost is earned as base is actually activated, up to the leaf's boost.
            uint256 earned = Math.min(a.inviteeBoost, (a.baseActivated * INVITEE_BOOST_BPS) / PerkConstants.BPS);
            if (earned > a.boostEarned) {
                emit InviteeBoostEarned(meme, msg.sender, earned - a.boostEarned);
                a.boostEarned = earned;
            }
        }
        if (boostAmount > 0) {
            if (!a.registered) revert NotRegistered();
            if (boostAmount > a.boostEarned - a.boostActivated) revert ExceedsClaimable();
            a.boostActivated += boostAmount;
        }
        if (creditAmount > 0) {
            if (creditAmount > a.inviterCreditEarned - a.inviterCreditActivated) revert ExceedsClaimable();
            a.inviterCreditActivated += creditAmount;
        }
    }

    /// @dev PRD 6.4: only actually activated base allocation of a bound invitee earns the inviter a credit, 10% of it,
    ///      up to 50% of the inviter's own base. Credits are nominal: they reserve nothing and are only as good as
    ///      the shared inventory when the inviter activates them.
    function _earnInviterCredit(address meme, Campaign storage c, address invitee, uint256 baseActivated) private {
        IPerkReferralRegistry reg = IPerkReferralRegistry(referralRegistry);
        address inviter = reg.inviterOf(invitee);
        if (inviter == address(0) || !reg.isBoundBy(invitee, inviter, c.graduatedAtBlock)) return;
        Allocation storage ia = _allocations[meme][inviter];
        if (!ia.registered || ia.baseAllocation == 0) return; // ADR-007: inviter must have registered its own leaf

        uint256 requested = (baseActivated * INVITER_CREDIT_BPS) / PerkConstants.BPS;
        uint256 cap = (ia.baseAllocation * INVITER_CAP_BPS) / PerkConstants.BPS;
        uint256 capRoom = cap > ia.inviterCreditEarned ? cap - ia.inviterCreditEarned : 0;
        uint256 granted = Math.min(requested, capRoom);
        if (granted < requested) emit ReferralCreditCapped(meme, inviter, requested, granted);
        if (granted == 0) return;
        ia.inviterCreditEarned += granted;
        emit InviterCreditEarned(meme, inviter, invitee, granted);
    }

    // ---------------------------------------------------------------------
    // Fees and exits
    // ---------------------------------------------------------------------

    /// @inheritdoc IPerkLPGrantVault
    function collectGrantFees(uint256 positionId)
        external
        nonReentrant
        returns (uint256 quoteFeesPaid, uint256 memeFeesPaid)
    {
        GrantPosition storage p = _positions[positionId];
        if (p.exited) revert AlreadyExited();
        (quoteFeesPaid, memeFeesPaid) = _collect(p);
        emit GrantFeesCollected(positionId, quoteFeesPaid, memeFeesPaid);
        _pay(p, quoteFeesPaid, memeFeesPaid);
    }

    /// @inheritdoc IPerkLPGrantVault
    function exitGrantPosition(uint256 positionId, uint256 minQuoteOut, uint256 minMemeOut)
        external
        nonReentrant
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned)
    {
        GrantPosition storage p = _positions[positionId];
        if (msg.sender != p.beneficiary) revert NotBeneficiary();
        if (p.exited) revert AlreadyExited();
        Campaign storage c = _campaigns[p.meme];
        uint64 exitableAt = p.activatedAt + c.minLpSeconds;
        if (block.timestamp < exitableAt) revert MinLpNotElapsed(exitableAt);
        // Never refused on price: the settlement is valued at the reference price, not at spot.

        // fees first so principal and fees are accounted separately (PRD 6.8); both sides go to the beneficiary,
        // paid together with the principal once everything else is done
        (uint256 quoteFees, uint256 memeFees) = _collect(p);
        emit GrantFeesCollected(positionId, quoteFees, memeFees);

        (uint256 memeOut, uint256 quoteOut) = _burnPosition(p);
        p.exited = true;

        (quoteToUser, memeToUser, quoteToTreasury, memeBurned) =
            _settle(c, quoteOut, memeOut, p.protocolShareWad, _referenceSqrtPrice(c));
        if (quoteToUser < minQuoteOut || memeToUser < minMemeOut) revert SlippageExceeded();

        // `c.burned` deliberately tracks only reserve meme that never became a position (cancel / finalize);
        // meme burned here is already accounted for by the position's `grantMemeAmount`.
        if (memeBurned > 0) IPerkMemeToken(p.meme).burn(memeBurned);
        emit GrantMemeBurned(p.meme, memeBurned, "EXIT");
        if (quoteToTreasury > 0) _depositTreasury(p.meme, c.quote, quoteToTreasury);
        emit GrantPositionExited(positionId, quoteToUser, memeToUser, quoteToTreasury, memeBurned);
        // Last: every transfer to the beneficiary, fees and principal together.
        _pay(p, quoteFees + quoteToUser, memeFees + memeToUser);
    }

    /// @inheritdoc IPerkLPGrantVault
    function exitPreview(uint256 positionId)
        external
        view
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned)
    {
        GrantPosition storage p = _positions[positionId];
        if (p.exited || p.beneficiary == address(0)) return (0, 0, 0, 0);
        Campaign storage c = _campaigns[p.meme];
        (uint256 memeOut, uint256 quoteOut) = _principal(c, p.liquidity);
        return _settle(c, quoteOut, memeOut, p.protocolShareWad, _referenceSqrtPrice(c));
    }

    /// @dev PRD 6 v0.14 co-ownership settlement. V = quoteOut + memeOut at P; the beneficiary is owed
    ///      E = V * (1 - g), paid in quote first and the rest in meme at P, each leg capped by what the position
    ///      returned. Whatever is left is the protocol's share: quote to the treasury, meme to the burn.
    function _settle(Campaign storage c, uint256 quoteOut, uint256 memeOut, uint64 g, uint160 sqrtP)
        private
        view
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned)
    {
        uint256 value = quoteOut + _memeToQuote(c.memeIsCurrency0, memeOut, sqrtP);
        uint256 entitled = Math.mulDiv(value, WAD - g, WAD);
        quoteToUser = Math.min(quoteOut, entitled);
        if (entitled > quoteToUser) {
            memeToUser = Math.min(memeOut, _quoteToMeme(c.memeIsCurrency0, entitled - quoteToUser, sqrtP));
        }
        quoteToTreasury = quoteOut - quoteToUser;
        memeBurned = memeOut - memeToUser;
    }

    /// @dev Reverts while the pool price is away from the hook's rate-limited reference, i.e. while it is a price
    ///      that has not yet held long enough to be believed. Guards activation only: exits never wait on it.
    function _requireStablePrice(Campaign storage c) private view returns (uint160 sqrtP, int24 referenceTick) {
        int24 spotTick;
        (spotTick, referenceTick) = IPerkComposableHook(address(c.key.hooks)).referencePrice(c.poolId);
        int256 gap = int256(spotTick) - int256(referenceTick);
        if ((gap < 0 ? uint256(-gap) : uint256(gap)) > _config.maxPriceDeviationTicks) {
            revert PriceUnstable(spotTick, referenceTick);
        }
        sqrtP = _sqrtPrice(c);
    }

    function _sqrtPrice(Campaign storage c) private view returns (uint160 sqrtP) {
        (sqrtP,,,) = POOL_MANAGER.getSlot0(c.poolId);
    }

    /// @dev The exit price: the hook's rate-limited reference tick as a v4 sqrt price. Always the tick's price, even
    ///      when the pool sits in that same tick, so an exit made after moving the pool within a block is valued at
    ///      exactly the price an honest exit in that block gets.
    ///      Known residual: the reference follows the pool at up to 8 ticks per second. A pump held off-market long
    ///      enough for the reference to follow lets a large position sell its meme share to the protocol at the
    ///      pumped price (quote first at the reference). Same-block manipulation is unprofitable; the cost of this
    ///      one grows with how long the price must be held against arbitrage.
    function _referenceSqrtPrice(Campaign storage c) private view returns (uint160) {
        // forge-lint: disable-next-line(unused-return)
        (, int24 referenceTick) = IPerkComposableHook(address(c.key.hooks)).referencePrice(c.poolId);
        return TickMath.getSqrtPriceAtTick(referenceTick);
    }

    /// @dev Quote value of `memeAmount` at the v4 sqrt price `sqrtP`. v4 quotes currency0 in currency1, so the price
    ///      is (sqrtP / 2^96)^2 quote per meme when meme is currency0 and its inverse otherwise. Raw token units on
    ///      both sides, so any quote decimals work unchanged.
    function _memeToQuote(bool memeIsCurrency0, uint256 memeAmount, uint160 sqrtP) private pure returns (uint256) {
        if (memeIsCurrency0) return Math.mulDiv(Math.mulDiv(memeAmount, sqrtP, Q96), sqrtP, Q96);
        return Math.mulDiv(Math.mulDiv(memeAmount, Q96, sqrtP), Q96, sqrtP);
    }

    /// @dev Meme units worth `quoteAmount` at `sqrtP`, rounded down: the inverse of `_memeToQuote`.
    function _quoteToMeme(bool memeIsCurrency0, uint256 quoteAmount, uint160 sqrtP) private pure returns (uint256) {
        if (memeIsCurrency0) return Math.mulDiv(Math.mulDiv(quoteAmount, Q96, sqrtP), Q96, sqrtP);
        return Math.mulDiv(Math.mulDiv(quoteAmount, sqrtP, Q96), sqrtP, Q96);
    }

    /// @dev What burning `liquidity` of the campaign's range returns now, rounded down exactly as the PoolManager
    ///      rounds a liquidity removal (and branching on the pool tick as it does).
    function _principal(Campaign storage c, uint128 liquidity)
        private
        view
        returns (uint256 memeOut, uint256 quoteOut)
    {
        (uint160 sqrtP, int24 tick,,) = POOL_MANAGER.getSlot0(c.poolId);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(c.tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(c.tickUpper);
        uint256 amount0 = 0;
        uint256 amount1 = 0;
        if (tick < c.tickLower) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, false);
        } else if (tick < c.tickUpper) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtUpper, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtP, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, false);
        }
        (memeOut, quoteOut) = c.memeIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
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

    /// @dev Collects accrued fees only (decrease by 0) into the vault; the caller pays them to the beneficiary.
    function _collect(GrantPosition storage p) private returns (uint256 quoteFees, uint256 memeFees) {
        Campaign storage c = _campaigns[p.meme];
        bytes memory actions = abi.encodePacked(_actionByte(Actions.DECREASE_LIQUIDITY), _actionByte(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(p.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(c.key.currency0, c.key.currency1, address(this));
        (uint256 memeDelta, uint256 quoteDelta) = _run(p.meme, c.quote, abi.encode(actions, params));
        memeFees = memeDelta;
        quoteFees = quoteDelta;
    }

    /// @dev Pays the beneficiary. Trading fees settle separately from principal and go to the beneficiary in full,
    ///      both currencies (PRD 6 v0.14).
    function _pay(GrantPosition storage p, uint256 quoteAmount, uint256 memeAmount) private {
        if (memeAmount > 0) IERC20(p.meme).safeTransfer(p.beneficiary, memeAmount);
        if (quoteAmount > 0) p.quote.transfer(p.beneficiary, quoteAmount);
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
