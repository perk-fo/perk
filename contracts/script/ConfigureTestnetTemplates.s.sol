// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {IPerkTemplateRegistry} from "../src/interfaces/IPerkTemplateRegistry.sol";
import {PerkTemplates} from "../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {XLayerAddresses} from "./lib/XLayerAddresses.sol";

/// @notice Registers an extra, fast-cycling Perk template on a TEST network. Every number comes from the environment,
///         so nothing test-specific ever lives in contract source or in the mainnet configuration:
///           TEST_TEMPLATE              id string, default "TEST_FAST_V1"
///           TEST_CURVE_SCALE_DIV       divides virtualQuoteReserve and graduationQuoteThreshold, default 10000
///           TEST_GRANT_WINDOW_SECONDS  default 7200
///           TEST_MIN_LP_SECONDS        default 600
contract ConfigureTestnetTemplates is Script {
    error MainnetForbidden();

    function run() external {
        if (block.chainid == XLayerAddresses.MAINNET_CHAIN_ID) revert MainnetForbidden();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IPerkTemplateRegistry registry = IPerkTemplateRegistry(vm.parseJsonAddress(json, ".templateRegistry"));

        string memory idString = vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"));
        bytes32 templateId = keccak256(bytes(idString));
        uint256 scaleDiv = vm.envOr("TEST_CURVE_SCALE_DIV", uint256(10_000));

        PerkTemplates.Numbers memory n =
            PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), Currency.wrap(address(0)), 18); // bound to native OKB
        n.virtualQuoteReserve = n.virtualQuoteReserve / scaleDiv;
        n.graduationQuoteThreshold = n.graduationQuoteThreshold / scaleDiv;
        n.grantWindowSeconds = uint64(vm.envOr("TEST_GRANT_WINDOW_SECONDS", uint256(7200)));
        n.minLpSeconds = uint64(vm.envOr("TEST_MIN_LP_SECONDS", uint256(600)));
        PerkTypes.Template memory t = PerkTemplates.perkGrantV1(n);

        if (registry.isActive(templateId)) {
            console2.log("template already active", idString);
            return;
        }
        vm.startBroadcast(pk);
        registry.registerTemplate(templateId, t);
        vm.stopBroadcast();
        console2.log("registered", idString);
        console2.log("  threshold (wei quote)", n.graduationQuoteThreshold);
        console2.log("  grant window (s)", n.grantWindowSeconds);
        console2.log("  min LP (s)", n.minLpSeconds);
    }
}
