// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @title PerkTemplates
/// @notice Pure constructors for the two V1 launch templates: the parameters a deployment registers in the
///         TemplateRegistry. No deployed contract contains these numbers; each launch reads its template's registered
///         values (and they are part of its configHash). Time windows in particular are deployment inputs: the
///         configure scripts take them from the environment (GRANT_WINDOW_SECONDS and GRANT_MIN_LP_SECONDS for the
///         production templates, TEST_* for the testnet's fast template).
library PerkTemplates {
    /// @dev Supply, curve and pool numbers shared by both V1 templates.
    struct Numbers {
        uint256 totalSupply;
        uint256 curveSupply;
        uint256 poolReserveSupplyPerk;
        uint256 poolReserveSupplyStandard;
        uint256 virtualQuoteReserve;
        uint256 virtualMemeReserve;
        uint256 graduationQuoteThreshold;
        int24 tickSpacing;
        uint256 minEligibleBalance;
        uint64 grantWindowSeconds;
        uint64 minLpSeconds;
        /// @dev Quote binding (see PerkTypes.Template). defaultNumbers() is anyQuote for tests; deploy scripts bind.
        bool anyQuote;
        Currency quote;
    }

    /// @notice Template id for a base id and a quote: the base id itself for native OKB, keccak256(baseId ++ quote) otherwise.
    function templateIdFor(bytes32 baseId, Currency quote) internal pure returns (bytes32) {
        if (Currency.unwrap(quote) == address(0)) return baseId;
        return keccak256(abi.encodePacked(baseId, Currency.unwrap(quote)));
    }

    /// @notice Rescales the quote-denominated curve numbers from 18 to `decimals` decimals (USD parity is the client's call).
    function forQuote(Numbers memory n, Currency quote, uint8 decimals) internal pure returns (Numbers memory m) {
        m = n;
        m.anyQuote = false;
        m.quote = quote;
        if (decimals < 18) {
            uint256 div = 10 ** (18 - decimals);
            m.virtualQuoteReserve = n.virtualQuoteReserve / div;
            m.graduationQuoteThreshold = n.graduationQuoteThreshold / div;
        } else if (decimals > 18) {
            uint256 mul = 10 ** (decimals - 18);
            m.virtualQuoteReserve = n.virtualQuoteReserve * mul;
            m.graduationQuoteThreshold = n.graduationQuoteThreshold * mul;
        }
    }

    uint16 internal constant FEE_DEV_BPS = 5000;
    uint16 internal constant FEE_REWARDS_BPS = 2500;
    uint16 internal constant FEE_LP_BPS = 1500;
    uint16 internal constant FEE_TREASURY_BPS = 500;
    uint16 internal constant FEE_PROTOCOL_BPS = 500;
    uint24 internal constant TOTAL_FEE_BPS = 100;
    uint24 internal constant POOL_LP_FEE_PIPS = 1500;
    uint16 internal constant GRANT_RESERVE_BPS = 1500;
    uint16 internal constant GRANT_BASE_BPS = 8000;
    uint16 internal constant GRANT_REFERRAL_BPS = 2000;

    /// @notice Placeholder numbers pending remaining PRD economic items.
    /// @dev Pump.fun-style virtual reserves scaled by 0.85 so the Perk pool reserve pairs with the
    ///      graduation quote at the curve's final price, while Standard leaves ~15% leftover meme to burn (ADR-006).
    function defaultNumbers() internal pure returns (Numbers memory n) {
        n.totalSupply = 1_000_000_000e18;
        n.curveSupply = 674_200_000e18;
        n.poolReserveSupplyPerk = 175_800_000e18;
        n.poolReserveSupplyStandard = 325_800_000e18;
        n.virtualQuoteReserve = 30e18;
        n.virtualMemeReserve = 912_050_000e18;
        n.graduationQuoteThreshold = 85e18;
        n.tickSpacing = 60;
        n.minEligibleBalance = 1e21;
        // defaults for the production templates; ConfigurePerk.s.sol overrides both from the environment
        n.grantWindowSeconds = 14 days;
        n.minLpSeconds = 24 hours;
        n.anyQuote = true;
    }

    /// @notice Perk Grant V1: grant enabled, bitmap = CORE | LP_GRANT | REFERRAL.
    function perkGrantV1(Numbers memory n) internal pure returns (PerkTypes.Template memory t) {
        t = _base(n, n.poolReserveSupplyPerk, Math.mulDiv(n.totalSupply, GRANT_RESERVE_BPS, PerkConstants.BPS));
        t.moduleBitmap = PerkConstants.CORE_MODULES_V1 | PerkConstants.MODULE_LP_GRANT_V1
            | PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1;
        t.grant = PerkTypes.GrantParams({
            enabled: true,
            reserveBps: GRANT_RESERVE_BPS,
            baseGrantPoolBps: GRANT_BASE_BPS,
            referralBudgetBps: GRANT_REFERRAL_BPS,
            windowSeconds: n.grantWindowSeconds,
            minLpSeconds: n.minLpSeconds,
            referralBoostEnabled: true
        });
    }

    /// @notice Standard Curve V1: grant disabled, bitmap = CORE.
    function standardCurveV1(Numbers memory n) internal pure returns (PerkTypes.Template memory t) {
        t = _base(n, n.poolReserveSupplyStandard, 0);
        t.moduleBitmap = PerkConstants.CORE_MODULES_V1;
    }

    function _base(Numbers memory n, uint256 poolReserveSupply, uint256 grantReserveSupply)
        private
        pure
        returns (PerkTypes.Template memory t)
    {
        t.anyQuote = n.anyQuote;
        t.quote = n.quote;
        t.hookVersion = PerkConstants.HOOK_VERSION_V1;
        t.totalFeeBps = TOTAL_FEE_BPS;
        t.feeSplit = PerkTypes.FeeSplit({
            devBps: FEE_DEV_BPS,
            rewardsBps: FEE_REWARDS_BPS,
            lpBps: FEE_LP_BPS,
            treasuryBps: FEE_TREASURY_BPS,
            protocolBps: FEE_PROTOCOL_BPS
        });
        t.supply = PerkTypes.SupplyPlan({
            totalSupply: n.totalSupply,
            curveSupply: n.curveSupply,
            poolReserveSupply: poolReserveSupply,
            grantReserveSupply: grantReserveSupply
        });
        t.curve = PerkTypes.CurveParams({
            virtualQuoteReserve: n.virtualQuoteReserve,
            virtualMemeReserve: n.virtualMemeReserve,
            graduationQuoteThreshold: n.graduationQuoteThreshold
        });
        t.pool = PerkTypes.PoolParams({
            lpFee: POOL_LP_FEE_PIPS,
            tickSpacing: n.tickSpacing,
            tickLower: TickMath.minUsableTick(n.tickSpacing),
            tickUpper: TickMath.maxUsableTick(n.tickSpacing),
            leftoverPolicy: PerkTypes.LeftoverPolicy.BURN
        });
        t.minEligibleBalance = n.minEligibleBalance;
        t.status = PerkTypes.RegistryStatus.ACTIVE;
    }
}
