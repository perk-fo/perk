// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {PerkTypes} from "../src/libraries/PerkTypes.sol";
import {IPerkLaunchFactory} from "../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkBondingCurve} from "../src/interfaces/IPerkBondingCurve.sol";
import {IPerkGraduationManager} from "../src/interfaces/IPerkGraduationManager.sol";
import {IPerkLPGrantVault} from "../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkReferralRegistry} from "../src/interfaces/IPerkReferralRegistry.sol";
import {IPerkHolderRewardDistributor} from "../src/interfaces/IPerkHolderRewardDistributor.sol";
import {IPerkFeeRouter} from "../src/interfaces/IPerkFeeRouter.sol";

/// @notice Multi-role LP Grant lifecycle on a TEST network, driven by `scripts/with-roles.sh` (ROLE_*_PK env) and the
///         env-configured fast template. Phases are separate entry points because real time has to pass between them:
///           phase1()        creator launches; alice/bob/carol opt in, bob binds alice; buyer graduates the curve; anyone graduates
///           (off-chain)     indexer snapshot -> deployer proposeRoot -> wait GRANT_ROOT_DELAY_SECONDS
///           phase2(meme)    activateRoot; register alice/bob/carol from LIFECYCLE_PROOFS json; bob, alice, carol activate; swapper trades
///           phase3(meme)    after TEST_MIN_LP_SECONDS: bob exits (principal cap, excess -> incentive pool); alice/carol collect
///           phase4(meme)    after the window: finalizeGrant; alice & carol exit; sweepIncentive
contract LifecycleTestnet is Script {
    struct Roles {
        uint256 creatorPk;
        uint256 buyerPk;
        uint256 alicePk;
        uint256 bobPk;
        uint256 carolPk;
        uint256 swapperPk;
        uint256 deployerPk;
    }

    struct Addrs {
        IPerkLaunchFactory factory;
        IPerkBondingCurve curve;
        IPerkGraduationManager graduation;
        IPerkLPGrantVault vault;
        IPerkReferralRegistry referral;
        IPerkHolderRewardDistributor distributor;
        IPerkFeeRouter feeRouter;
        address poolManager;
        address swapRouter;
    }

    function _load() internal view returns (Roles memory r, Addrs memory a) {
        require(block.chainid != 196, "testnet only");
        r.creatorPk = vm.envUint("ROLE_CREATOR_PK");
        r.buyerPk = vm.envUint("ROLE_BUYER_PK");
        r.alicePk = vm.envUint("ROLE_ALICE_PK");
        r.bobPk = vm.envUint("ROLE_BOB_PK");
        r.carolPk = vm.envUint("ROLE_CAROL_PK");
        r.swapperPk = vm.envUint("ROLE_SWAPPER_PK");
        r.deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        a.factory = IPerkLaunchFactory(vm.parseJsonAddress(json, ".factory"));
        a.curve = IPerkBondingCurve(vm.parseJsonAddress(json, ".curve"));
        a.graduation = IPerkGraduationManager(vm.parseJsonAddress(json, ".graduationManager"));
        a.vault = IPerkLPGrantVault(payable(vm.parseJsonAddress(json, ".lpGrantVault")));
        a.referral = IPerkReferralRegistry(vm.parseJsonAddress(json, ".referralRegistry"));
        a.distributor = IPerkHolderRewardDistributor(vm.parseJsonAddress(json, ".distributor"));
        a.feeRouter = IPerkFeeRouter(vm.parseJsonAddress(json, ".feeRouter"));
        a.poolManager = vm.parseJsonAddress(json, ".poolManager");
        a.swapRouter = vm.envAddress("V4_TESTNET_SWAP_ROUTER");
    }

    // ------------------------------------------------------------------ phase 1
    function phase1() external {
        (Roles memory r, Addrs memory a) = _load();
        bytes32 templateId = keccak256(bytes(vm.envOr("TEST_TEMPLATE", string("TEST_FAST_V1"))));

        // referrals and opt-ins must land before the graduation block
        vm.startBroadcast(r.alicePk);
        a.referral.optIn();
        vm.stopBroadcast();
        vm.startBroadcast(r.bobPk);
        a.referral.optIn();
        if (a.referral.inviterOf(vm.addr(r.bobPk)) == address(0)) a.referral.bindInviter(vm.addr(r.alicePk));
        vm.stopBroadcast();
        vm.startBroadcast(r.carolPk);
        a.referral.optIn();
        vm.stopBroadcast();

        // creator launches with the fast template, no dev buy
        PerkTypes.CreateLaunchParams memory p = PerkTypes.CreateLaunchParams({
            templateId: templateId,
            quote: Currency.wrap(address(0)),
            moduleParams: "",
            expectedConfigHash: bytes32(0),
            metadata: PerkTypes.TokenMetadata({name: "Lifecycle", symbol: "LIFE", uri: "ipfs://lifecycle"}),
            devBuyQuote: 0,
            salt: keccak256(abi.encode("lifecycle", block.timestamp))
        });
        vm.startBroadcast(r.creatorPk);
        (,,, bytes32 configHash) = a.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        (address meme,) = a.factory.createLaunch(p);
        vm.stopBroadcast();

        // buyer takes the curve to graduation in one gross buy (threshold + fee headroom); the excess is refunded
        uint256 threshold = a.curve.curveConfig(meme).graduationQuoteThreshold;
        uint256 gross = threshold + threshold / 50 + 1e15;
        vm.startBroadcast(r.buyerPk);
        a.curve.buy{value: gross}(meme, gross, 0, vm.addr(r.buyerPk));
        vm.stopBroadcast();

        vm.startBroadcast(r.deployerPk);
        a.graduation.graduate(meme);
        vm.stopBroadcast();

        console2.log("MEME", meme);
        console2.log("status (3 = GRADUATED)", uint256(a.factory.getLaunch(meme).status));
        console2.log("campaign status (1 = AWAITING_ROOT)", uint256(a.vault.campaign(meme).status));
        console2.log("bob inviter", a.referral.inviterOf(vm.addr(r.bobPk)));
    }

    // ------------------------------------------------------------------ phase 2
    /// @dev LIFECYCLE_PROOFS = path to a JSON array of {account, baseAllocation, inviteeBoost, proof[]} (indexer proof.ts output per role).
    function phase2(address meme) external {
        (Roles memory r, Addrs memory a) = _load();
        string memory proofs = vm.readFile(vm.envString("LIFECYCLE_PROOFS"));

        vm.startBroadcast(r.deployerPk);
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

        // bob first: his base activation earns alice a credit
        _activate(a, meme, r.bobPk, true, false);
        _activate(a, meme, r.alicePk, false, true);
        _activate(a, meme, r.carolPk, false, false);

        // swapper: two buys push the price up so bob's exit shows the principal cap and the excess routing
        vm.startBroadcast(r.swapperPk);
        _buy(a, meme, 0.002 ether);
        _buy(a, meme, 0.002 ether);
        vm.stopBroadcast();

        IPerkLPGrantVault.Allocation memory al = a.vault.allocation(meme, vm.addr(r.alicePk));
        console2.log("alice inviter credit earned", al.inviterCreditEarned);
        console2.log("alice inviter credit activated", al.inviterCreditActivated);
        console2.log("campaign totalActivated", a.vault.campaign(meme).totalActivated);
        console2.log("campaign activeLiquidity", a.vault.campaign(meme).activeLiquidity);
    }

    // ------------------------------------------------------------------ phase 3
    function phase3(address meme) external {
        (Roles memory r, Addrs memory a) = _load();
        uint256 bobPos = _livePosition(a, meme, vm.addr(r.bobPk));
        IPerkLPGrantVault.GrantPosition memory bp = a.vault.position(bobPos);
        uint256 balBefore = vm.addr(r.bobPk).balance;

        vm.startBroadcast(r.bobPk);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = a.vault.exitGrantPosition(bobPos, 0, 0);
        vm.stopBroadcast();
        console2.log("bob quoteDeposited", bp.quoteDeposited);
        console2.log("bob quoteToUser (capped at deposit)", toUser);
        console2.log("bob excess -> incentive pool", excess);
        console2.log("bob meme burned", burned);
        console2.log("bob balance delta (incl. gas)", int256(vm.addr(r.bobPk).balance) - int256(balBefore));

        uint256 alicePos = _livePosition(a, meme, vm.addr(r.alicePk));
        uint256 carolPos = _livePosition(a, meme, vm.addr(r.carolPk));
        console2.log("alice pending incentive", a.vault.pendingIncentive(alicePos));
        console2.log("carol pending incentive", a.vault.pendingIncentive(carolPos));
        vm.startBroadcast(r.alicePk);
        (uint256 qf, uint256 mf, uint256 inc) = a.vault.collectGrantFees(alicePos);
        vm.stopBroadcast();
        console2.log("alice collected quote fees / meme burned / incentive", qf, mf, inc);
        console2.log("campaign incentiveBalance", a.vault.campaign(meme).incentiveBalance);
    }

    // ------------------------------------------------------------------ phase 4
    function phase4(address meme) external {
        (Roles memory r, Addrs memory a) = _load();
        vm.startBroadcast(r.deployerPk);
        uint256 burnedAtFinalize = a.vault.finalizeGrant(meme);
        vm.stopBroadcast();
        console2.log("unactivated meme burned at finalize", burnedAtFinalize);

        uint256 alicePos = _livePosition(a, meme, vm.addr(r.alicePk));
        vm.startBroadcast(r.alicePk);
        (uint256 aUser,, uint256 aExcess,) = a.vault.exitGrantPosition(alicePos, 0, 0);
        vm.stopBroadcast();
        console2.log("alice quoteToUser / excess", aUser, aExcess);

        uint256 carolPos = _livePosition(a, meme, vm.addr(r.carolPk));
        vm.startBroadcast(r.carolPk);
        (uint256 cUser,, uint256 cExcess,) = a.vault.exitGrantPosition(carolPos, 0, 0);
        vm.stopBroadcast();
        console2.log("carol quoteToUser / excess", cUser, cExcess);

        IPerkLPGrantVault.Campaign memory c = a.vault.campaign(meme);
        console2.log("incentiveBalance left", c.incentiveBalance);
        if (c.incentiveBalance > 0) {
            vm.startBroadcast(r.deployerPk);
            console2.log("swept to treasury", a.vault.sweepIncentive(meme));
            vm.stopBroadcast();
        }
        console2.log("vault meme balance (must be 0)", IERC20(meme).balanceOf(address(a.vault)));
        console2.log("campaign status (4 = EXPIRED)", uint256(a.vault.campaign(meme).status));
    }

    // ------------------------------------------------------------------ helpers
    function _activate(Addrs memory a, address meme, uint256 pk, bool withBoost, bool withCredit) internal {
        address who = vm.addr(pk);
        (uint256 base, uint256 boost, uint256 credit) = a.vault.grantBreakdown(meme, who);
        uint256 baseAmt = (base * 99) / 100;
        uint256 boostAmt = withBoost ? (boost * 99) / 100 : 0;
        uint256 creditAmt = withCredit ? credit : 0;
        (uint256 q,) = a.vault.quoteRequired(meme, baseAmt + boostAmt + creditAmt);
        uint256 quoteMax = q + q / 50 + 1;
        vm.startBroadcast(pk);
        uint256 id = a.vault.activateGrant{value: quoteMax}(meme, baseAmt, boostAmt, creditAmt, quoteMax, 0);
        vm.stopBroadcast();
        IPerkLPGrantVault.GrantPosition memory p = a.vault.position(id);
        console2.log("activated position", id);
        console2.log("  base / boost / credit", baseAmt, boostAmt, creditAmt);
        console2.log("  quote deposited", p.quoteDeposited);
    }

    function _buy(Addrs memory a, address meme, uint256 quoteIn) internal {
        PoolKey memory key = a.graduation.graduationOf(meme).key;
        PoolSwapTest(a.swapRouter).swap{value: quoteIn}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(quoteIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _livePosition(Addrs memory a, address meme, address who) internal view returns (uint256) {
        uint256[] memory ids = a.vault.positionsOf(who);
        for (uint256 i; i < ids.length; ++i) {
            IPerkLPGrantVault.GrantPosition memory p = a.vault.position(ids[i]);
            if (p.meme == meme && !p.exited) return ids[i];
        }
        revert("no live position");
    }
}
