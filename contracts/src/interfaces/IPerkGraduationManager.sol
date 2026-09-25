// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IPerkGraduationManager
/// @notice Graduation of a launch whose curve reached its threshold (PRD 5.7). Anyone can call `graduate`.
/// @dev Graduation is atomic: one `graduate` call takes the launch from GRADUATION_PENDING to GRADUATED, or reverts
///      and changes nothing. There is no state in which the official pool exists without its seed liquidity, and no
///      way to stop a graduation part-way (with too little gas, say) and resume it later. The stages record progress
///      within that call and are emitted as it goes:
///      FUNDED            pulled unsold meme + poolReserve + realQuote from the curve and lpReserve from FeeRouter
///      POOL_INITIALIZED  hook.registerPool + PoolManager.initialize at the curve's final price (never recorded on
///                        its own: the same step goes on to LIQUIDITY_ADDED)
///      LIQUIDITY_ADDED   minted the locked initial position(s) to InitialLpLocker, after checking the pool price is
///                        the planned one, with every amount capped at the planned amount + 1 wei
///      DONE              leftover meme burned, factory status GRADUATED, grant campaign initialised, dust swept
///      Seeding math: memeToPool = min(memeReceived, quoteReceived * vMeme / vQuote); quoteToPool = memeToPool * price.
///      Leftover quote (if meme-limited) goes into a quote-only range beside the current price; leftover meme is
///      burned (PoolParams.leftoverPolicy must be BURN, which TemplateRegistry enforces). DONE cannot revert on its
///      own account; should a launch ever be recorded at LIQUIDITY_ADDED, `graduate` completes it.
///
///      Rescue. A launch that reached its threshold but never graduated (stuck at NONE, FUNDED or POOL_INITIALIZED)
///      has its holders' money in the curve or in this contract, with nowhere to sell. The owner can propose a
///      rescue; after `rescueDelay`, during which anyone may still graduate the launch and so void it, anyone can
///      execute it. Execution moves the launch to REFUNDING and every holder can then redeem their tokens for their
///      pro-rata share of the launch's quote. The owner can start the process but cannot receive or redirect any of
///      the money: it only ever goes back to the token's holders.
///
///      The owner's power over pending launches: the owner can propose a rescue for any launch pending graduation
///      (including one whose curve has just completed and could graduate), and can pause graduation
///      (PerkConstants.PAUSE_GRADUATION). A pause holds every pending launch where it is: its curve no longer sells
///      and it has no pool yet, so holders wait for the pause to be lifted. A pause cannot force a launch into
///      refunds: `executeRescue` reverts while graduation is paused and, once the pause is lifted, waits a full
///      `rescueDelay` with graduation open before it can run, so anyone can still graduate the launch first.
interface IPerkGraduationManager {
    enum Stage {
        NONE,
        FUNDED,
        POOL_INITIALIZED,
        LIQUIDITY_ADDED,
        DONE,
        /// @dev Rescued: holders redeem their tokens for their share of `quoteHeld`.
        REFUNDING
    }

    struct Graduation {
        Stage stage;
        PoolKey key;
        PoolId poolId;
        uint160 sqrtPriceX96;
        uint256 memeReceived;
        uint256 quoteReceived;
        uint256 memeToPool;
        uint256 quoteToPool;
        uint256 memeLeftover;
        uint256 quoteLeftover;
        uint256 positionTokenId;
        uint256 quoteOnlyPositionTokenId;
        uint128 liquidity;
        /// @dev This launch's quote still sitting in the manager. The manager keeps one balance per quote currency
        ///      for every launch it holds funds for, so each launch moves only what is recorded here. While
        ///      REFUNDING it is what is left for holders to redeem.
        uint256 quoteHeld;
        /// @dev When a proposed rescue may be executed; zero when none is pending.
        uint64 rescueExecutableAt;
    }

    event GraduationStageAdvanced(address indexed meme, Stage stage);
    event LaunchGraduated(
        address indexed meme,
        bytes32 indexed launchId,
        PoolId indexed poolId,
        uint256 memeToPool,
        uint256 quoteToPool,
        uint128 liquidity
    );
    event LeftoverHandled(address indexed meme, uint256 memeBurned, uint256 quoteInRangeOrder);
    event RescueProposed(address indexed meme, uint64 executableAt);
    /// @notice The pending rescue was withdrawn by the owner, or voided because the launch graduated after all.
    event RescueCancelled(address indexed meme);
    event RescueExecuted(address indexed meme, uint256 quoteForHolders, uint256 memeBurned);
    event Redeemed(address indexed meme, address indexed holder, uint256 memeIn, uint256 quoteOut);

    error NotGraduationPending();
    error AlreadyDone();
    error AlreadyWired();
    error LeftoverPolicyNotImplemented();
    error ZeroAddress();
    error InvalidStage(Stage current);
    error NotRescuable(Stage current);
    error RescueAlreadyProposed();
    error RescueNotProposed();
    error RescueNotReady(uint64 executableAt);
    error RescueDelayTooShort();
    error NotRefunding();
    error NothingToRedeem();
    /// @notice The official pool's price is not the planned seeding price, so no liquidity is added at it.
    error PoolPriceMismatch(uint160 poolSqrtPriceX96, uint160 plannedSqrtPriceX96);

    /// @notice Anyone, while the launch is GRADUATION_PENDING and graduation is not paused: graduates it in full, in
    ///         this call, or reverts with nothing changed.
    function graduate(address meme) external;
    /// @notice One-time hook wiring (owner only).
    function wire(address hook) external;
    /// @notice One-time LP grant vault wiring (owner only).
    function wireVault(address lpGrantVault) external;
    function lpGrantVault() external view returns (address);
    /// @notice Delay between proposing and executing a rescue.
    function rescueDelay() external view returns (uint64);
    /// @notice Owner only. Starts the rescue delay for a launch pending graduation (see the owner's power above).
    function proposeRescue(address meme) external;
    /// @notice Owner only. Withdraws a pending rescue.
    function cancelRescue(address meme) external;
    /// @notice Anyone, once the delay has passed and the launch is still pending: moves it to REFUNDING. Reverts while
    ///         graduation is paused, and until `rescueDelay` after the graduation pause was last lifted.
    function executeRescue(address meme) external;
    /// @notice While REFUNDING: burn `amount` of the caller's tokens for their share of the launch's quote.
    function redeem(address meme, uint256 amount) external returns (uint256 quoteOut);
    /// @notice What `redeem(meme, amount)` would pay now (zero unless REFUNDING).
    function previewRedeem(address meme, uint256 amount) external view returns (uint256 quoteOut);
    function graduationOf(address meme) external view returns (Graduation memory);
    function initialLpLocker() external view returns (address);
    function factory() external view returns (address);
    function curve() external view returns (address);
    function hook() external view returns (address);
    function feeRouter() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
}
