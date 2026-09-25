// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IPerkLPGrantVault
/// @notice Holds every Perk Launch's 15% grant reserve, turns Merkle allocations into locked v4 positions co-owned by
///         the beneficiary and the protocol, settles fees and exits, and burns whatever never becomes liquidity
///         (PRD 6 v0.14, ADR-007/008).
/// @dev One contract serves every launch. A grant position is co-owned pro rata to what each side put in: the
///      beneficiary's quote deposit and the protocol's grant meme, valued at the activation price. That split, the
///      protocol share `g`, is frozen at activation. At exit the position is valued at the hook's rate-limited
///      reference price; the beneficiary receives `1 - g` of it (quote first, the rest in meme), the protocol's
///      remaining quote goes to the Community Treasury and its remaining meme is burned. Trading fees go to the
///      beneficiary in full. Grant meme leaves the vault only into the official pool (activation), into the burn, or
///      to a beneficiary at exit out of the meme their own position returned.
interface IPerkLPGrantVault {
    enum CampaignStatus {
        NONE,
        AWAITING_ROOT, // graduated, reserve escrowed, no root yet
        ROOT_PROPOSED, // root published, public recomputation window running
        ACTIVE, // decaying allocations can be activated
        EXPIRED, // window over, unactivated meme burned by finalizeGrant
        CANCELLED // no root before the deadline, or the launch was refunded instead of graduating; reserve burned
    }

    struct Campaign {
        CampaignStatus status;
        Currency quote;
        PoolKey key;
        PoolId poolId;
        bool memeIsCurrency0;
        int24 tickLower;
        int24 tickUpper;
        uint64 graduatedAt;
        uint64 graduatedAtBlock;
        uint64 windowSeconds;
        uint64 minLpSeconds;
        uint64 startTime;
        uint64 endTime;
        uint256 reserve;
        uint256 basePool;
        uint256 referralBudget;
        uint256 totalActivated; // meme that became liquidity; the shared inventory left is reserve - totalActivated
        uint256 burned;
        bytes32 root;
        string rootUri; // public dataset (PRD 6.2)
        uint64 rootProposedAt;
        uint256 rootTotalBase;
        uint256 rootTotalInviteeBoost;
        uint256 registeredBase; // base allocations registered under the active root, at most rootTotalBase
        uint256 registeredInviteeBoost; // invitee boosts registered under the active root, at most rootTotalInviteeBoost
    }

    struct Allocation {
        bool registered;
        uint256 baseAllocation; // nominal base from the leaf
        uint256 inviteeBoost; // cap on the invitee boost, from the leaf (10% of base for a bound invitee)
        uint256 baseNominalRemaining; // nominal base not yet activated; claimable = this * decay factor
        uint256 baseActivated; // meme activated from base, cumulative
        uint256 boostEarned; // min(inviteeBoost, 10% of baseActivated); never decays, expires at window end
        uint256 boostActivated;
        uint256 inviterCreditEarned; // 10% of each bound invitee's base activated, capped at 50% of baseAllocation
        uint256 inviterCreditActivated;
    }

    struct GrantPosition {
        address beneficiary;
        address meme;
        Currency quote;
        PoolId poolId;
        uint256 tokenId;
        uint256 grantMemeAmount;
        uint256 baseMemeActivated;
        uint256 inviteeBoostActivated;
        uint256 inviterCreditActivated;
        uint256 quoteDeposited;
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
        uint64 activatedAt;
        // protocol share g (1e18 = 100%): the grant meme's value over the position's value at activation, the meme
        // valued at the larger of the spot and reference prices, rounded up; frozen
        uint64 protocolShareWad;
        uint160 entrySqrtPriceX96; // pool price when the position was opened
        bool exited;
    }

    /// @dev Vault-level parameters fixed at deployment (ADR-008 §6).
    struct Config {
        uint64 rootDelaySeconds; // public recomputation window between proposeRoot and activateRoot
        // roots may be proposed until this long after graduation; after it, a campaign with no root pending can be
        // cancelled by anyone (reserve burned), and a root proposed in time can still be activated after its delay
        uint64 rootDeadlineSeconds;
        uint256 minActivation; // smallest grant meme amount per activation
        uint24 maxPriceDeviationTicks; // positions open only this close to the hook's reference price; exits never wait
    }

    struct GrantLeaf {
        address account;
        uint256 baseAllocation;
        uint256 inviteeBoost;
    }

