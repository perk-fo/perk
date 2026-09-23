// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title PerkTypes
/// @notice Shared enums and structs for every Perk contract.
/// @dev Every number the PRD leaves for the client to decide lives in `Template`, never as a literal in code.
library PerkTypes {
    enum LaunchStatus {
        NONE,
        CURVE_ACTIVE,
        GRADUATION_PENDING,
        GRADUATED,
        /// @dev Graduation never completed and the launch was rescued: holders redeem their tokens for their share
        ///      of the launch's quote (GraduationManager.redeem).
        REFUNDING
    }

    enum FeeSource {
        CURVE,
        HOOK
    }

    /// @dev What GraduationManager does with meme left over after seeding the pool at the curve's final price.
    enum LeftoverPolicy {
        BURN,
        RANGE_ORDER // reserved, not implemented in V1
    }

    enum RegistryStatus {
        PROPOSED,
        CANARY,
        ACTIVE,
        DEPRECATED
    }

    enum ModuleType {
        LAUNCH,
        LIQUIDITY,
        HOOK,
        GROWTH
    }

    /// @dev Shares of the TOTAL user-side fee, in bps of that fee (10_000 = the whole 1.00%). Must sum to 10_000.
    struct FeeSplit {
        uint16 devBps;
        uint16 rewardsBps;
        uint16 lpBps;
        uint16 treasuryBps;
        uint16 protocolBps;
    }

    /// @dev Absolute meme amounts. curve + poolReserve + grantReserve == totalSupply.
    struct SupplyPlan {
        uint256 totalSupply;
        uint256 curveSupply;
        uint256 poolReserveSupply;
        uint256 grantReserveSupply;
    }

    struct CurveParams {
        uint256 virtualQuoteReserve;
        uint256 virtualMemeReserve;
        /// @dev NET quote (fees excluded) accumulated on the curve that triggers graduation.
        uint256 graduationQuoteThreshold;
    }

    struct PoolParams {
        /// @dev v4 static LP fee in pips (1e6 = 100%). 1500 = 0.15%.
        uint24 lpFee;
        int24 tickSpacing;
        /// @dev Initial locked LP range. Full range = usable min/max tick for the spacing.
        int24 tickLower;
        int24 tickUpper;
        LeftoverPolicy leftoverPolicy;
    }

    struct GrantParams {
        bool enabled;
        /// @dev Of total supply. PRD 9.2: 1500 when enabled, 0 otherwise.
        uint16 reserveBps;
        /// @dev Of grant reserve. PRD 9.2: 8000 / 2000 when enabled, 0 / 0 otherwise.
        uint16 baseGrantPoolBps;
        uint16 referralBudgetBps;
        uint64 windowSeconds;
        uint64 minLpSeconds;
        /// @dev PRD 9.2: must equal `enabled`.
        bool referralBoostEnabled;
    }

    struct Template {
        uint32 hookVersion;
        uint256 moduleBitmap;
        /// @dev Total user-side fee in bps of volume. 100 = 1.00%.
        uint24 totalFeeBps;
        FeeSplit feeSplit;
        SupplyPlan supply;
        CurveParams curve;
        PoolParams pool;
        GrantParams grant;
        /// @dev Quote Rewards eligibility floor, absolute meme units. Must be > 0.
        uint256 minEligibleBalance;
        RegistryStatus status;
        /// @dev Curve numbers are absolute quote units, so a template is bound to one quote asset unless `anyQuote`
        ///      (tests / canaries). Native OKB is Currency.wrap(address(0)).
        bool anyQuote;
        Currency quote;
    }

    struct TokenMetadata {
        string name;
        string symbol;
        /// @dev Off-chain JSON with image, description and socials.
        string uri;
    }

    struct CreateLaunchParams {
        bytes32 templateId;
        Currency quote;
        /// @dev Empty in V1. Hashed into configHash for forward compatibility.
        bytes moduleParams;
        /// @dev Frontend preview value. createLaunch reverts if it differs from the on-chain computation.
        bytes32 expectedConfigHash;
        TokenMetadata metadata;
        /// @dev Optional atomic dev buy, gross quote including fee. 0 to skip.
        uint256 devBuyQuote;
        /// @dev Creator-chosen. Predicted meme address = f(creator, salt, metadata, totalSupply).
        bytes32 salt;
    }

    struct LaunchRecord {
        bytes32 launchId;
        address creator;
        address meme;
        Currency quote;
        bytes32 templateId;
        uint32 hookVersion;
        uint256 moduleBitmap;
        bytes32 moduleParamsHash;
        bytes32 configHash;
        address hook;
        bool lpGrantEnabled;
        LaunchStatus status;
        uint64 createdAt;
        /// @dev Zero until GRADUATED.
        PoolId poolId;
    }

    struct ModuleInfo {
        bytes32 moduleId;
        uint32 version;
        ModuleType moduleType;
        /// @dev Which bit of `Template.moduleBitmap` this module occupies (exactly one bit set).
        uint256 bit;
        /// @dev v4 Hooks flags this module needs, 0 for non-hook modules.
        uint160 hookPermissionBitmap;
        bytes32 runtimeCodeHash;
        string sourceCommit;
        /// @dev Bitmap of modules that cannot be enabled together with this one.
        uint256 incompatibleModules;
        RegistryStatus status;
    }

    struct AssetInfo {
        bool enabled;
        /// @dev PRD 7.4: quote must be safely distributable to arbitrary holders before launches open.
        bool rewardCompatible;
        bool isNative;
        uint8 decimals;
        string symbol;
    }
}
