// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

import {DeployPerk} from "../../script/DeployPerk.s.sol";
import {ConfigurePerk} from "../../script/ConfigurePerk.s.sol";
import {HookAddress} from "../../script/lib/HookAddress.sol";
import {PerkComposableHookV1} from "../../src/hook/PerkComposableHookV1.sol";
import {LaunchFactory} from "../../src/factory/LaunchFactory.sol";
import {BondingCurve} from "../../src/curve/BondingCurve.sol";
import {FeeRouter} from "../../src/fees/FeeRouter.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PosmDeployer} from "../utils/PosmDeployer.sol";

contract DeployScriptsTest is Test, Deployers, PosmDeployer {
    using CurrencyLibrary for Currency;

    uint256 internal constant DEPLOYER_PK = 0xA11CE;
    uint256 internal constant BUY_GROSS = 200 ether;
    uint256 internal constant SWAP_IN = 1e18;

    address internal deployer;
    address internal creator;
    address internal buyer;
    address internal swapper;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_PK);
        creator = makeAddr("creator");
        buyer = makeAddr("buyer");
        swapper = makeAddr("swapper");
        vm.deal(deployer, 10_000 ether);
        vm.deal(creator, 1000 ether);
        vm.deal(buyer, 1000 ether);
        vm.deal(swapper, 1000 ether);

        deployFreshManagerAndRouters();
        (IPositionManager posm,) = deployPosm(manager);

        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_PK));
        vm.setEnv("PROTOCOL_OWNER", vm.toString(deployer));
        vm.setEnv("PROTOCOL_FEE_RECIPIENT", vm.toString(deployer));
        vm.setEnv("XDOG_TOKEN_ADDRESS", vm.toString(address(0)));
        vm.setEnv("V4_TESTNET_POOL_MANAGER", vm.toString(address(manager)));
        vm.setEnv("V4_TESTNET_POSITION_MANAGER", vm.toString(address(posm)));
        vm.setEnv("TREASURY_TIMELOCK_SECONDS", "172800");
        vm.setEnv("GIT_COMMIT", "test");
    }

    function test_hookAddress_miner_expectedFlags() public view {
        bytes memory args = abi.encode(address(1), address(2), address(3));
        (address addr,) = HookAddress.find(address(this), type(PerkComposableHookV1).creationCode, args);
        assertTrue(HookAddress.hasExpectedFlags(addr));
        assertEq(uint160(addr) & HookAddress.FLAG_MASK, HookAddress.flags());
    }

    function test_hook_reverts_wrongFlags() public {
        address wrong = address((HookAddress.flags() | Hooks.BEFORE_DONATE_FLAG) ^ (0x4444 << 144));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrong));
        deployCodeTo(
            "PerkComposableHookV1.sol:PerkComposableHookV1", abi.encode(address(manager), address(1), address(2)), wrong
        );
    }

    function test_run_deployAndConfigure_curveBuyGraduateSwap() public {
        DeployPerk deploy = new DeployPerk();
        deploy.run();
        new ConfigurePerk().run();

        assertTrue(HookAddress.hasExpectedFlags(address(deploy.hook())));
        assertEq(uint160(address(deploy.hook())) & HookAddress.FLAG_MASK, HookAddress.flags());

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".factory"), address(deploy.factory()));
        assertEq(vm.parseJsonAddress(json, ".hook"), address(deploy.hook()));
        assertEq(vm.parseJsonAddress(json, ".poolManager"), address(manager));

        LaunchFactory factory = deploy.factory();
        BondingCurve curve = deploy.curve();
        IPerkGraduationManager graduation = deploy.graduationManager();
        FeeRouter feeRouter = deploy.feeRouter();
        Currency native = Currency.wrap(address(0));

        PerkTypes.CreateLaunchParams memory p;
        p.templateId = PerkConstants.TEMPLATE_PERK_GRANT_V1;
        p.quote = native;
        p.moduleParams = "";
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.devBuyQuote = 0;
        p.salt = keccak256("deploy-scripts");
        vm.prank(creator);
        (,,, bytes32 configHash) = factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (address meme,) = factory.createLaunch(p);

        vm.prank(buyer);
        curve.buy{value: BUY_GROSS}(meme, BUY_GROSS, 0, buyer);
        assertEq(uint256(factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));

        graduation.graduate(meme);
        IPerkGraduationManager.Graduation memory g = graduation.graduationOf(meme);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(uint256(factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertTrue(deploy.hook().poolInfo(g.poolId).initialized);

        uint256 routerBefore = native.balanceOf(address(feeRouter));
        bool quoteIs0 = g.key.currency0 == native;
        vm.prank(swapper);
        swapRouter.swap{value: SWAP_IN}(
            g.key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(SWAP_IN),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        assertGt(native.balanceOf(address(feeRouter)), routerBefore);
    }
}
