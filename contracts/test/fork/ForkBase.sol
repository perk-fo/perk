// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Permit2Forwarder} from "v4-periphery/src/base/Permit2Forwarder.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

import {LaunchFactory} from "../../src/factory/LaunchFactory.sol";
import {ReferralRegistry} from "../../src/referral/ReferralRegistry.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {TemplateRegistry} from "../../src/registry/TemplateRegistry.sol";
import {ModuleRegistry} from "../../src/registry/ModuleRegistry.sol";
import {AssetRegistry} from "../../src/registry/AssetRegistry.sol";
import {CommunityTreasury} from "../../src/treasury/CommunityTreasury.sol";
import {HolderRewardDistributor} from "../../src/rewards/HolderRewardDistributor.sol";
import {FeeRouter} from "../../src/fees/FeeRouter.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {GraduationManager} from "../../src/graduation/GraduationManager.sol";
import {InitialLpLocker} from "../../src/graduation/InitialLpLocker.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {XLayerAddresses} from "../../script/lib/XLayerAddresses.sol";
import {PerkDeployer} from "../utils/PerkDeployer.sol";

/// @dev Forks X Layer and deploys Perk against the canonical PoolManager / PositionManager.
abstract contract ForkBase is PerkDeployer {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;
    uint256 internal constant BUY_GROSS = 200 ether;
    uint256 internal constant SWAP_IN = 1 ether;

    Topology internal t;
    PoolSwapTest internal swapRouter;
    address internal creator;
    address internal buyer;
    address internal swapper;

    /// @notice Fork X Layer and wire Perk to the canonical v4 contracts. Skips when `ALCHEMY_API_KEY` is empty.
    function setUp() public {
        if (bytes(vm.envOr("ALCHEMY_API_KEY", string(""))).length == 0) {
            vm.skip(true);
            return;
        }

        uint256 forkBlock = _envUintOrZero("XLAYER_FORK_BLOCK");
        // Latest when 0: `createSelectFork(url, 0)` would pin genesis on some Foundry versions.
        if (forkBlock == 0) {
            vm.createSelectFork(vm.rpcUrl("xlayer"));
        } else {
            vm.createSelectFork(vm.rpcUrl("xlayer"), forkBlock);
        }

        t = _deployPerkAgainstCanonicalV4(address(this));
        swapRouter = new PoolSwapTest(IPoolManager(t.poolManager));

        creator = makeAddr("creator");
        buyer = makeAddr("buyer");
        swapper = makeAddr("swapper");
        vm.deal(creator, 1000 ether);
        vm.deal(buyer, 1000 ether);
        vm.deal(swapper, 1000 ether);

        address xdog = _xdogToken();
        if (xdog != address(0)) {
            _whitelistQuote(Currency.wrap(xdog), IERC20Metadata(xdog).decimals(), IERC20Metadata(xdog).symbol(), false);
            t.erc20Quote = Currency.wrap(xdog);
            _dealAndApprove(xdog, buyer, BUY_GROSS * 10, address(t.curve));
            _dealAndApprove(xdog, swapper, SWAP_IN * 10, address(swapRouter));
        }
    }

    /// @dev `deployPerkV1` but with the live PoolManager / PositionManager (does not `deployPosm`).
    function _deployPerkAgainstCanonicalV4(address owner) internal returns (Topology memory topo) {
        topo.owner = owner;
        topo.poolManager = XLayerAddresses.POOL_MANAGER;
        topo.nativeQuote = Currency.wrap(address(0));
        topo.positionManager = IPositionManager(XLayerAddresses.POSITION_MANAGER);
        topo.permit2 = Permit2Forwarder(XLayerAddresses.POSITION_MANAGER).permit2();

        topo.templateRegistry = new TemplateRegistry(owner);
        topo.moduleRegistry = new ModuleRegistry(owner);
        topo.assetRegistry = new AssetRegistry(owner);
        topo.treasury = new CommunityTreasury(owner, DEFAULT_TIMELOCK);

        topo.factory = new LaunchFactory(
            owner,
            address(topo.templateRegistry),
            address(topo.moduleRegistry),
            address(topo.assetRegistry),
            topo.poolManager,
            address(topo.treasury)
        );
        topo.distributor = new HolderRewardDistributor(address(topo.factory));
        topo.feeRouter =
            new FeeRouter(owner, address(topo.factory), address(topo.distributor), address(topo.treasury), owner);
        topo.curve = new BondingCurve(address(topo.factory), address(topo.feeRouter));
        topo.referral = new ReferralRegistry();

        topo.locker = new InitialLpLocker(address(topo.positionManager), address(topo.treasury));
        topo.graduation = new GraduationManager(
            owner,
            address(topo.factory),
            address(topo.curve),
            address(topo.feeRouter),
            topo.poolManager,
            address(topo.positionManager),
            address(topo.templateRegistry),
            address(topo.locker)
        );
        topo.graduationManager = address(topo.graduation);
        topo.vault = deployVault(
            owner,
            address(topo.factory),
            address(topo.templateRegistry),
            address(topo.referral),
            address(topo.treasury),
            topo.poolManager,
            address(topo.positionManager),
            IPerkLPGrantVault.Config({
                rootDelaySeconds: 1 days,
                rootDeadlineSeconds: 14 days,
                minActivation: 1e18,
                excessToIncentiveBps: 10_000
            })
        );

        address hookAddr = predictedHookAddress();
        topo.hook =
            deployHook(IPoolManager(topo.poolManager), address(topo.feeRouter), topo.graduationManager, hookAddr);

        vm.startPrank(owner);
        topo.graduation.wire(address(topo.hook));
        topo.graduation.wireVault(address(topo.vault));
        topo.vault.wire(topo.graduationManager);
        _forkRegisterModules(topo.moduleRegistry);
        _forkWhitelistModuleQuotes(topo.moduleRegistry, topo.nativeQuote);
        _forkRegisterTemplates(topo.templateRegistry);
        topo.assetRegistry
            .setAsset(
                topo.nativeQuote,
                PerkTypes.AssetInfo({
                    enabled: true, rewardCompatible: true, isNative: true, decimals: 18, symbol: "OKB"
                })
            );
        topo.factory
            .wire(
                address(topo.curve),
                address(topo.feeRouter),
                address(topo.distributor),
                address(topo.hook),
                topo.graduationManager,
                address(topo.vault)
            );
        topo.feeRouter.wire(address(topo.hook), topo.graduationManager);
        vm.stopPrank();
    }

    function _createLaunch(Currency quote, bytes32 salt) internal returns (address meme, uint256 gasUsed) {
        PerkTypes.CreateLaunchParams memory p;
        p.templateId = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        p.quote = quote;
        p.moduleParams = "";
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.devBuyQuote = 0;
        p.salt = salt;
        vm.prank(creator);
        (,,, bytes32 configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;

        vm.startSnapshotGas("fork_createLaunch");
        vm.prank(creator);
        (meme,) = t.factory.createLaunch(p);
        gasUsed = vm.stopSnapshotGas();
    }

    function _buyToGraduation(address meme, Currency quote) internal returns (uint256 gasUsed) {
        vm.startSnapshotGas("fork_buy");
        if (quote.isAddressZero()) {
            vm.prank(buyer);
            t.curve.buy{value: BUY_GROSS}(meme, BUY_GROSS, 0, buyer);
        } else {
            vm.prank(buyer);
            t.curve.buy(meme, BUY_GROSS, 0, buyer);
        }
        gasUsed = vm.stopSnapshotGas();
    }

    function _swapQuoteIn(PoolKey memory key, Currency quote, uint256 amount) internal returns (uint256 gasUsed) {
        bool quoteIs0 = quote == key.currency0;
        vm.startSnapshotGas("fork_swap");
        vm.prank(swapper);
        swapRouter.swap{value: quote.isAddressZero() ? amount : 0}(
            key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        gasUsed = vm.stopSnapshotGas();
    }

    function _whitelistQuote(Currency quote, uint8 decimals, string memory symbol, bool isNative) internal {
        _forkWhitelistModuleQuotes(t.moduleRegistry, quote);
        t.assetRegistry
            .setAsset(
                quote,
                PerkTypes.AssetInfo({
                    enabled: true, rewardCompatible: true, isNative: isNative, decimals: decimals, symbol: symbol
                })
            );
    }

    function _dealAndApprove(address token, address user, uint256 amount, address spender) internal {
        deal(token, user, amount);
        vm.prank(user);
        IERC20(token).forceApprove(spender, type(uint256).max);
    }

    function _xdogToken() internal view returns (address) {
        string memory raw = vm.envOr("XDOG_TOKEN_ADDRESS", string(""));
        if (bytes(raw).length == 0) return address(0);
        return vm.parseAddress(raw);
    }

    function _envUintOrZero(string memory name) internal view returns (uint256) {
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) return 0;
        return vm.parseUint(raw);
    }

    function _forkRegisterModules(ModuleRegistry registry) private {
        uint160 hookPerms = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        registry.registerModule(
            _forkModule(
                PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD,
                PerkConstants.MODULE_OFFICIAL_POOL_GUARD_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _forkModule(
                PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER,
                PerkConstants.MODULE_QUOTE_FEE_ROUTER_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _forkModule(
                PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD,
                PerkConstants.MODULE_HOLDER_QUOTE_REWARD_V1,
                PerkTypes.ModuleType.HOOK,
                hookPerms
            )
        );
        registry.registerModule(
            _forkModule(
                PerkConstants.MODULE_ID_LP_GRANT, PerkConstants.MODULE_LP_GRANT_V1, PerkTypes.ModuleType.GROWTH, 0
            )
        );
        registry.registerModule(
            _forkModule(
                PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST,
                PerkConstants.MODULE_REFERRAL_GRANT_BOOST_V1,
                PerkTypes.ModuleType.GROWTH,
                0
            )
        );
    }

    function _forkWhitelistModuleQuotes(ModuleRegistry registry, Currency quote) private {
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_OFFICIAL_POOL_GUARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_QUOTE_FEE_ROUTER, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_HOLDER_QUOTE_REWARD, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_LP_GRANT, 1, quote, true);
        registry.setQuoteCompatibility(PerkConstants.MODULE_ID_REFERRAL_GRANT_BOOST, 1, quote, true);
    }

    function _forkRegisterTemplates(TemplateRegistry registry) private {
        PerkTemplates.Numbers memory n = PerkTemplates.defaultNumbers();
        registry.registerTemplate(PerkConstants.TEMPLATE_PERK_GRANT_V1, PerkTemplates.perkGrantV1(n));
        registry.registerTemplate(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, PerkTemplates.standardCurveV1(n));
    }

    function _forkModule(bytes32 moduleId, uint256 bit, PerkTypes.ModuleType moduleType, uint160 hookPermissionBitmap)
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
