// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {PerkTemplates} from "./lib/PerkTemplates.sol";
import {PerkConstants} from "../src/libraries/PerkConstants.sol";
import {IPerkLaunchFactory} from "../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkBondingCurve} from "../src/interfaces/IPerkBondingCurve.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";
import {IPerkLPGrantVault} from "../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkReferralRegistry} from "../src/interfaces/IPerkReferralRegistry.sol";
import {IPerkTemplateRegistry} from "../src/interfaces/IPerkTemplateRegistry.sol";
import {MockERC20} from "../test/utils/MockERC20.sol";

/// @notice Testnet demo data with one launch per stage. Run with scripts/with-roles.sh.
///   phaseA(): six launches across curve progress / pending / graduated, plus two grant launches graduated; opt-ins.
///   (off-chain) indexer snapshot for the two grant launches, proposeRoot on both
///   phaseB(activeMeme): after the root delay — activateRoot, register alice/bob/carol from LIFECYCLE_PROOFS, activate, swaps
///   cancelStale(meme): cancel a campaign whose root deadline passed (CANCELLED stage)
///   The 18-decimal ERC-20 launch pays in the deployment's `initialQuoteToken`, which must be a test-network mock with
///   public mint and a fast template bound to it (ConfigureQuoteAsset.s.sol).
contract SeedDemo is Script {
    struct R {
        uint256 creator;
        uint256 buyer;
        uint256 alice;
        uint256 bob;
        uint256 carol;
        uint256 swapper;
        uint256 deployer;
    }

    struct A {
        IPerkLaunchFactory factory;
        IPerkBondingCurve curve;
        IPerkGraduationManager graduation;
        IPerkLPGrantVault vault;
        IPerkReferralRegistry referral;
        address erc20Quote;
        address stock;
        address swapRouter;
        bytes32 fast;
    }

    function _load() internal view returns (R memory r, A memory a) {
        require(block.chainid != 196, "testnet only");
        r = R({
            creator: vm.envUint("ROLE_CREATOR_PK"),
            buyer: vm.envUint("ROLE_BUYER_PK"),
            alice: vm.envUint("ROLE_ALICE_PK"),
            bob: vm.envUint("ROLE_BOB_PK"),
            carol: vm.envUint("ROLE_CAROL_PK"),
            swapper: vm.envUint("ROLE_SWAPPER_PK"),
            deployer: vm.envUint("DEPLOYER_PRIVATE_KEY")
        });
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        a.factory = IPerkLaunchFactory(vm.parseJsonAddress(json, ".factory"));
        a.curve = IPerkBondingCurve(vm.parseJsonAddress(json, ".curve"));
        a.graduation = IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        a.vault = IPerkLPGrantVault(payable(vm.parseJsonAddress(json, ".lpGrantVault")));
        a.referral = IPerkReferralRegistry(vm.parseJsonAddress(json, ".referralRegistry"));
        a.erc20Quote = vm.parseJsonAddress(json, ".initialQuoteToken");
        a.stock = vm.parseJsonAddress(json, ".quoteAssets.tAAPL");
        a.swapRouter = vm.envAddress("V4_TESTNET_SWAP_ROUTER");
        a.fast = keccak256(bytes(vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"))));
    }

    // ------------------------------------------------------------------ phase A
    function phaseA() external {
        (R memory r, A memory a) = _load();
        Currency native = Currency.wrap(address(0));
        Currency erc20Quote = Currency.wrap(a.erc20Quote);
        Currency stock = Currency.wrap(a.stock);
        uint256 T = 8_500_000_000_000_000; // 0.0085 in 18-dec quote units (fast template)

        // opt-ins for the grant snapshot on this deployment; bob invited by alice
        _optIn(a, r.alice, address(0));
        _optIn(a, r.bob, vm.addr(r.alice));
        _optIn(a, r.carol, address(0));

        // ERC-20 quote balances for the roles (mocks have public mint)
        vm.startBroadcast(r.deployer);
        MockERC20(a.erc20Quote).mint(vm.addr(r.buyer), 10 ether);
        MockERC20(a.erc20Quote).mint(vm.addr(r.swapper), 10 ether);
        MockERC20(a.erc20Quote).mint(vm.addr(r.creator), 10 ether);
        MockERC20(a.stock).mint(vm.addr(r.buyer), 1000e6);
        MockERC20(a.stock).mint(vm.addr(r.swapper), 1000e6);
        MockERC20(a.stock).mint(vm.addr(r.creator), 1000e6);
        vm.stopBroadcast();

        // 1. fresh, 0%
        address m1 = _create(a, r.creator, a.fast, native, "Moon Otter", "OTTER", 0, 0);
        // 2. curve 25% (OKB): buyer
        address m2 = _create(a, r.creator, a.fast, native, "Ink Fox", "IFOX", 0, 0);
        _buyNative(a, r.buyer, m2, (T * 25) / 100);
        // 3. curve ~65% (18-decimal ERC-20): two buyers
        bytes32 fastErc20 = PerkTemplates.templateIdFor(a.fast, erc20Quote);
        address m3 = _create(a, r.creator, fastErc20, erc20Quote, "Quiet Whale", "QWHALE", 0, 0);
        _buyErc20(a, r.buyer, m3, a.erc20Quote, (T * 40) / 100);
        _buyErc20(a, r.swapper, m3, a.erc20Quote, (T * 25) / 100);
        // 4. curve ~90% with a sell (tAAPL, 6 decimals: T = 8500 units)
        bytes32 fastStock = PerkTemplates.templateIdFor(a.fast, stock);
        address m4 = _create(a, r.creator, fastStock, stock, "Paper Tiger", "PTIGER", 0, 0);
        _buyErc20(a, r.buyer, m4, a.stock, 5000);
        _buyErc20(a, r.swapper, m4, a.stock, 2500);
        _sell(a, r.swapper, m4, IERC20(m4).balanceOf(vm.addr(r.swapper)) / 3);
        // 5. threshold reached, graduation pending (nobody called graduate yet)
        address m5 = _create(a, r.creator, a.fast, native, "Neon Koi", "NKOI", 0, 0);
        _buyNative(a, r.buyer, m5, T + T / 20);
        // 6. Standard template graduated (no grant), with swaps for volume
        bytes32 stdFast = keccak256("STD_FAST_V1");
        address m6 =
            _create(a, r.creator, _standardFast(a, stdFast), native, "Stone Duck", "SDUCK", T + T / 20, T + T / 20);
        _graduate(a, r.deployer, m6);
        _swapNative(a, r.swapper, m6, 0.0004 ether);
        _swapNative(a, r.buyer, m6, 0.0003 ether);
        // 7 & 8. Perk graduated: one stays AWAITING_ROOT, one goes through the root flow (phase B)
        address m7 = _create(a, r.creator, a.fast, native, "Sparkle Cat", "SCAT", T + T / 20, T + T / 20);
        _graduate(a, r.deployer, m7);
        address m8 = _create(a, r.creator, a.fast, native, "Ledger Wolf", "LWOLF", 0, 0);
        _buyNative(a, r.buyer, m8, (T * 60) / 100);
        _buyNative(a, r.swapper, m8, (T * 50) / 100);
        _graduate(a, r.deployer, m8);
        _swapNative(a, r.swapper, m8, 0.0005 ether);

        console2.log("fresh 0%%            ", m1);
        console2.log("curve 25%% OKB       ", m2);
        console2.log("curve ~65%% ERC-20   ", m3);
        console2.log("curve ~90%% tAAPL    ", m4);
        console2.log("graduation pending   ", m5);
        console2.log("standard graduated   ", m6);
        console2.log("perk graduated (root)", m7);
        console2.log("perk graduated (flow)", m8);
    }

    // ------------------------------------------------------------------ phase B
    function phaseB(address meme) external {
        (R memory r, A memory a) = _load();
        string memory proofs = vm.readFile(vm.envString("LIFECYCLE_PROOFS"));
        vm.startBroadcast(r.deployer);
        if (a.vault.campaign(meme).status == IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED) {
            a.vault.activateRoot(meme);
        }
        for (uint256 i; i < 3; ++i) {
            string memory k = string.concat("[", vm.toString(i), "]");
            IPerkLPGrantVault.GrantLeaf memory leaf = IPerkLPGrantVault.GrantLeaf({
                account: vm.parseJsonAddress(proofs, string.concat(k, ".leaf.account")),
                baseAllocation: vm.parseJsonUint(proofs, string.concat(k, ".leaf.baseAllocation")),
                inviteeBoost: vm.parseJsonUint(proofs, string.concat(k, ".leaf.inviteeBoost"))
            });
            bytes32[] memory proof = vm.parseJsonBytes32Array(proofs, string.concat(k, ".proof"));
            if (!a.vault.allocation(meme, leaf.account).registered) a.vault.registerAllocation(meme, leaf, proof);
        }
        vm.stopBroadcast();
        _activate(a, meme, r.bob, true, false);
        _activate(a, meme, r.alice, false, true);
        _activate(a, meme, r.carol, false, false);
        _swapNative(a, r.swapper, meme, 0.001 ether);
        _swapNative(a, r.buyer, meme, 0.0006 ether);
        console2.log("active campaign with 3 positions", meme);
    }

    function cancelStale(address meme) external {
        (R memory r, A memory a) = _load();
        vm.startBroadcast(r.deployer);
        a.vault.cancelCampaign(meme);
        vm.stopBroadcast();
        console2.log("cancelled", meme);
    }

    // ------------------------------------------------------------------ helpers
    function _standardFast(A memory, bytes32 id) internal returns (bytes32) {
        // a Standard-template twin of the fast template, bound to native, registered on demand
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IPerkTemplateRegistry reg = IPerkTemplateRegistry(vm.parseJsonAddress(json, ".templateRegistry"));
        if (reg.isActive(id)) return id;
        PerkTemplates.Numbers memory n =
            PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), Currency.wrap(address(0)), 18);
        n.virtualQuoteReserve = n.virtualQuoteReserve / 10_000;
        n.graduationQuoteThreshold = n.graduationQuoteThreshold / 10_000;
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        reg.registerTemplate(id, PerkTemplates.standardCurveV1(n));
        vm.stopBroadcast();
        return id;
    }

    function _optIn(A memory a, uint256 pk, address inviter) internal {
        vm.startBroadcast(pk);
        if (a.referral.optInBlock(vm.addr(pk)) == 0) a.referral.optIn();
        if (inviter != address(0) && a.referral.inviterOf(vm.addr(pk)) == address(0)) a.referral.bindInviter(inviter);
        vm.stopBroadcast();
    }

    function _create(
        A memory a,
        uint256 pk,
        bytes32 templateId,
        Currency quote,
        string memory name,
        string memory symbol,
        uint256 devBuy,
        uint256 value
    ) internal returns (address meme) {
        PerkTypes.CreateLaunchParams memory p = PerkTypes.CreateLaunchParams({
            templateId: templateId,
            quote: quote,
            moduleParams: "",
            expectedConfigHash: bytes32(0),
            metadata: PerkTypes.TokenMetadata({name: name, symbol: symbol, uri: string.concat("ipfs://demo/", symbol)}),
            devBuyQuote: devBuy,
            salt: keccak256(abi.encode(symbol, block.timestamp))
        });
        vm.startBroadcast(pk);
        if (!quote.isAddressZero() && devBuy > 0) IERC20(Currency.unwrap(quote)).approve(address(a.factory), devBuy);
        (,,, bytes32 h) = a.factory.previewLaunch(p);
        p.expectedConfigHash = h;
        (meme,) = a.factory.createLaunch{value: value}(p);
        vm.stopBroadcast();
    }

    function _buyNative(A memory a, uint256 pk, address meme, uint256 gross) internal {
        vm.startBroadcast(pk);
        a.curve.buy{value: gross}(meme, gross, 0, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _buyErc20(A memory a, uint256 pk, address meme, address token, uint256 gross) internal {
        vm.startBroadcast(pk);
        IERC20(token).approve(address(a.curve), gross);
        a.curve.buy(meme, gross, 0, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _sell(A memory a, uint256 pk, address meme, uint256 amount) internal {
        vm.startBroadcast(pk);
        IERC20(meme).approve(address(a.curve), amount);
        a.curve.sell(meme, amount, 0, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _graduate(A memory a, uint256 pk, address meme) internal {
        vm.startBroadcast(pk);
        a.graduation.graduate(meme);
        vm.stopBroadcast();
    }

    function _swapNative(A memory a, uint256 pk, address meme, uint256 quoteIn) internal {
        PoolKey memory key = a.graduation.graduationOf(meme).key;
        vm.startBroadcast(pk);
        PoolSwapTest(a.swapRouter).swap{value: quoteIn}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(quoteIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopBroadcast();
    }

    function _activate(A memory a, address meme, uint256 pk, bool withBoost, bool withCredit) internal {
        address who = vm.addr(pk);
        (uint256 base,, uint256 credit) = a.vault.grantBreakdown(meme, who);
        uint256 baseAmt = (base * 99) / 100;
        uint256 boostAmt;
        if (withBoost) {
            // the boost is earned by the base this call activates (10% of base activated, up to the leaf's boost)
            IPerkLPGrantVault.Allocation memory al = a.vault.allocation(meme, who);
            uint256 earned = (al.baseActivated + baseAmt) / 10;
            if (earned > al.inviteeBoost) earned = al.inviteeBoost;
            boostAmt = earned - al.boostActivated;
        }
        uint256 creditAmt = withCredit ? credit : 0;
        (uint256 q,) = a.vault.quoteRequired(meme, baseAmt + boostAmt + creditAmt);
        uint256 quoteMax = q + q / 50 + 1;
        vm.startBroadcast(pk);
        a.vault.activateGrant{value: quoteMax}(meme, baseAmt, boostAmt, creditAmt, quoteMax, 0);
        vm.stopBroadcast();
    }
}
