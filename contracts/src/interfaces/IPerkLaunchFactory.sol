// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title IPerkLaunchFactory
/// @notice Deploys a meme per launch from an ACTIVE template and commits its configHash (PRD 5.2, 5.3).
/// @dev configHash = keccak256(abi.encode(chainid, factory, creator, predictedMeme, quote, templateId, hookVersion,
///      moduleBitmap, moduleParamsHash)). launchId = keccak256(abi.encode(chainid, factory, meme)).
///      createLaunch order: validate -> register meme in distributor & fee router -> deploy token (CREATE2, mints to
///      factory) -> transfer curve+pool supply to curve, grant reserve to grantReserveHolder -> initCurve -> optional
///      dev buy -> status CURVE_ACTIVE.
interface IPerkLaunchFactory {
    event LaunchCreated(
        bytes32 indexed launchId,
        address indexed meme,
        address indexed creator,
        Currency quote,
        bytes32 templateId,
        bytes32 configHash
    );
    event LaunchTemplateSelected(
        bytes32 indexed launchId,
        bytes32 indexed templateId,
        uint32 hookVersion,
        uint256 moduleBitmap,
        bytes32 moduleParamsHash
    );
    event HookModulesCommitted(
        bytes32 indexed launchId, address indexed hook, uint256 moduleBitmap, bytes32 configHash
    );
    event LaunchStatusUpdated(address indexed meme, PerkTypes.LaunchStatus status, PoolId poolId);
    event DevBuyExecuted(address indexed meme, address indexed creator, uint256 quoteIn, uint256 memeOut);
    /// @notice The emergency pause areas now in force (PerkConstants.PAUSE_*; zero means nothing is paused).
    event PauseUpdated(uint256 flags);

    error ConfigHashMismatch(bytes32 expected, bytes32 actual);
    error TemplateNotActive();
    error QuoteNotAllowed();
    error ModuleIncompatible(string reason);
    error NotStatusUpdater();
    error InvalidStatusTransition();
    error LaunchExists();
    error LaunchNotFound();
    error NativeAmountMismatch();
    error MemeAddressMismatch();
    error ZeroAddress();
    /// @notice The action belongs to an emergency-paused area (PerkConstants.PAUSE_*). Shared by the curve, the
    ///         graduation manager and the grant vault, which all read the factory's flags.
    error Paused(uint256 area);
    error UnknownPauseArea(uint256 flags);

    function previewLaunch(PerkTypes.CreateLaunchParams calldata params)
        external
        view
        returns (address predictedMeme, address hook, uint256 moduleBitmap, bytes32 configHash);

    /// @dev Native quote: msg.value == devBuyQuote. ERC-20 quote: devBuyQuote pulled from msg.sender.
    function createLaunch(PerkTypes.CreateLaunchParams calldata params)
        external
        payable
        returns (address meme, bytes32 launchId);

    function computeConfigHash(
        address creator,
        address predictedMeme,
        Currency quote,
        bytes32 templateId,
        uint32 hookVersion,
        uint256 moduleBitmap,
        bytes32 moduleParamsHash
    ) external view returns (bytes32);

    function predictMemeAddress(
        address creator,
        bytes32 salt,
        PerkTypes.TokenMetadata calldata metadata,
        uint256 totalSupply
    ) external view returns (address);

    /// @notice Curve (-> GRADUATION_PENDING) or GraduationManager (-> GRADUATED, or -> REFUNDING on a rescue) only.
    function setLaunchStatus(address meme, PerkTypes.LaunchStatus status, PoolId poolId) external;

    /// @notice Owner (core admin) only. Sets the paused areas as a whole (PerkConstants.PAUSE_*, zero to resume).
    ///         Only entry points can be paused; exits have no pause check at all.
    function setPaused(uint256 flags) external;
    /// @notice The paused areas, as PerkConstants.PAUSE_* bits.
    function pausedFlags() external view returns (uint256);
    /// @notice True when any bit of `area` is paused.
    function isPaused(uint256 area) external view returns (bool);
    /// @notice When the PAUSE_GRADUATION bit was last cleared by `setPaused` (zero if it never was). A graduation
    ///         rescue only executes once graduation has been open for a whole rescue delay since then, so a pause
    ///         can never stand in for the delay during which anyone may still graduate the launch.
    function graduationResumedAt() external view returns (uint64);

    function getLaunch(address meme) external view returns (PerkTypes.LaunchRecord memory);
    function launchByLaunchId(bytes32 launchId) external view returns (address meme);
    function launchCount() external view returns (uint256);

    function curve() external view returns (address);
    function feeRouter() external view returns (address);
    function distributor() external view returns (address);
    function hook() external view returns (address);
    function graduationManager() external view returns (address);
    function templateRegistry() external view returns (address);
    function moduleRegistry() external view returns (address);
    function assetRegistry() external view returns (address);
    function poolManager() external view returns (address);
    function treasury() external view returns (address);

    /// @notice Where the 15% grant reserve is parked until LPGrantVault ships. Excluded from Quote Rewards.
    function grantReserveHolder() external view returns (address);
}
