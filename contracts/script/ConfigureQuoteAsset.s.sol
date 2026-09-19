// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {IPerkAssetRegistry} from "../src/interfaces/IPerkAssetRegistry.sol";
import {IPerkModuleRegistry} from "../src/interfaces/IPerkModuleRegistry.sol";
import {IPerkTemplateRegistry} from "../src/interfaces/IPerkTemplateRegistry.sol";
import {PerkConstants} from "../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {XLayerAddresses} from "./lib/XLayerAddresses.sol";
import {MockERC20} from "../test/utils/MockERC20.sol";

/// @notice Adds one ERC-20 quote asset (e.g. a tokenized stock) to an existing deployment: asset registry entry,
///         module compatibility, and quote-bound templates with decimals-rescaled curve numbers.
///           QUOTE_TOKEN          existing token address; on a test network leave empty and set QUOTE_MOCK_SYMBOL /
///                                QUOTE_MOCK_DECIMALS to deploy a mock (mainnet refuses mocks)
///           QUOTE_TEMPLATES      "v1" (default: PERK_GRANT_V1 + STANDARD_CURVE_V1 bound to the quote),
///                                add ",fast" on test networks to also bind TEST_TEMPLATE with the fast env timings
///         Mainnet templates use PerkTemplates.defaultNumbers() rescaled by decimals only; USD parity is the client's call.
contract ConfigureQuoteAsset is Script {
    error MockOnMainnet();
    error NotCompatible(string reason);

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        IPerkAssetRegistry assets = IPerkAssetRegistry(vm.parseJsonAddress(json, ".assetRegistry"));
        IPerkModuleRegistry modules = IPerkModuleRegistry(vm.parseJsonAddress(json, ".moduleRegistry"));
        IPerkTemplateRegistry templates = IPerkTemplateRegistry(vm.parseJsonAddress(json, ".templateRegistry"));

        address token = vm.envOr("QUOTE_TOKEN", address(0));
        vm.startBroadcast(pk);
        if (token == address(0)) {
            if (block.chainid == XLayerAddresses.MAINNET_CHAIN_ID) revert MockOnMainnet();
            string memory sym = vm.envString("QUOTE_MOCK_SYMBOL");
            uint8 dec = uint8(vm.envOr("QUOTE_MOCK_DECIMALS", uint256(6)));
            MockERC20 mock = new MockERC20(string.concat("Mock ", sym), sym, dec);
            mock.mint(vm.addr(pk), 1_000_000 * 10 ** dec);
            token = address(mock);
            console2.log("deployed mock quote", sym, token);
        }
        Currency quote = Currency.wrap(token);
        IERC20Metadata meta = IERC20Metadata(token);
        uint8 decimals = meta.decimals();

        assets.setAsset(
            quote,
            PerkTypes.AssetInfo({
                enabled: true, rewardCompatible: true, isNative: false, decimals: decimals, symbol: meta.symbol()
            })
        );
        bytes32[5] memory mods = [
            PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
            PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
            PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
            PerkConstants.MODULE_ID_LP_GRANT,
            PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST
        ];
        for (uint256 i; i < mods.length; ++i) {
            modules.setQuoteCompatibility(mods[i], 1, quote, true);
        }

        PerkTemplates.Numbers memory n = PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), quote, decimals);
        _register(
            templates,
            PerkTemplates.templateIdFor(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote),
            PerkTemplates.perkGrantV1(n),
            "PERK_GRANT_V1"
        );
        _register(
            templates,
            PerkTemplates.templateIdFor(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, quote),
            PerkTemplates.standardCurveV1(n),
            "STANDARD_CURVE_V1"
        );

        if (block.chainid != XLayerAddresses.MAINNET_CHAIN_ID) {
            string memory fastName = vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"));
            PerkTemplates.Numbers memory f = n;
            uint256 scaleDiv = vm.envOr("TEST_CURVE_SCALE_DIV", uint256(10_000));
            f.virtualQuoteReserve = n.virtualQuoteReserve / scaleDiv;
            f.graduationQuoteThreshold = n.graduationQuoteThreshold / scaleDiv;
            f.grantWindowSeconds = uint64(vm.envOr("TEST_GRANT_WINDOW_SECONDS", uint256(7200)));
            f.minLpSeconds = uint64(vm.envOr("TEST_MIN_LP_SECONDS", uint256(600)));
            _register(
                templates,
                PerkTemplates.templateIdFor(keccak256(bytes(fastName)), quote),
                PerkTemplates.perkGrantV1(f),
                fastName
            );
        }
        vm.stopBroadcast();

        (bool ok, string memory reason) = modules.validateCompatibility(
            PerkConstants.CORE_MODULES_V1 | PerkConstants.MODULE_LP_GRANT_V1
                | PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1,
            quote
        );
        if (!ok) revert NotCompatible(reason);

        // record the quote in the deployment file under quoteAssets.<SYMBOL>
        vm.writeJson(vm.toString(token), path, string.concat(".quoteAssets.", meta.symbol()));
        console2.log("quote asset configured", meta.symbol(), token);
        console2.log("  decimals", decimals);
        console2.log("  threshold (quote units)", n.graduationQuoteThreshold);
    }

    function _register(IPerkTemplateRegistry registry, bytes32 id, PerkTypes.Template memory t, string memory label)
        internal
    {
        if (registry.isActive(id)) {
            console2.log("template already active", label);
            return;
        }
        registry.registerTemplate(id, t);
        console2.log("registered bound template", label, vm.toString(id));
    }
}
