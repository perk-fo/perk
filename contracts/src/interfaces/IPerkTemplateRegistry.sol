// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title IPerkTemplateRegistry
/// @notice Versioned launch templates (PRD 5.1, 8.4). A template is immutable once registered; only status changes.
/// @dev `registerTemplate` must reject anything that violates PRD 9.2 or makes the curve/graduation math impossible:
///      - feeSplit sums to 10_000; 0 < totalFeeBps <= 100; pool.lpFee == totalFeeBps * 100 * lpBps / 10_000 (pips)
///      - supply.curve + supply.poolReserve + supply.grantReserve == supply.total
///      - supply.grantReserve == total * grant.reserveBps / 10_000
///      - grant.enabled  => reserveBps 1500, baseGrantPoolBps 8000, referralBudgetBps 2000, referralBoostEnabled
///        !grant.enabled => all zero / false
///      - moduleBitmap contains CORE_MODULES_V1; has LP_GRANT bit iff grant.enabled; REFERRAL bit iff referralBoostEnabled
///      - curve.virtualQuote > 0, curve.virtualMeme > 0, threshold > 0
///      - memeSoldAtGraduation(template) <= supply.curveSupply
///      - pool.tickLower < pool.tickUpper, both multiples of tickSpacing, tickSpacing > 0
///      - minEligibleBalance > 0
interface IPerkTemplateRegistry {
    event TemplateRegistered(bytes32 indexed templateId, PerkTypes.Template template);
    event TemplateStatusUpdated(bytes32 indexed templateId, PerkTypes.RegistryStatus status);

    error TemplateExists();
    error TemplateNotFound();
    error InvalidTemplate(string reason);
    error ModuleParamsNotSupported();
    error QuoteNotBoundToTemplate();

    function registerTemplate(bytes32 templateId, PerkTypes.Template calldata template) external;
    function setTemplateStatus(bytes32 templateId, PerkTypes.RegistryStatus status) external;

    function getTemplate(bytes32 templateId) external view returns (PerkTypes.Template memory);
    function isActive(bytes32 templateId) external view returns (bool);

    /// @notice Resolves a creator's choice into the committed module set (PRD 5.2). V1: moduleParams must be empty.
    ///         Reverts QuoteNotBoundToTemplate unless the template is `anyQuote` or bound to `quote` (curve numbers are quote units).
    /// @return moduleBitmap The template's fixed bitmap.
    /// @return moduleParamsHash keccak256(moduleParams).
    function validateConfiguration(bytes32 templateId, Currency quote, bytes calldata moduleParams)
        external
        view
        returns (uint256 moduleBitmap, bytes32 moduleParamsHash);

    /// @notice Meme sold on the curve when realQuote hits the threshold: vMeme * T / (vQuote + T).
    function memeSoldAtGraduation(PerkTypes.Template calldata template) external pure returns (uint256);

    /// @notice Curve final price at graduation, quote per 1e18 meme, scaled by 1e18.
    function finalPriceX18(PerkTypes.Template calldata template) external pure returns (uint256);
}
