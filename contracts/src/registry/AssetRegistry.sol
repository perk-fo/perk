// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkAssetRegistry} from "../interfaces/IPerkAssetRegistry.sol";
import {PerkTypes} from "../libraries/PerkTypes.sol";

/// @title AssetRegistry
/// @notice Whitelist of quote assets. Native OKB is Currency.wrap(address(0)).
contract AssetRegistry is IPerkAssetRegistry, Ownable2Step {
    mapping(Currency quote => PerkTypes.AssetInfo) private _assets;

    /// @param owner_ Two-step Ownable owner.
    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IPerkAssetRegistry
    function setAsset(Currency quote, PerkTypes.AssetInfo calldata info) external onlyOwner {
        if (info.isNative != quote.isAddressZero()) revert InvalidAsset("native flag");
        if (!info.isNative && info.decimals == 0) revert InvalidAsset("decimals");
        _assets[quote] = info;
        emit AssetUpdated(quote, info);
    }

    /// @inheritdoc IPerkAssetRegistry
    function assetInfo(Currency quote) external view returns (PerkTypes.AssetInfo memory) {
        return _assets[quote];
    }

    /// @inheritdoc IPerkAssetRegistry
    function isQuoteAllowed(Currency quote) external view returns (bool) {
        PerkTypes.AssetInfo storage info = _assets[quote];
        return info.enabled && info.rewardCompatible;
    }
}
