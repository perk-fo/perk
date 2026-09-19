// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title IPerkAssetRegistry
/// @notice Whitelist of quote assets (PRD 5.3, 7.4). Native OKB is Currency.wrap(address(0)).
interface IPerkAssetRegistry {
    event AssetUpdated(Currency indexed quote, PerkTypes.AssetInfo info);

    error InvalidAsset(string reason);

    function setAsset(Currency quote, PerkTypes.AssetInfo calldata info) external;
    function assetInfo(Currency quote) external view returns (PerkTypes.AssetInfo memory);

    /// @notice enabled && rewardCompatible. A quote that cannot be distributed must not open launches (PRD 7.4).
    function isQuoteAllowed(Currency quote) external view returns (bool);
}
