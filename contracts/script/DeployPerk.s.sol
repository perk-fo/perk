// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {TemplateRegistry} from "../src/registry/TemplateRegistry.sol";
import {ModuleRegistry} from "../src/registry/ModuleRegistry.sol";
import {AssetRegistry} from "../src/registry/AssetRegistry.sol";
import {CommunityTreasury} from "../src/treasury/CommunityTreasury.sol";
import {LaunchFactory} from "../src/factory/LaunchFactory.sol";
import {ReferralRegistry} from "../src/referral/ReferralRegistry.sol";
import {IPerkLPGrantVault} from "../src/interfaces/IPerkLPGrantVault.sol";
import {ArtifactDeployer} from "./lib/ArtifactDeployer.sol";
import {HolderRewardDistributor} from "../src/rewards/HolderRewardDistributor.sol";
import {FeeRouter} from "../src/fees/FeeRouter.sol";
import {BondingCurve} from "../src/curve/BondingCurve.sol";
import {PerkComposableHookV1} from "../src/hook/PerkComposableHookV1.sol";
import {GraduationManager} from "../src/graduation/GraduationManager.sol";
import {InitialLpLocker} from "../src/graduation/InitialLpLocker.sol";
import {MockERC20} from "../test/utils/MockERC20.sol";

import {HookAddress} from "./lib/HookAddress.sol";
import {XLayerAddresses} from "./lib/XLayerAddresses.sol";
import {TestnetV4Deployer} from "./DeployTestnetV4.s.sol";