    event CampaignInitialized(
        address indexed meme, PoolId indexed poolId, uint256 reserve, uint256 basePool, uint256 referralBudget
    );
    event GrantRootProposed(
        address indexed meme,
        bytes32 root,
        string uri,
        uint256 totalBase,
        uint256 totalInviteeBoost,
        uint64 activatableAt
    );
    event GrantRootCancelled(address indexed meme, bytes32 root);
    event GrantRootPublished(address indexed meme, bytes32 root, uint64 startTime, uint64 endTime);
    event CampaignCancelled(address indexed meme, uint256 memeBurned);
    event AllocationRegistered(
        address indexed meme, address indexed account, uint256 baseAllocation, uint256 inviteeBoost
    );
    event InviterCreditEarned(address indexed meme, address indexed inviter, address indexed invitee, uint256 amount);
    /// @notice The account's invitee boost grew by `amount` because it activated base allocation.
    event InviteeBoostEarned(address indexed meme, address indexed account, uint256 amount);
    /// @notice An inviter credit was clipped by the cap of 50% of the inviter's own base allocation.
    event ReferralCreditCapped(address indexed meme, address indexed inviter, uint256 requested, uint256 granted);
    event GrantActivated(
        uint256 indexed positionId,
        address indexed meme,
        address indexed beneficiary,
        uint256 baseActivated,
        uint256 inviteeBoostActivated,
        uint256 inviterCreditActivated,
        uint256 quoteDeposited,
        uint128 liquidity,
        uint64 protocolShareWad
    );
    event GrantFeesCollected(uint256 indexed positionId, uint256 quoteFeesPaid, uint256 memeFeesPaid);
    event GrantPositionExited(
        uint256 indexed positionId, uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned
    );
    event GrantMemeBurned(address indexed meme, uint256 amount, bytes32 reason);
    event GrantFinalized(address indexed meme, uint256 unactivatedMemeBurned);
    event Wired(address indexed graduationManager);
    /// @notice The grant publisher changed: the one address besides the owner that may propose or cancel roots.
    event PublisherUpdated(address indexed previous, address indexed current);

    error NotGraduationManager();
    error NotPublisher();
    error NotBeneficiary();
    error CampaignExists();
    error InvalidStatus(CampaignStatus current);
    error RootDelayNotElapsed(uint64 activatableAt);
    error RootDeadlineNotReached(uint64 deadline);
    error RootBudgetExceeded();
    error InvalidProof();
    error AlreadyRegistered();
    error NotRegistered();
    error WindowClosed();
    error ExceedsClaimable();
    error BelowMinimumActivation();
    error QuoteExceedsMax(uint256 required, uint256 max);
    error InsufficientLiquidity();
    error NativeAmountMismatch();
    error MinLpNotElapsed(uint64 exitableAt);
    error AlreadyExited();
    error SlippageExceeded();
    error ZeroAmount();
    error ZeroAddress();
    error AlreadyWired();
    error NotPositionManager();
    /// @dev The pool price is further from the hook's reference price than the vault accepts for an activation. It
    ///      clears on its own as the reference catches up; see IPerkComposableHook.referencePrice. Exits never check it.
    error PriceUnstable(int24 spotTick, int24 referenceTick);
    /// @dev Roots can no longer be proposed for this campaign: its root deadline has passed.
    error RootDeadlinePassed(uint64 deadline);
    /// @dev The launch is not REFUNDING, so its grant reserve is not burned through `burnRefundedReserve`.
    error LaunchNotRefunding();
    /// @dev The activation asks for more grant meme than the campaign's shared inventory still holds. Base, invitee
    ///      boost and inviter credit all draw from the one reserve, first come first served.
    error InsufficientInventory(uint256 remaining);

    // ---- wiring ----
    /// @notice One-time wiring of the GraduationManager (owner only).
    function wire(address graduationManager) external;
    /// @notice Owner only. Appoints the grant publisher: an automated key that may propose and cancel roots and do
    ///         nothing else, so the owner key never has to sit on a server. Zero leaves publishing to the owner.
    function setPublisher(address publisher) external;
    function publisher() external view returns (address);
    function config() external view returns (Config memory);
    function graduationManager() external view returns (address);

    // ---- lifecycle ----
    /// @notice GraduationManager only, at the DONE stage of a grant-enabled launch.
    function initCampaign(address meme, PoolKey calldata key, bool memeIsCurrency0, int24 tickLower, int24 tickUpper)
        external;
    /// @notice Publisher or owner, until the root deadline (graduation + rootDeadlineSeconds). Starts the public
    ///         recomputation window (ADR-008), during which the owner can still cancel a root the publisher got
    ///         wrong. Re-proposing replaces the pending root and restarts its delay, but never moves the deadline.
    /// @dev The deadline order: before it, roots are proposed, cancelled and activated freely and the campaign cannot
    ///      be cancelled. After it, no root can be proposed; a root proposed in time stays activatable once its
    ///      delay has passed, and the campaign can be cancelled only while no root is pending. So the last possible
    ///      activation is rootDelaySeconds after the deadline, and at no moment do activation and cancellation race.
    function proposeRoot(address meme, bytes32 root, string calldata uri, uint256 totalBase, uint256 totalInviteeBoost)
        external;
    /// @notice Publisher or owner, while the root is still under review. After the deadline this leaves the campaign
    ///         with no root pending, so anyone can then cancel it.
    function cancelRoot(address meme) external;
    /// @notice Anyone, after the delay, including after the root deadline. Sets t0 = now.
    function activateRoot(address meme) external;
    /// @notice Anyone, after the root deadline, when no root is active or pending. Burns the whole reserve.
    function cancelCampaign(address meme) external;
    /// @notice Anyone, after endTime. Burns everything that never became liquidity: reserve - totalActivated.
    function finalizeGrant(address meme) external returns (uint256 unactivatedMemeBurned);
    /// @notice Anyone, once the launch is REFUNDING (rescued instead of graduated): burns the grant reserve the vault
    ///         holds for it, which no campaign will ever use. The campaign is recorded as CANCELLED.
    function burnRefundedReserve(address meme) external returns (uint256 burned);

