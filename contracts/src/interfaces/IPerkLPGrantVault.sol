// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IPerkLPGrantVault
/// @notice Holds every Perk Launch's 15% grant reserve, turns Merkle allocations into locked v4 positions, settles
///         fees and exits under the principal cap, and burns whatever never becomes liquidity (PRD 6, ADR-007/008).
/// @dev One contract serves every launch. Grant meme leaves the vault only into the official pool (activation), into
///      the burn, or to a beneficiary at exit as shortfall compensation out of the meme their own position returned.
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
        uint256 referralBudgetUsed; // invitee boosts committed at root + inviter credits earned
        uint256 totalActivated; // meme that became liquidity
        uint256 burned;
        bytes32 root;
        string rootUri; // public dataset (PRD 6.2)
        uint64 rootProposedAt;
        uint256 rootTotalBase;
        uint256 rootTotalInviteeBoost;
        // ADR-008 incentive pool: exit excess quote recycled to the grant liquidity still active, shared by the
        // liquidity-seconds each position has accrued since its activation (see exitGrantPosition).
        uint256 incentiveBalance;
        uint256 activeLiquidity;
        // sum over exits of (quote recycled) * 1e36 / (liquidity-seconds of the active positions at that exit)
        uint256 accIncentivePerLiquiditySecond;
        // the same sum with each term also multiplied by the exit's time since startTime
        uint256 accIncentiveTimePerLiquiditySecond;
        // sum over active positions of liquidity * (activatedAt - startTime); with activeLiquidity it gives their
        // liquidity-seconds at time t as activeLiquidity * (t - startTime) - activeLiquidityTime
        uint256 activeLiquidityTime;
        uint256 registeredBase; // base allocations registered under the active root, at most rootTotalBase
        uint256 registeredInviteeBoost; // invitee boosts registered under the active root, at most rootTotalInviteeBoost
    }

    struct Allocation {
        bool registered;
        uint256 baseAllocation;
        uint256 inviteeBoost;
        uint256 baseNominalRemaining;
        uint256 boostNominalRemaining;
        uint256 inviterCreditEarned;
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
        uint160 entrySqrtPriceX96; // pool price when the position was opened; prices the exit top-up with the exit price
        uint256 incentiveCheckpoint; // campaign accIncentivePerLiquiditySecond when incentives were last settled
        uint256 incentiveTimeCheckpoint; // campaign accIncentiveTimePerLiquiditySecond at the same moment
        bool exited;
    }

    /// @dev Vault-level parameters fixed at deployment (ADR-008 §6).
    struct Config {
        uint64 rootDelaySeconds; // public recomputation window between proposeRoot and activateRoot
        // roots may be proposed until this long after graduation; after it, a campaign with no root pending can be
        // cancelled by anyone (reserve burned), and a root proposed in time can still be activated after its delay
        uint64 rootDeadlineSeconds;
        uint256 minActivation; // smallest grant meme amount per activation
        uint16 excessToIncentiveBps; // share of exit excess quote recycled to remaining grant liquidity
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
    event ReferralCreditCapped(address indexed meme, address indexed inviter, uint256 requested, uint256 granted);
    event GrantActivated(
        uint256 indexed positionId,
        address indexed meme,
        address indexed beneficiary,
        uint256 baseActivated,
        uint256 inviteeBoostActivated,
        uint256 inviterCreditActivated,
        uint256 quoteDeposited,
        uint128 liquidity
    );
    event GrantFeesCollected(
        uint256 indexed positionId, uint256 quoteFeesPaid, uint256 memeFeesPaid, uint256 incentivePaid
    );
    event GrantPositionExited(
        uint256 indexed positionId,
        uint256 quoteToUser,
        uint256 memeToUser,
        uint256 excessQuote,
        uint256 memeBurned,
        uint256 incentivePaid
    );
    event ExcessQuoteRouted(address indexed meme, uint256 toIncentivePool, uint256 toTreasury);
    event GrantMemeBurned(address indexed meme, uint256 amount, bytes32 reason);
    event GrantFinalized(address indexed meme, uint256 unactivatedMemeBurned);
    event IncentiveSwept(address indexed meme, uint256 toTreasury);
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
    error NothingToSweep();
    error AlreadyWired();
    error NotPositionManager();
    /// @dev The pool price is further from the hook's reference price than the vault accepts for an activation. It
    ///      clears on its own as the reference catches up; see IPerkComposableHook.referencePrice. Exits never check it.
    error PriceUnstable(int24 spotTick, int24 referenceTick);
    /// @dev Roots can no longer be proposed for this campaign: its root deadline has passed.
    error RootDeadlinePassed(uint64 deadline);
    /// @dev The launch is not REFUNDING, so its grant reserve is not burned through `burnRefundedReserve`.
    error LaunchNotRefunding();

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
    /// @notice Anyone, after endTime. Burns everything that never became liquidity.
    function finalizeGrant(address meme) external returns (uint256 unactivatedMemeBurned);
    /// @notice Anyone, after finalize when no grant liquidity remains: residual incentive quote goes to the treasury.
    function sweepIncentive(address meme) external returns (uint256 toTreasury);
    /// @notice Anyone, once the launch is REFUNDING (rescued instead of graduated): burns the grant reserve the vault
    ///         holds for it, which no campaign will ever use. The campaign is recorded as CANCELLED.
    function burnRefundedReserve(address meme) external returns (uint256 burned);

    // ---- allocations ----
    /// @notice Anyone, for any account, once the campaign's root is ACTIVE. Registering only under the active root
    ///         means no registration can outlive a root that was cancelled or replaced during its review. The
    ///         registered base and boost never exceed the totals the root declared.
    function registerAllocation(address meme, GrantLeaf calldata leaf, bytes32[] calldata proof) external;

    /// @notice Activates up to the claimable base, invitee boost and inviter credit into one locked full-range position.
    /// @param quoteMax Upper bound on quote pulled (native: msg.value == quoteMax; unused part is refunded).
    function activateGrant(
        address meme,
        uint256 baseAmount,
        uint256 boostAmount,
        uint256 creditAmount,
        uint256 quoteMax,
        uint128 minLiquidity
    ) external payable returns (uint256 positionId);

    /// @notice Pays the position's uncollected trading fees, both sides, and its incentive share to the beneficiary.
    /// @dev Incentives accrue by liquidity-seconds: each exit's recycled excess is shared among the positions still
    ///      active in proportion to liquidity * (exit time - activation time). A position opened just before an exit
    ///      has accrued next to nothing, so activating in front of a large exit collects nothing from it.
    function collectGrantFees(uint256 positionId)
        external
        returns (uint256 quoteFeesPaid, uint256 memeFeesPaid, uint256 incentivePaid);

    /// @notice Closes a grant position and settles principal (ADR-008 §5).
    /// @dev The beneficiary is owed their quote deposit `D`. It is paid in quote first; when the position no longer
    ///      holds that much quote, grant meme covers the shortfall, converted at the geometric mean of the price the
    ///      position was opened at and the exit price. That is the one conversion at which moving the pool price
    ///      around an exit is worth nothing to the LP doing it: the exit price is theirs to move, and at spot a
    ///      crash-exit-rebuy round trip drained the grant meme. With q = sqrt(P_exit / P_entry) <= 1 the beneficiary
    ///      receives D*q in quote plus meme worth D*q*(1-q), so D*(1 - (1-q)^2) in all: 99% of the deposit after a
    ///      20% price fall, 91% after 50%, 75% after 75%, against D*q for the same capital held without a grant.
    ///      Quote above `D` goes to the treasury/incentive pool and every meme not paid out is burned. Fees are
    ///      settled separately and in full to the beneficiary.
    ///      An exit is never refused on price. The settlement above is indifferent to the exit price, and the one
    ///      part a moved price could steer, the excess recycled to the incentive pool, is capped at the excess the
    ///      position would hold at the hook's reference price whenever the pool has moved off that reference; the
    ///      rest of the excess goes to the treasury. Pumping the price around an exit so that a second position
    ///      collects the "excess" therefore pays nothing.
    /// @param minQuoteOut Reverts when the quote leg pays less than this.
    /// @param minMemeOut Reverts when the meme leg pays less than this. Zero for a pure-quote exit.
    function exitGrantPosition(uint256 positionId, uint256 minQuoteOut, uint256 minMemeOut)
        external
        returns (uint256 quoteToUser, uint256 memeToUser, uint256 excessQuote, uint256 memeBurned);

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
    /// @notice Incentive quote the position would be paid now (zero once it has exited).
    function pendingIncentive(uint256 positionId) external view returns (uint256);
    function leafHash(GrantLeaf calldata leaf) external pure returns (bytes32);
}
