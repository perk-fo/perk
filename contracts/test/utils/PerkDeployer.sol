// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {LaunchFactory} from "../../src/factory/LaunchFactory.sol";
import {ReferralRegistry} from "../../src/referral/ReferralRegistry.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {VaultDeployer} from "./VaultDeployer.sol";
import {TemplateRegistry} from "../../src/registry/TemplateRegistry.sol";
import {ModuleRegistry} from "../../src/registry/ModuleRegistry.sol";
import {AssetRegistry} from "../../src/registry/AssetRegistry.sol";
import {CommunityTreasury} from "../../src/treasury/CommunityTreasury.sol";
import {HolderRewardDistributor} from "../../src/rewards/HolderRewardDistributor.sol";
import {FeeRouter} from "../../src/fees/FeeRouter.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {PerkComposableHookV1} from "../../src/hook/PerkComposableHookV1.sol";
import {GraduationManager} from "../../src/graduation/GraduationManager.sol";
import {InitialLpLocker} from "../../src/graduation/InitialLpLocker.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {HookDeployer} from "./HookDeployer.sol";
import {PosmDeployer} from "./PosmDeployer.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Deploys and wires the full V1 topology for tests (and later scripts).
abstract contract PerkDeployer is HookDeployer, PosmDeployer, VaultDeployer {
    uint256 internal constant DEFAULT_TIMELOCK = 7 days;

    struct Topology {
        address owner;
        address poolManager;
        TemplateRegistry templateRegistry;
        ModuleRegistry moduleRegistry;
        AssetRegistry assetRegistry;
        CommunityTreasury treasury;
        LaunchFactory factory;
        HolderRewardDistributor distributor;
        FeeRouter feeRouter;
        BondingCurve curve;
        PerkComposableHookV1 hook;
        address graduationManager;
        GraduationManager graduation;
        InitialLpLocker locker;
        IPositionManager positionManager;
        IAllowanceTransfer permit2;
        ReferralRegistry referral;
        IPerkLPGrantVault vault;
        MockERC20 quoteToken;
        Currency nativeQuote;
        Currency erc20Quote;
    }

    /// @notice Deploy registries, treasury, factory, distributor, fee router, curve, hook, escrow; wire and configure.
    /// @param owner Ownable owner of every owned contract (caller should be `owner` for subsequent admin calls).
    /// @param poolManager_ Uniswap v4 PoolManager (placeholder address is fine for factory-only tests).
    /// @return t Wired topology addresses.
    function deployPerkV1(address owner, address poolManager_) internal returns (Topology memory t) {
        return deployPerkV1(owner, poolManager_, 10_000);
    }

    /// @notice Same as `deployPerkV1(owner, poolManager_)` with a custom `excessToIncentiveBps` on the grant vault.
    function deployPerkV1(address owner, address poolManager_, uint16 excessToIncentiveBps)
        internal
        returns (Topology memory t)
    {
        return deployPerkV1(owner, poolManager_, excessToIncentiveBps, 500);
    }

    /// @notice As above with a custom grant price guard; `type(uint24).max` switches it off.
    function deployPerkV1(
        address owner,
        address poolManager_,
        uint16 excessToIncentiveBps,
        uint24 maxPriceDeviationTicks
    ) internal returns (Topology memory t) {
        t.owner = owner;
        t.poolManager = poolManager_;
        t.nativeQuote = Currency.wrap(address(0));

        t.templateRegistry = new TemplateRegistry(owner);
        t.moduleRegistry = new ModuleRegistry(owner);
        t.assetRegistry = new AssetRegistry(owner);
        t.treasury = new CommunityTreasury(owner, DEFAULT_TIMELOCK);

        t.factory = new LaunchFactory(
            owner,
            address(t.templateRegistry),
            address(t.moduleRegistry),
            address(t.assetRegistry),
            poolManager_,
            address(t.treasury)
        );
        t.distributor = new HolderRewardDistributor(address(t.factory));
        t.feeRouter = new FeeRouter(owner, address(t.factory), address(t.distributor), address(t.treasury), owner);
        t.curve = new BondingCurve(address(t.factory), address(t.feeRouter));
        t.referral = new ReferralRegistry();

        (t.positionManager, t.permit2) = deployPosm(IPoolManager(poolManager_));
        t.locker = new InitialLpLocker(address(t.positionManager), address(t.treasury));
        t.graduation = new GraduationManager(
            owner,
            address(t.factory),
            address(t.curve),
            address(t.feeRouter),
            poolManager_,
            address(t.positionManager),
            address(t.templateRegistry),
            address(t.locker)
        );
        t.graduationManager = address(t.graduation);
        t.vault = deployVault(
            owner,
            address(t.factory),
            address(t.templateRegistry),
            address(t.referral),
            address(t.treasury),
            poolManager_,
            address(t.positionManager),
            IPerkLPGrantVault.Config({
                rootDelaySeconds: 1 days,
                rootDeadlineSeconds: 14 days,
                minActivation: 1e18,
                excessToIncentiveBps: excessToIncentiveBps,
                maxPriceDeviationTicks: maxPriceDeviationTicks
            })
        );

        address hookAddr = predictedHookAddress();
        t.hook = deployHook(IPoolManager(poolManager_), address(t.feeRouter), t.graduationManager, hookAddr);

        t.quoteToken = new MockERC20("USD Coin", "USDC", 18);
        t.erc20Quote = Currency.wrap(address(t.quoteToken));

        vm.startPrank(owner);
        t.graduation.wire(address(t.hook));
        t.graduation.wireVault(address(t.vault));
        t.vault.wire(t.graduationManager);
        _registerV1Modules(t.moduleRegistry);
        _whitelistModuleQuotes(t.moduleRegistry, t.nativeQuote);
        _whitelistModuleQuotes(t.moduleRegistry, t.erc20Quote);
        _registerV1Templates(t.templateRegistry);
        _whitelistAssets(t.assetRegistry, t.nativeQuote, t.erc20Quote, t.quoteToken);
        t.factory
            .wire(
                address(t.curve),
                address(t.feeRouter),
                address(t.distributor),
                address(t.hook),
                t.graduationManager,
                address(t.vault)
            );
        t.feeRouter.wire(address(t.hook), t.graduationManager);
        vm.stopPrank();
    }

    function _registerV1Modules(ModuleRegistry registry) private {
        uint160 hookPerms = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
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
    }

    function _whitelistModuleQuotes(ModuleRegistry registry, Currency quote) private {
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_LP_GRANT, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST, 1, quote, true);
    }

    function _registerV1Templates(TemplateRegistry registry) private {
        PerkTemplates.Numbers memory n = PerkTemplates.defaultNumbers();
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, PerkTemplates.perkGrantV1(n));
        registry.registerTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, PerkTemplates.standardCurveV1(n));
    }

    function _whitelistAssets(AssetRegistry registry, Currency native, Currency erc20, MockERC20 token) private {
        registry.setAsset(
            native,
            PerkTypes.AssetInfo({enabled: true, rewardCompatible: true, isNative: true, decimals: 18, symbol: "OKB"})
        );
        registry.setAsset(
            erc20,
            PerkTypes.AssetInfo({
                enabled: true,
                rewardCompatible: true,
                isNative: false,
                decimals: token.decimals(),
                symbol: token.symbol()
            })
        );
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
}
