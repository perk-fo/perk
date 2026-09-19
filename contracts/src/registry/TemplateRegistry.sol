// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkTemplateRegistry} from "../interfaces/IPerkTemplateRegistry.sol";
import {PerkConstants} from "../libraries/PerkConstants.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title TemplateRegistry
/// @notice Versioned launch templates. A template is immutable once registered; only status changes.
contract TemplateRegistry is IPerkTemplateRegistry, Ownable2Step {
    uint256 private constant V1_MODULE_BITS =
        PerkConstants.CORE_MODULES_V1 | PerkConstants.MODULE_LP_GRANT_V1 | PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1;
    uint16 private constant GRANT_RESERVE_BPS = 1500;
    uint16 private constant GRANT_BASE_BPS = 8000;
    uint16 private constant GRANT_REFERRAL_BPS = 2000;

    mapping(bytes32 templateId => PerkTypes.Template) private _templates;
    mapping(bytes32 templateId => bool) private _registered;

    /// @param owner_ Two-step Ownable owner.
    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IPerkTemplateRegistry
    function registerTemplate(bytes32 templateId, PerkTypes.Template calldata template) external onlyOwner {
        if (_registered[templateId]) revert TemplateExists();
        _validate(template);
        _templates[templateId] = template;
        _registered[templateId] = true;
        // No external call precedes this emit; forge-lint flags the preceding Math.mulDiv in _validate.
        // forge-lint: disable-next-line(reentrancy-events)
        emit TemplateRegistered(templateId, template);
    }

    /// @inheritdoc IPerkTemplateRegistry
    function setTemplateStatus(bytes32 templateId, PerkTypes.RegistryStatus status) external onlyOwner {
        if (!_registered[templateId]) revert TemplateNotFound();
        _templates[templateId].status = status;
        emit TemplateStatusUpdated(templateId, status);
    }

    /// @inheritdoc IPerkTemplateRegistry
    function getTemplate(bytes32 templateId) external view returns (PerkTypes.Template memory) {
        if (!_registered[templateId]) revert TemplateNotFound();
        return _templates[templateId];
    }

    /// @inheritdoc IPerkTemplateRegistry
    function isActive(bytes32 templateId) external view returns (bool) {
        return _registered[templateId] && _templates[templateId].status == PerkTypes.RegistryStatus.ACTIVE;
    }

    /// @inheritdoc IPerkTemplateRegistry
    function validateConfiguration(bytes32 templateId, Currency quote, bytes calldata moduleParams)
        external
        view
        returns (uint256 moduleBitmap, bytes32 moduleParamsHash)
    {
        if (!_registered[templateId]) revert TemplateNotFound();
        if (moduleParams.length != 0) revert ModuleParamsNotSupported();
        PerkTypes.Template storage t = _templates[templateId];
        if (!t.anyQuote && Currency.unwrap(t.quote) != Currency.unwrap(quote)) revert QuoteNotBoundToTemplate();
        return (t.moduleBitmap, keccak256(moduleParams));
    }

    /// @inheritdoc IPerkTemplateRegistry
    function memeSoldAtGraduation(PerkTypes.Template calldata template) external pure returns (uint256) {
        return _memeSoldAtGraduation(template);
    }

    /// @inheritdoc IPerkTemplateRegistry
    function finalPriceX18(PerkTypes.Template calldata template) external pure returns (uint256) {
        uint256 sold = _memeSoldAtGraduation(template);
        return Math.mulDiv(
            template.curve.virtualQuoteReserve + template.curve.graduationQuoteThreshold,
            1e18,
            template.curve.virtualMemeReserve - sold
        );
    }

    function _validate(PerkTypes.Template calldata t) private pure {
        PerkTypes.FeeSplit calldata split = t.feeSplit;
        if (
            uint256(split.devBps) + split.rewardsBps + split.lpBps + split.treasuryBps + split.protocolBps
                != PerkConstants.BPS
        ) {
            revert InvalidTemplate("fee split");
        }
        if (t.totalFeeBps == 0 || t.totalFeeBps > 100) revert InvalidTemplate("total fee");
        if (t.pool.lpFee != uint256(t.totalFeeBps) * 100 * split.lpBps / PerkConstants.BPS) {
            revert InvalidTemplate("lp fee pips");
        }

        PerkTypes.SupplyPlan calldata supply = t.supply;
        if (supply.curveSupply + supply.poolReserveSupply + supply.grantReserveSupply != supply.totalSupply) {
            revert InvalidTemplate("supply sum");
        }
        if (supply.grantReserveSupply != Math.mulDiv(supply.totalSupply, t.grant.reserveBps, PerkConstants.BPS)) {
            revert InvalidTemplate("grant reserve");
        }

        if (t.grant.enabled) {
            if (
                t.grant.reserveBps != GRANT_RESERVE_BPS || t.grant.baseGrantPoolBps != GRANT_BASE_BPS
                    || t.grant.referralBudgetBps != GRANT_REFERRAL_BPS || !t.grant.referralBoostEnabled
            ) {
                revert InvalidTemplate("grant params");
            }
        } else if (
            t.grant.reserveBps != 0 || t.grant.baseGrantPoolBps != 0 || t.grant.referralBudgetBps != 0
                || t.grant.referralBoostEnabled
        ) {
            revert InvalidTemplate("grant params");
        }

        if (t.moduleBitmap & PerkConstants.CORE_MODULES_V1 != PerkConstants.CORE_MODULES_V1) {
            revert InvalidTemplate("core modules");
        }
        if ((t.moduleBitmap & PerkConstants.MODULE_LP_GRANT_V1 != 0) != t.grant.enabled) {
            revert InvalidTemplate("grant module bit");
        }
        if ((t.moduleBitmap & PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1 != 0) != t.grant.referralBoostEnabled) {
            revert InvalidTemplate("referral module bit");
        }
        if (t.moduleBitmap & ~V1_MODULE_BITS != 0) revert InvalidTemplate("unknown module bit");

        if (
            t.curve.virtualQuoteReserve == 0 || t.curve.virtualMemeReserve == 0 || t.curve.graduationQuoteThreshold == 0
        ) {
            revert InvalidTemplate("curve params");
        }
        if (_memeSoldAtGraduation(t) > supply.curveSupply) revert InvalidTemplate("curve overflow");

        int24 spacing = t.pool.tickSpacing;
        if (
            spacing <= 0 || t.pool.tickLower >= t.pool.tickUpper || t.pool.tickLower % spacing != 0
                || t.pool.tickUpper % spacing != 0
        ) {
            revert InvalidTemplate("ticks");
        }
        if (t.minEligibleBalance == 0) revert InvalidTemplate("min eligible");
        if (t.hookVersion == 0) revert InvalidTemplate("hook version");
    }

    function _memeSoldAtGraduation(PerkTypes.Template calldata template) private pure returns (uint256) {
        return Math.mulDiv(
            template.curve.virtualMemeReserve,
            template.curve.graduationQuoteThreshold,
            template.curve.virtualQuoteReserve + template.curve.graduationQuoteThreshold
        );
    }
}