/// @title DeployPerk
/// @notice Deploys the full V1 topology and writes `deployments/<chainId>.json`.
contract DeployPerk is Script {
    uint256 internal constant DEFAULT_TIMELOCK = 172_800;

    error HookAddressMismatch(address expected, address actual);
    error MainnetV4Missing();

    address public deployer;
    address public protocolOwner;
    address public protocolFeeRecipient;
    uint256 public timelock;

    address public poolManager;
    address public positionManager;
    address public permit2;
    address public universalRouter;
    address public stateView;
    address public quoter;

    TemplateRegistry public templateRegistry;
    ModuleRegistry public moduleRegistry;
    AssetRegistry public assetRegistry;
    CommunityTreasury public treasury;
    LaunchFactory public factory;
    HolderRewardDistributor public distributor;
    FeeRouter public feeRouter;
    BondingCurve public curve;
    InitialLpLocker public locker;
    GraduationManager public graduationManager;
    PerkComposableHookV1 public hook;
    bytes32 public hookSalt;
    ReferralRegistry public referralRegistry;
    IPerkLPGrantVault public lpGrantVault;
    address public xdogToken;

    /// @notice Deploy and wire every V1 singleton. Owner of Ownable contracts is the deployer until ConfigurePerk.
    function run() public {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(pk);
        protocolOwner = vm.envOr("PROTOCOL_OWNER", deployer);
        if (protocolOwner == address(0)) protocolOwner = deployer;
        protocolFeeRecipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", deployer);
        if (protocolFeeRecipient == address(0)) protocolFeeRecipient = deployer;
        timelock = vm.envOr("TREASURY_TIMELOCK_SECONDS", DEFAULT_TIMELOCK);

        vm.startBroadcast(pk);
        _resolveV4();
        _deployStack();
        _deployHook();
        _wire();
        _resolveXdog();
        vm.stopBroadcast();

        _writeDeployment();
        _logSummary();
    }

    function _resolveV4() internal {
        if (block.chainid == XLayerAddresses.MAINNET_CHAIN_ID) {
            poolManager = XLayerAddresses.POOL_MANAGER;
            positionManager = XLayerAddresses.POSITION_MANAGER;
            permit2 = XLayerAddresses.PERMIT2;
            universalRouter = XLayerAddresses.UNIVERSAL_ROUTER;
            stateView = XLayerAddresses.STATE_VIEW;
            quoter = XLayerAddresses.QUOTER;
            if (poolManager.code.length == 0 || positionManager.code.length == 0) revert MainnetV4Missing();
            return;
        }

        poolManager = vm.envOr("V4_TESTNET_POOL_MANAGER", address(0));
        positionManager = vm.envOr("V4_TESTNET_POSITION_MANAGER", address(0));
        permit2 = XLayerAddresses.PERMIT2;

        if (poolManager == address(0)) {
            (poolManager, positionManager, permit2) = TestnetV4Deployer.deploy(vm, deployer);
            return;
        }
        if (positionManager == address(0)) {
            permit2 = TestnetV4Deployer.ensurePermit2(vm);
            positionManager = TestnetV4Deployer.deployPositionManager(vm, IPoolManager(poolManager), permit2);
        }
    }

    function _deployStack() internal {
        templateRegistry = new TemplateRegistry(deployer);
        moduleRegistry = new ModuleRegistry(deployer);
        assetRegistry = new AssetRegistry(deployer);
        treasury = new CommunityTreasury(deployer, timelock);

        factory = new LaunchFactory(
            deployer,
            address(templateRegistry),
            address(moduleRegistry),
            address(assetRegistry),
            poolManager,
            address(treasury)
        );
        distributor = new HolderRewardDistributor(address(factory));
        feeRouter =
            new FeeRouter(deployer, address(factory), address(distributor), address(treasury), protocolFeeRecipient);
        curve = new BondingCurve(address(factory), address(feeRouter));

        locker = new InitialLpLocker(positionManager, address(treasury));
        graduationManager = new GraduationManager(
            deployer,
            address(factory),
            address(curve),
            address(feeRouter),
            poolManager,
            positionManager,
            address(templateRegistry),
            address(locker)
        );
        referralRegistry = new ReferralRegistry();
        lpGrantVault = IPerkLPGrantVault(
            ArtifactDeployer.deploy(
                vm,
                "LPGrantVault.sol:LPGrantVault",
                abi.encode(
                    deployer,
                    address(factory),
                    address(templateRegistry),
                    address(referralRegistry),
                    address(treasury),
                    poolManager,
                    positionManager,
                    IPerkLPGrantVault.Config({
                        rootDelaySeconds: uint64(vm.envOr("GRANT_ROOT_DELAY_SECONDS", uint256(1 days))),
                        rootDeadlineSeconds: uint64(vm.envOr("GRANT_ROOT_DEADLINE_SECONDS", uint256(14 days))),
                        minActivation: vm.envOr("GRANT_MIN_ACTIVATION", uint256(1e18)),
                        excessToIncentiveBps: uint16(vm.envOr("GRANT_EXCESS_TO_INCENTIVE_BPS", uint256(10_000)))
                    })
                )
            )
        );
    }

    function _deployHook() internal {
        bytes memory ctorArgs = abi.encode(poolManager, address(feeRouter), address(graduationManager));
        (address predicted, bytes32 salt) =
            HookAddress.find(HookAddress.CREATE2_DEPLOYER, type(PerkComposableHookV1).creationCode, ctorArgs);
        hookSalt = salt;
        hook = new PerkComposableHookV1{salt: salt}(
            IPoolManager(poolManager), address(feeRouter), address(graduationManager)
        );
        if (address(hook) != predicted) revert HookAddressMismatch(predicted, address(hook));
    }

    function _wire() internal {
        factory.wire(
            address(curve),
            address(feeRouter),
            address(distributor),
            address(hook),
            address(graduationManager),
            address(lpGrantVault)
        );
        // BondingCurve.wire is onlyFactory; LaunchFactory.wire invokes it.
        feeRouter.wire(address(hook), address(graduationManager));
        graduationManager.wire(address(hook));
        graduationManager.wireVault(address(lpGrantVault));
        lpGrantVault.wire(address(graduationManager));
    }

    function _resolveXdog() internal {
        xdogToken = vm.envOr("XDOG_TOKEN_ADDRESS", address(0));
        if (xdogToken == address(0) && block.chainid != XLayerAddresses.MAINNET_CHAIN_ID) {
            xdogToken = address(new MockERC20("XDOG mock", "XDOG", 18));
        }
    }

    function _writeDeployment() internal {
        string memory obj = "perk.deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "blockNumber", block.number);
        vm.serializeString(obj, "gitCommit", vm.envOr("GIT_COMMIT", string("unknown")));
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "protocolOwner", protocolOwner);
        vm.serializeAddress(obj, "protocolFeeRecipient", protocolFeeRecipient);
        vm.serializeUint(obj, "timelock", timelock);
        vm.serializeAddress(obj, "poolManager", poolManager);
        vm.serializeAddress(obj, "positionManager", positionManager);
        vm.serializeAddress(obj, "permit2", permit2);
        vm.serializeAddress(obj, "universalRouter", universalRouter);
        vm.serializeAddress(obj, "stateView", stateView);
        vm.serializeAddress(obj, "quoter", quoter);
        vm.serializeAddress(obj, "templateRegistry", address(templateRegistry));
        vm.serializeAddress(obj, "moduleRegistry", address(moduleRegistry));
        vm.serializeAddress(obj, "assetRegistry", address(assetRegistry));
        vm.serializeAddress(obj, "treasury", address(treasury));
        vm.serializeAddress(obj, "factory", address(factory));
        vm.serializeAddress(obj, "distributor", address(distributor));
        vm.serializeAddress(obj, "feeRouter", address(feeRouter));
        vm.serializeAddress(obj, "curve", address(curve));
        vm.serializeAddress(obj, "locker", address(locker));
        vm.serializeAddress(obj, "graduationManager", address(graduationManager));
        vm.serializeBytes32(obj, "hookSalt", hookSalt);
        vm.serializeAddress(obj, "referralRegistry", address(referralRegistry));
        vm.serializeAddress(obj, "lpGrantVault", address(lpGrantVault));
        string memory json = vm.serializeAddress(obj, "hook", address(hook));
        json = vm.serializeAddress(obj, "xdogToken", xdogToken);
        vm.writeJson(json, _deploymentPath());
    }

    function _deploymentPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function _logSummary() internal view {
        console2.log("============================================================");
        console2.log("Perk V1 deployment");
        console2.log("  chainId              ", block.chainid);
        console2.log("  blockNumber          ", block.number);
        console2.log("  deployer             ", deployer);
        console2.log("  protocolOwner        ", protocolOwner);
        console2.log("  protocolFeeRecipient ", protocolFeeRecipient);
        console2.log("------------------------------------------------------------");
        console2.log("  poolManager          ", poolManager);
        console2.log("  positionManager      ", positionManager);
        console2.log("  templateRegistry     ", address(templateRegistry));
        console2.log("  moduleRegistry       ", address(moduleRegistry));
        console2.log("  assetRegistry        ", address(assetRegistry));
        console2.log("  treasury             ", address(treasury));
        console2.log("  factory              ", address(factory));
        console2.log("  distributor          ", address(distributor));
        console2.log("  feeRouter            ", address(feeRouter));
        console2.log("  curve                ", address(curve));
        console2.log("  locker               ", address(locker));
        console2.log("  graduationManager    ", address(graduationManager));
        console2.log("  hook                 ", address(hook));
        console2.log("  referralRegistry     ", address(referralRegistry));
        console2.log("  lpGrantVault         ", address(lpGrantVault));
        console2.log("  xdogToken            ", xdogToken);
        console2.log("  wrote                ", _deploymentPath());
        console2.log("============================================================");
    }
}
