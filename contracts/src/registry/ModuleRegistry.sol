// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkModuleRegistry} from "../interfaces/IPerkModuleRegistry.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title ModuleRegistry
/// @notice On-chain module manifest. Quote compatibility defaults to false and must be whitelisted per quote.
contract ModuleRegistry is IPerkModuleRegistry, Ownable2Step {
    mapping(bytes32 moduleId => mapping(uint32 version => PerkTypes.ModuleInfo)) private _modules;
    mapping(bytes32 moduleId => mapping(uint32 version => bool)) private _registered;
    mapping(uint256 bit => bytes32 moduleId) private _moduleIdByBit;
    mapping(uint256 bit => uint32 version) private _versionByBit;
    mapping(uint256 bit => bool) private _bitOccupied;
    mapping(bytes32 moduleId => mapping(uint32 version => mapping(Currency quote => bool))) private _quoteCompatible;

    /// @param owner_ Two-step Ownable owner.
    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IPerkModuleRegistry
    function registerModule(PerkTypes.ModuleInfo calldata info) external onlyOwner {
        if (_registered[info.moduleId][info.version]) revert ModuleExists();
        if (info.bit == 0 || info.bit & (info.bit - 1) != 0) revert InvalidBit();
        if (_bitOccupied[info.bit]) revert BitTaken(info.bit);

        _modules[info.moduleId][info.version] = info;
        _registered[info.moduleId][info.version] = true;
        _moduleIdByBit[info.bit] = info.moduleId;
        _versionByBit[info.bit] = info.version;
        _bitOccupied[info.bit] = true;
        emit ModuleRegistered(info.moduleId, info.version, info.bit, info);
    }

    /// @inheritdoc IPerkModuleRegistry
    function setModuleStatus(bytes32 moduleId, uint32 version, PerkTypes.RegistryStatus status) external onlyOwner {
        PerkTypes.ModuleInfo storage info = _get(moduleId, version);
        info.status = status;
        emit ModuleStatusUpdated(moduleId, version, status);
    }

    /// @inheritdoc IPerkModuleRegistry
    function setQuoteCompatibility(bytes32 moduleId, uint32 version, Currency quote, bool ok) external onlyOwner {
        _get(moduleId, version);
        _quoteCompatible[moduleId][version][quote] = ok;
        emit ModuleQuoteCompatibilityUpdated(moduleId, version, quote, ok);
    }

    /// @inheritdoc IPerkModuleRegistry
    function isModuleActive(bytes32 moduleId, uint32 version) external view returns (bool) {
        return _registered[moduleId][version] && _modules[moduleId][version].status == PerkTypes.RegistryStatus.ACTIVE;
    }

    /// @inheritdoc IPerkModuleRegistry
    function moduleByBit(uint256 bit) external view returns (PerkTypes.ModuleInfo memory) {
        if (!_bitOccupied[bit]) revert ModuleNotFound();
        return _modules[_moduleIdByBit[bit]][_versionByBit[bit]];
    }

    /// @inheritdoc IPerkModuleRegistry
    function isQuoteCompatible(bytes32 moduleId, uint32 version, Currency quote) external view returns (bool) {
        return _quoteCompatible[moduleId][version][quote];
    }

    /// @inheritdoc IPerkModuleRegistry
    function validateCompatibility(uint256 moduleBitmap, Currency quote)
        external
        view
        returns (bool ok, string memory reason)
    {
        uint256 remaining = moduleBitmap;
        for (uint256 i = 0; i < 256 && remaining != 0; ++i) {
            uint256 bit = uint256(1) << i;
            if (remaining & bit == 0) continue;
            remaining ^= bit;

            if (!_bitOccupied[bit]) {
                reason = "unknown module";
                return (ok, reason);
            }
            PerkTypes.ModuleInfo storage info = _modules[_moduleIdByBit[bit]][_versionByBit[bit]];
            if (info.status != PerkTypes.RegistryStatus.ACTIVE) {
                reason = "module not active";
                return (ok, reason);
            }
            if (!_quoteCompatible[info.moduleId][info.version][quote]) {
                reason = "quote incompatible";
                return (ok, reason);
            }
            if (info.incompatibleModules & moduleBitmap != 0) {
                reason = "module conflict";
                return (ok, reason);
            }
        }
        ok = true;
        return (ok, reason);
    }

    function _get(bytes32 moduleId, uint32 version) private view returns (PerkTypes.ModuleInfo storage info) {
        if (!_registered[moduleId][version]) revert ModuleNotFound();
        info = _modules[moduleId][version];
    }
}
