// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title IPerkModuleRegistry
/// @notice On-chain module manifest (PRD 8.4). V1 has five modules in two fixed combinations; the compatibility
///         engine is intentionally trivial and only checks status, quote compatibility and pairwise conflicts.
interface IPerkModuleRegistry {
    event ModuleRegistered(bytes32 indexed moduleId, uint32 indexed version, uint256 bit, PerkTypes.ModuleInfo info);
    event ModuleStatusUpdated(bytes32 indexed moduleId, uint32 indexed version, PerkTypes.RegistryStatus status);
    event ModuleQuoteCompatibilityUpdated(
        bytes32 indexed moduleId, uint32 indexed version, Currency indexed quote, bool ok
    );

    error ModuleExists();
    error ModuleNotFound();
    error BitTaken(uint256 bit);
    error InvalidBit();

    function registerModule(PerkTypes.ModuleInfo calldata info) external;
    function setModuleStatus(bytes32 moduleId, uint32 version, PerkTypes.RegistryStatus status) external;
    function setQuoteCompatibility(bytes32 moduleId, uint32 version, Currency quote, bool ok) external;

    function isModuleActive(bytes32 moduleId, uint32 version) external view returns (bool);
    function moduleByBit(uint256 bit) external view returns (PerkTypes.ModuleInfo memory);
    function isQuoteCompatible(bytes32 moduleId, uint32 version, Currency quote) external view returns (bool);

    /// @notice Every set bit must map to an ACTIVE module compatible with `quote`; no pair may be mutually incompatible.
    function validateCompatibility(uint256 moduleBitmap, Currency quote)
        external
        view
        returns (bool ok, string memory reason);
}
