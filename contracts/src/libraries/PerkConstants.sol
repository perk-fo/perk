// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title PerkConstants
/// @notice Protocol-wide constants. Economic parameters are NOT here; they live in templates.
library PerkConstants {
    uint256 internal constant BPS = 10_000;

    /// @dev PRD 7.4: accumulator precision no lower than 1e36.
    uint256 internal constant REWARD_PRECISION = 1e36;

    uint32 internal constant HOOK_VERSION_V1 = 1;

    // ---- Module bitmap bits (PRD 5.2) ----
    uint256 internal constant MODULE_OFFICIAL_POOL_GUARD_V1 = 1 << 0;
    uint256 internal constant MODULE_QUOTE_FEE_ROUTER_V1 = 1 << 1;
    uint256 internal constant MODULE_HOLDER_QUOTE_REWARD_V1 = 1 << 2;
    uint256 internal constant MODULE_LP_GRANT_V1 = 1 << 3;
    uint256 internal constant MODULE_REFERRAL_GRANT_BOOST_V1 = 1 << 4;

    uint256 internal constant CORE_MODULES_V1 =
        MODULE_OFFICIAL_POOL_GUARD_V1 | MODULE_QUOTE_FEE_ROUTER_V1 | MODULE_HOLDER_QUOTE_REWARD_V1;

    // ---- Module ids ----
    bytes32 internal constant MODULE_ID_OFFICIAL_POOL_GUARD = keccak256("OFFICIAL_POOL_GUARD_V1");
    bytes32 internal constant MODULE_ID_QUOTE_FEE_ROUTER = keccak256("QUOTE_FEE_ROUTER_V1");
    bytes32 internal constant MODULE_ID_HOLDER_QUOTE_REWARD = keccak256("HOLDER_QUOTE_REWARD_V1");
    bytes32 internal constant MODULE_ID_LP_GRANT = keccak256("LP_GRANT_V1");
    bytes32 internal constant MODULE_ID_REFERRAL_GRANT_BOOST = keccak256("REFERRAL_GRANT_BOOST_V1");

    // ---- Template ids (PRD 5.1) ----
    bytes32 internal constant TEMPLATE_PERK_GRANT_V1 = keccak256("PERK_GRANT_V1");
    bytes32 internal constant TEMPLATE_STANDARD_CURVE_V1 = keccak256("STANDARD_CURVE_V1");

    address internal constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ---- Emergency pause areas (LaunchFactory.pausedFlags) ----
    // Entry points only. Nothing that lets someone take their money out (curve sells, grant exits, fee and reward
    // claims, refunds, pool swaps) can be paused: a pause may stop new money coming in, never lock anyone in.
    uint256 internal constant PAUSE_LAUNCH = 1 << 0; // LaunchFactory.createLaunch
    uint256 internal constant PAUSE_BUY = 1 << 1; // BondingCurve.buy
    // GraduationManager.graduate, and executeRescue with it: a pause holds a pending launch where it is, it can never
    // push one into refunds (see IPerkGraduationManager).
    uint256 internal constant PAUSE_GRADUATION = 1 << 2;
    uint256 internal constant PAUSE_GRANT_JOIN = 1 << 3; // LPGrantVault.activateGrant
    uint256 internal constant PAUSE_ALL = PAUSE_LAUNCH | PAUSE_BUY | PAUSE_GRADUATION | PAUSE_GRANT_JOIN;
}
