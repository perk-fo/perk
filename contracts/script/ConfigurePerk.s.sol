// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {TemplateRegistry} from "../src/registry/TemplateRegistry.sol";
import {ModuleRegistry} from "../src/registry/ModuleRegistry.sol";
import {AssetRegistry} from "../src/registry/AssetRegistry.sol";
import {CommunityTreasury} from "../src/treasury/CommunityTreasury.sol";
import {LaunchFactory} from "../src/factory/LaunchFactory.sol";
import {FeeRouter} from "../src/fees/FeeRouter.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";
import {IPerkLPGrantVault} from "../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../src/libraries/PerkTypes.sol";

import {HookAddress} from "./lib/HookAddress.sol";

/// @title ConfigurePerk
/// @notice Registers V1 modules, templates and quote assets, then starts Ownable2Step handoff to PROTOCOL_OWNER.
contract ConfigurePerk is Script {
    error DeploymentFileMissing(string path);

    /// @notice Configure the topology written by DeployPerk for this chain.
    function run() public {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address protocolOwner = vm.envOr("PROTOCOL_OWNER", vm.addr(pk));
        if (protocolOwner == address(0)) protocolOwner = vm.addr(pk);

        string memory path = _deploymentPath();
        if (!vm.exists(path)) revert DeploymentFileMissing(path);
        string memory json = vm.readFile(path);

        ModuleRegistry moduleRegistry = ModuleRegistry(vm.parseJsonAddress(json, ".moduleRegistry"));
        TemplateRegistry templateRegistry = TemplateRegistry(vm.parseJsonAddress(json, ".templateRegistry"));
        AssetRegistry assetRegistry = AssetRegistry(vm.parseJsonAddress(json, ".assetRegistry"));
        CommunityTreasury treasury = CommunityTreasury(payable(vm.parseJsonAddress(json, ".treasury")));
        LaunchFactory factory = LaunchFactory(payable(vm.parseJsonAddress(json, ".factory")));
        FeeRouter feeRouter = FeeRouter(payable(vm.parseJsonAddress(json, ".feeRouter")));
        IPerkGraduationManager graduationManager =
            IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        Ownable2Step grantReserve = Ownable2Step(vm.parseJsonAddress(json, ".lpGrantVault"));
        address xdogToken = vm.parseJsonAddress(json, ".xdogToken");

        // the grant publisher: an automated key that may propose and cancel grant roots and nothing else
        address publisher = vm.envOr("GRANT_PUBLISHER", address(0));

        vm.startBroadcast(pk);
        _registerModules(moduleRegistry, xdogToken);
        _registerAssets(assetRegistry, xdogToken);
        _registerTemplates(templateRegistry);
        if (publisher != address(0)) IPerkLPGrantVault(address(grantReserve)).setPublisher(publisher);
        _transferOwnerships(
            protocolOwner,
            moduleRegistry,
            templateRegistry,
            assetRegistry,
            treasury,
            factory,
            feeRouter,
            graduationManager,
            grantReserve
        );
        vm.stopBroadcast();

        console2.log("============================================================");
        console2.log("WARNING: PERK_GRANT_V1 and STANDARD_CURVE_V1 numbers are PLACEHOLDERS");
        console2.log("         from PerkTemplates.defaultNumbers(). Do not treat them as final.");
        console2.log("============================================================");
        console2.log("PROTOCOL_OWNER must acceptOwnership() on:");
        console2.log("  TemplateRegistry     ", address(templateRegistry));
        console2.log("  ModuleRegistry       ", address(moduleRegistry));
        console2.log("  AssetRegistry        ", address(assetRegistry));
        console2.log("  CommunityTreasury    ", address(treasury));
        console2.log("  LaunchFactory        ", address(factory));
        console2.log("  FeeRouter            ", address(feeRouter));
        console2.log("  GraduationManager    ", address(graduationManager));
        console2.log("  LPGrantVault         ", address(grantReserve));
        console2.log("  PROTOCOL_OWNER       ", protocolOwner);
        console2.log("============================================================");
    }

    function _registerModules(ModuleRegistry registry, address xdogToken) internal {
        uint160 hookPerms = HookAddress.flags();
        registry.registerModule(
            _module(
                PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
                PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _module(
                PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
                PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _module(
                PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
                PerkConstants.MODULE_HOLDER_QUOTE_REWARD_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _module(PerkConstants.MODULE_ID_LP_GRANT, PerkConstants.MODULE_LP_GRANT_V1, PerkTypes.ModuleType.GROWTH, 0)
        );
        registry.registerModule(
            _module(
                PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST,
                PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1,
                PerkTypes.ModuleType.GROWTH,
                0
            )
        );

        Currency native = Currency.wrap(address(0));
        _setQuotes(registry, native);
        if (xdogToken != address(0)) _setQuotes(registry, Currency.wrap(xdogToken));
    }

    function _setQuotes(ModuleRegistry registry, Currency quote) internal {
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_LP_GRANT, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST, 1, quote, true);
    }

    function _registerAssets(AssetRegistry registry, address xdogToken) internal {
        registry.setAsset(
            Currency.wrap(address(0)),
            PerkTypes.AssetInfo({enabled: true, rewardCompatible: true, isNative: true, decimals: 18, symbol: "OKB"})
        );
        if (xdogToken != address(0)) {
            IERC20Metadata token = IERC20Metadata(xdogToken);
            registry.setAsset(
                Currency.wrap(xdogToken),
                PerkTypes.AssetInfo({
                    enabled: true,
                    rewardCompatible: true,
                    isNative: false,
                    decimals: token.decimals(),
                    symbol: token.symbol()
                })
            );
        }
    }

    /// @dev The two V1 templates are bound to native OKB (curve numbers are quote units). Other quote assets get
    ///      their own bound copies through ConfigureQuoteAsset.s.sol.
    function _registerTemplates(TemplateRegistry registry) internal {
        PerkTemplates.Numbers memory n =
            PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), Currency.wrap(address(0)), 18);
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, PerkTemplates.perkGrantV1(n));
        registry.registerTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, PerkTemplates.standardCurveV1(n));
    }

    function _transferOwnerships(
        address protocolOwner,
        ModuleRegistry moduleRegistry,
        TemplateRegistry templateRegistry,
        AssetRegistry assetRegistry,
        CommunityTreasury treasury,
        LaunchFactory factory,
        FeeRouter feeRouter,
        IPerkGraduationManager graduationManager,
        Ownable2Step grantReserve
    ) internal {
        Ownable2Step(address(templateRegistry)).transferOwnership(protocolOwner);
        Ownable2Step(address(moduleRegistry)).transferOwnership(protocolOwner);
        Ownable2Step(address(assetRegistry)).transferOwnership(protocolOwner);
        Ownable2Step(address(treasury)).transferOwnership(protocolOwner);
        Ownable2Step(address(factory)).transferOwnership(protocolOwner);
        Ownable2Step(address(feeRouter)).transferOwnership(protocolOwner);
        Ownable2Step(address(graduationManager)).transferOwnership(protocolOwner);
        Ownable2Step(address(grantReserve)).transferOwnership(protocolOwner);
    }

    function _module(bytes32 moduleId, uint256 bit, PerkTypes.ModuleType moduleType, uint160 hookPermissionBitmap)
        private
        pure
        returns (PerkTypes.ModuleInfo memory)
    {
        return PerkTypes.ModuleInfo({
            moduleId: moduleId,
            version: 1,
            moduleType: moduleType,
            bit: bit,
            hookPermissionBitmap: hookPermissionBitmap,
            runtimeCodeHash: bytes32(uint256(1)),
            sourceCommit: "v1",
            incompatibleModules: 0,
            status: PerkTypes.RegistryStatus.ACTIVE
        });
    }

    function _deploymentPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }
}
