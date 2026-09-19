// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPerkAssetRegistry} from "../../src/interfaces/IPerkAssetRegistry.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {AssetRegistry} from "../../src/registry/AssetRegistry.sol";

contract AssetRegistryTest is Test {
    AssetRegistry internal registry;
    address internal stranger;
    Currency internal native;
    Currency internal erc20;

    event AssetUpdated(Currency indexed quote, PerkTypes.AssetInfo info);

    function setUp() public {
        stranger = makeAddr("stranger");
        native = Currency.wrap(address(0));
        erc20 = Currency.wrap(makeAddr("usdc"));
        registry = new AssetRegistry(address(this));
    }

    function test_setAsset_native_requiresIsNative() public {
        PerkTypes.AssetInfo memory info = _native(true, true);
        info.isNative = false;
        vm.expectRevert(abi.encodeWithSelector(IPerkAssetRegistry.InvalidAsset.selector, "native flag"));
        registry.setAsset(native, info);
    }

    function test_setAsset_erc20_requiresDecimals() public {
        PerkTypes.AssetInfo memory info = _erc20(true, true, 0);
        vm.expectRevert(abi.encodeWithSelector(IPerkAssetRegistry.InvalidAsset.selector, "decimals"));
        registry.setAsset(erc20, info);
    }

    function test_setAsset_erc20_requiresNotNative() public {
        PerkTypes.AssetInfo memory info = _erc20(true, true, 6);
        info.isNative = true;
        vm.expectRevert(abi.encodeWithSelector(IPerkAssetRegistry.InvalidAsset.selector, "native flag"));
        registry.setAsset(erc20, info);
    }

    function test_isQuoteAllowed_requiresBothFlags() public {
        registry.setAsset(native, _native(true, false));
        assertFalse(registry.isQuoteAllowed(native));

        registry.setAsset(native, _native(false, true));
        assertFalse(registry.isQuoteAllowed(native));

        PerkTypes.AssetInfo memory allowed = _native(true, true);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AssetUpdated(native, allowed);
        registry.setAsset(native, allowed);
        assertTrue(registry.isQuoteAllowed(native));
    }

    function test_setAsset_overwrite() public {
        registry.setAsset(erc20, _erc20(true, true, 6));
        PerkTypes.AssetInfo memory first = registry.assetInfo(erc20);
        assertEq(first.decimals, 6);
        assertEq(first.symbol, "USDC");
        assertTrue(registry.isQuoteAllowed(erc20));

        PerkTypes.AssetInfo memory next = _erc20(false, true, 18);
        next.symbol = "USDT";
        registry.setAsset(erc20, next);
        PerkTypes.AssetInfo memory got = registry.assetInfo(erc20);
        assertEq(got.decimals, 18);
        assertEq(got.symbol, "USDT");
        assertFalse(got.enabled);
        assertFalse(registry.isQuoteAllowed(erc20));
    }

    function test_setAsset_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setAsset(native, _native(true, true));
    }

    function _native(bool enabled, bool rewardCompatible) internal pure returns (PerkTypes.AssetInfo memory) {
        return PerkTypes.AssetInfo({
            enabled: enabled, rewardCompatible: rewardCompatible, isNative: true, decimals: 18, symbol: "OKB"
        });
    }

    function _erc20(bool enabled, bool rewardCompatible, uint8 decimals)
        internal
        pure
        returns (PerkTypes.AssetInfo memory)
    {
        return PerkTypes.AssetInfo({
            enabled: enabled, rewardCompatible: rewardCompatible, isNative: false, decimals: decimals, symbol: "USDC"
        });
    }
}
