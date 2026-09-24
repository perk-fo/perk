// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {PerkTemplates} from "./lib/PerkTemplates.sol";
import {IPerkLaunchFactory} from "../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkTemplateRegistry} from "../src/interfaces/IPerkTemplateRegistry.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";
import {IPerkFeeRouter} from "../src/interfaces/IPerkFeeRouter.sol";
import {IPerkHolderRewardDistributor} from "../src/interfaces/IPerkHolderRewardDistributor.sol";
import {IPerkComposableHook} from "../src/interfaces/IPerkComposableHook.sol";

/// @notice Testnet-only end-to-end smoke: env-configured test template, create a launch with a dev buy
///         that graduates the curve immediately, graduate it, then take one swap on the official pool.
/// @dev Spends roughly 0.012 OKB. Never run against mainnet (template id is a test id, but be careful anyway).
contract SmokeTestnet is Script {
    function run() external {
        require(block.chainid != 196, "testnet only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IPerkLaunchFactory factory = IPerkLaunchFactory(vm.parseJsonAddress(json, ".factory"));
        IPerkTemplateRegistry templates = IPerkTemplateRegistry(vm.parseJsonAddress(json, ".templateRegistry"));
        IPerkGraduationManager graduation = IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        IPerkFeeRouter feeRouter = IPerkFeeRouter(vm.parseJsonAddress(json, ".feeRouter"));
        IPerkHolderRewardDistributor distributor =
            IPerkHolderRewardDistributor(vm.parseJsonAddress(json, ".distributor"));
        IPerkComposableHook hook = IPerkComposableHook(vm.parseJsonAddress(json, ".hook"));
        IPoolManager poolManager = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));

        vm.startBroadcast(pk);

        // Template ids are never hardcoded: ConfigureTestnetTemplates registers TEST_TEMPLATE from env values.
        bytes32 templateId = keccak256(bytes(vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"))));
        require(templates.isActive(templateId), "test template not active; run ConfigureTestnetTemplates first");

        // Prefer the third-party swap router already on the testnet (proves interop); fall back to our own.
        address routerAddr = vm.envOr("V4_TESTNET_SWAP_ROUTER", address(0));
        PoolSwapTest router = routerAddr != address(0) ? PoolSwapTest(routerAddr) : new PoolSwapTest(poolManager);
        require(address(router.manager()) == address(poolManager), "router/manager mismatch");

        PerkTypes.CreateLaunchParams memory p = PerkTypes.CreateLaunchParams({
            templateId: templateId,
            quote: Currency.wrap(address(0)),
            moduleParams: "",
            expectedConfigHash: bytes32(0),
            metadata: PerkTypes.TokenMetadata({name: "Perk Smoke", symbol: "SMOKE", uri: "ipfs://smoke"}),
            devBuyQuote: 0.01 ether,
            salt: keccak256(abi.encode("smoke", block.timestamp))
        });
        (address predicted,,, bytes32 configHash) = factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        (address meme, bytes32 launchId) = factory.createLaunch{value: 0.01 ether}(p);
        require(meme == predicted, "prediction mismatch");

        graduation.graduate(meme);

        IPerkGraduationManager.Graduation memory g = graduation.graduationOf(meme);
        PoolKey memory key = g.key;
        // native OKB is currency0 -> buying meme is zeroForOne
        router.swap{value: 0.001 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -0.001 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        vm.stopBroadcast();

        PerkTypes.LaunchRecord memory rec = factory.getLaunch(meme);
        IPerkFeeRouter.LaunchFees memory fees = feeRouter.launchFees(meme);
        (, uint256 claimable) = distributor.claimableQuoteRewards(meme, deployer);
        console2.log("meme", meme);
        console2.log("launchId", vm.toString(launchId));
        console2.log("status (3 = GRADUATED)", uint256(rec.status));
        console2.log("poolId", vm.toString(PoolId.unwrap(rec.poolId)));
        console2.log("hook initialized", hook.poolInfo(rec.poolId).initialized);
        console2.log("stage (4 = DONE)", uint256(g.stage));
        console2.log("liquidity", g.liquidity);
        console2.log("memeToPool", g.memeToPool);
        console2.log("quoteToPool", g.quoteToPool);
        console2.log("memeLeftover burned", g.memeLeftover);
        console2.log("quoteLeftover", g.quoteLeftover);
        console2.log("dev claimable (wei OKB)", fees.devClaimable);
        console2.log("deployer claimable quote rewards (wei OKB)", claimable);
        console2.log("swap router", address(router));
    }
}
