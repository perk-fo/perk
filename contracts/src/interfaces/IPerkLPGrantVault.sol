// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IPerkLPGrantVault
/// @notice Holds every Perk Launch's 15% grant reserve, turns Merkle allocations into locked v4 positions, settles
///         fees and exits under the principal cap, and burns whatever never becomes liquidity (PRD 6, ADR-007/008).
/// @dev One contract serves every launch. Grant meme never leaves the vault except into the official pool or the burn.
interface IPerkLPGrantVault {
    enum CampaignStatus {
        NONE,
        AWAITING_ROOT, // graduated, reserve escrowed, no root yet
        ROOT_PROPOSED, // root published, public recomputation window running
        ACTIVE, // decaying allocations can be activated
        EXPIRED, // window over, unactivated meme burned by finalizeGrant
        CANCELLED // no root before the deadline, whole reserve burned
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
        // ADR-008 incentive pool: exit excess quote recycled to remaining grant liquidity by liquidity-seconds
        uint256 incentiveBalance;
        uint256 activeLiquidity;
        uint256 accIncentivePerLiquidity; // scaled 1e36
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
        uint256 incentiveDebt; // liquidity * accIncentivePerLiquidity / 1e36 at last settlement
        uint256 incentiveSettled;
        bool exited;
    }

    /// @dev Vault-level parameters fixed at deployment (ADR-008 §6).
    struct Config {
        uint64 rootDelaySeconds; // public recomputation window between proposeRoot and activateRoot
        uint64 rootDeadlineSeconds; // no active root this long after graduation => anyone may cancel and burn
        uint256 minActivation; // smallest grant meme amount per activation
        uint16 excessToIncentiveBps; // share of exit excess quote recycled to remaining grant liquidity
        uint24 maxPriceDeviationTicks; // positions open and close only this close to the hook's reference price
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
    /// @dev The pool price is further from the hook's reference price than the vault accepts. It clears on its own
    ///      as the reference catches up; see IPerkComposableHook.referencePrice.
    error PriceUnstable(int24 spotTick, int24 referenceTick);

    // ---- wiring ----
    /// @notice One-time wiring of the GraduationManager (owner only).
    function wire(address graduationManager) external;
    function config() external view returns (Config memory);
    function graduationManager() external view returns (address);

    // ---- lifecycle ----
    /// @notice GraduationManager only, at the DONE stage of a grant-enabled launch.
    function initCampaign(address meme, PoolKey calldata key, bool memeIsCurrency0, int24 tickLower, int24 tickUpper)
        external;
    /// @notice Publisher only. Starts the public recomputation window (ADR-008).
    function proposeRoot(address meme, bytes32 root, string calldata uri, uint256 totalBase, uint256 totalInviteeBoost)
        external;
    function cancelRoot(address meme) external;
    /// @notice Anyone, after the delay. Sets t0 = now.
    function activateRoot(address meme) external;
    /// @notice Anyone, when no root became active before the deadline. Burns the whole reserve.
    function cancelCampaign(address meme) external;
    /// @notice Anyone, after endTime. Burns everything that never became liquidity.
    function finalizeGrant(address meme) external returns (uint256 unactivatedMemeBurned);
    /// @notice Anyone, after finalize when no grant liquidity remains: residual incentive quote goes to the treasury.
    function sweepIncentive(address meme) external returns (uint256 toTreasury);

    // ---- allocations ----
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

    /// @notice Pays the position's uncollected trading fees, both sides, to the beneficiary.
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
    function pendingIncentive(uint256 positionId) external view returns (uint256);
    function leafHash(GrantLeaf calldata leaf) external pure returns (bytes32);
}