    // ---- allocations ----
    /// @notice Anyone, for any account, once the campaign's root is ACTIVE. Registering only under the active root
    ///         means no registration can outlive a root that was cancelled or replaced during its review. The
    ///         registered base and boost never exceed the totals the root declared.
    function registerAllocation(address meme, GrantLeaf calldata leaf, bytes32[] calldata proof) external;

    /// @notice Activates up to the claimable base, invitee boost and inviter credit into one locked full-range position.
    /// @dev All three draw from the campaign's one shared inventory, first come first served; asking for more than it
    ///      holds reverts `InsufficientInventory`. Base is processed first, so the invitee boost its activation earns
    ///      can be activated in the same call. Only base activation earns boosts and inviter credits.
    /// @param quoteMax Upper bound on quote pulled (native: msg.value == quoteMax; unused part is refunded).
    function activateGrant(
        address meme,
        uint256 baseAmount,
        uint256 boostAmount,
        uint256 creditAmount,
        uint256 quoteMax,
        uint128 minLiquidity
    ) external payable returns (uint256 positionId);

    /// @notice Anyone. Pays the position's uncollected trading fees, both currencies, 100% to the beneficiary.
    function collectGrantFees(uint256 positionId) external returns (uint256 quoteFeesPaid, uint256 memeFeesPaid);

    /// @notice Beneficiary only, after the minimum LP time. Closes a grant position and settles principal (PRD 6 v0.14).
    /// @dev Fees are collected first and paid in full to the beneficiary. The principal the position returns,
    ///      `quoteOut` and `memeOut`, is valued at the hook's rate-limited reference price P:
    ///      V = quoteOut + memeOut * P and the beneficiary's entitlement is E = V * (1 - g), g the protocol share
    ///      frozen at activation. E is paid in quote first (up to quoteOut) and any rest in meme at P (up to memeOut).
    ///      The protocol's share is retired: the remaining quote goes to the Community Treasury, the remaining meme is
    ///      burned. No cap either way and no redistribution between positions.
    ///      An exit is never refused on price. Valuing at the reference rather than spot makes moving the pool around
    ///      one's own exit a loss: a pump to r*P0 nets -D(sqrt r - 1)^2 / (2 sqrt r) in value at P0, a dump to s*P0
    ///      nets -G(1 - sqrt s)^2 / (2 sqrt s) in meme, where spot valuation would let a pump extract the grant meme.
    ///      Known residual: the reference follows the pool at up to 8 ticks per second, so a pump held long enough for
    ///      it to follow lets a large position sell its meme share to the protocol at the pumped price. Same-block
    ///      manipulation is unprofitable; the cost of this grows with the time the price must be held off-market.
    ///      Every transfer to the beneficiary (fees and principal) is made last.
    /// @param minQuoteOut Reverts when the quote leg pays less than this.
    /// @param minMemeOut Reverts when the meme leg pays less than this. Zero for a pure-quote exit.
    function exitGrantPosition(uint256 positionId, uint256 minQuoteOut, uint256 minMemeOut)
        external
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned);

    // ---- views ----
    function campaign(address meme) external view returns (Campaign memory);
    function allocation(address meme, address account) external view returns (Allocation memory);
    function position(uint256 positionId) external view returns (GrantPosition memory);
    function positionsOf(address beneficiary) external view returns (uint256[] memory);
    function decayFactorX18(address meme) external view returns (uint256);
    function grantBreakdown(address meme, address account)
        external
        view
        returns (uint256 baseClaimable, uint256 inviteeBoostClaimable, uint256 inviterCreditClaimable);
    function quoteRequired(address meme, uint256 memeAmount)
        external
        view
        returns (uint256 quoteAmount, uint128 liquidity);
    /// @notice Grant meme the campaign can still turn into liquidity: reserve - totalActivated while ACTIVE, else 0.
    function inventoryRemaining(address meme) external view returns (uint256);
    /// @notice Principal settlement `exitGrantPosition` would make now, at the current reference price, excluding the
    ///         fees it also pays. All zeros once the position has exited.
    function exitPreview(uint256 positionId)
        external
        view
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 quoteToTreasury, uint256 memeBurned);
    function leafHash(GrantLeaf calldata leaf) external pure returns (bytes32);
}
