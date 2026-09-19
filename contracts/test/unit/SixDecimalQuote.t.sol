// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {IPerkTemplateRegistry} from "../../src/interfaces/IPerkTemplateRegistry.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkBondingCurve} from "../../src/interfaces/IPerkBondingCurve.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTemplates} from "../../src/libraries/PerkTemplates.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkDeployer} from "../utils/PerkDeployer.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MockERC20} from "../utils/MockERC20.sol";

/// @dev A tokenized-stock-like quote with 6 decimals through the whole V1 path: quote-bound template, curve,
///      graduation, hook fee, Quote Rewards, grant activation and exit. Curve numbers are rescaled per decimals.
contract SixDecimalQuoteTest is PerkDeployer, Deployers {
    Topology internal t;
    MockERC20 internal stock; // "tAAPL", 6 decimals
    Currency internal quote;
    bytes32 internal perkId;
    bytes32 internal fastId;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal swapper = makeAddr("swapper");
    address internal holder = makeAddr("holder");

    function setUp() public {
        deployFreshManagerAndRouters();
        t = deployPerkV1(address(this), address(manager));
        stock = new MockERC20("Tokenized AAPL", "tAAPL", 6);
        quote = Currency.wrap(address(stock));

        // register the asset, whitelist it for every module, and bind templates to it with rescaled numbers
        t.assetRegistry
            .setAsset(
                quote,
                PerkTypes.AssetInfo({
                    enabled: true, rewardCompatible: true, isNative: false, decimals: 6, symbol: "tAAPL"
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
            t.moduleRegistry.setQuoteCompatibility(mods[i], 1, quote, true);
        }
        PerkTemplates.Numbers memory n = PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), quote, 6);
        perkId = PerkTemplates.templateIdFor(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote);
        t.templateRegistry.registerTemplate(perkId, PerkTemplates.perkGrantV1(n));
        n.minLpSeconds = 10 minutes;
        n.grantWindowSeconds = 2 hours;
        fastId = keccak256("TEST_FAST_V1_TAAPL");
        t.templateRegistry.registerTemplate(fastId, PerkTemplates.perkGrantV1(n));

        address[4] memory who = [creator, buyer, swapper, holder];
        for (uint256 i; i < who.length; ++i) {
            stock.mint(who[i], 1_000_000e6);
            vm.startPrank(who[i]);
            stock.approve(address(t.factory), type(uint256).max);
            stock.approve(address(t.curve), type(uint256).max);
            stock.approve(address(swapRouter), type(uint256).max);
            stock.approve(address(t.vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function test_template_isBoundToQuote() public {
        // the tAAPL template refuses OKB and the OKB-era anyQuote template still accepts anything
        (, uint256 bitmap,) = _preview(perkId, quote);
        assertTrue(bitmap & PerkConstants.MODULE_LP_GRANT_V1 != 0);
        PerkTypes.CreateLaunchParams memory p = _params(perkId, Currency.wrap(address(0)), 0);
        vm.prank(creator);
        vm.expectRevert(IPerkTemplateRegistry.QuoteNotBoundToTemplate.selector);
        t.factory.previewLaunch(p);
    }

    function test_fullFlow_sixDecimals() public {
        // threshold rescaled: 85e18 / 1e12 = 85e6 (85 tAAPL)
        PerkTypes.Template memory tmpl = t.templateRegistry.getTemplate(fastId);
        assertEq(tmpl.curve.graduationQuoteThreshold, 85e6);
        assertFalse(tmpl.anyQuote);

        // create + buy to graduation + graduate
        PerkTypes.CreateLaunchParams memory p = _params(fastId, quote, 0);
        (address predicted,, bytes32 configHash) = _preview(fastId, quote);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (address meme,) = t.factory.createLaunch(p);
        assertEq(meme, predicted);
        vm.prank(buyer);
        (uint256 memeOut,, uint256 refund) = t.curve.buy(meme, 100e6, 0, buyer);
        assertGt(memeOut, 0);
        assertGt(refund, 0); // graduating buy is partially filled
        t.graduation.graduate(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));

        // hook fee on a 6-decimal quote swap; Quote Rewards accrue in tAAPL to the buyer
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        bool quoteIs0 = quote == g.key.currency0;
        uint256 routerBefore = stock.balanceOf(address(t.feeRouter));
        vm.prank(swapper);
        swapRouter.swap(
            g.key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(uint256(5e6)),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        assertEq(
            stock.balanceOf(address(t.feeRouter)) - routerBefore,
            (5e6 * 85) / 10_000 - (5e6 * 85 / 10_000) * 2500 / 8500
        );
        (, uint256 claimable) = t.distributor.claimableQuoteRewards(meme, buyer);
        assertGt(claimable, 0);
        vm.prank(buyer);
        (, uint256 paid) = t.distributor.claimQuoteRewards(meme);
        assertEq(paid, claimable);

        // grant: single-leaf root for the holder, activate with tAAPL, exit under the principal cap
        IPerkLPGrantVault.GrantLeaf memory leaf =
            IPerkLPGrantVault.GrantLeaf({account: holder, baseAllocation: 1_000_000 ether, inviteeBoost: 0});
        bytes32 root = t.vault.leafHash(leaf);
        t.vault.proposeRoot(meme, root, "ipfs://x", leaf.baseAllocation, 0);
        vm.warp(block.timestamp + 1 days);
        t.vault.activateRoot(meme);
        bytes32[] memory proof;
        t.vault.registerAllocation(meme, leaf, proof);
        (uint256 base,,) = t.vault.grantBreakdown(meme, holder);
        (uint256 q,) = t.vault.quoteRequired(meme, base);
        assertGt(q, 0);
        vm.prank(holder);
        uint256 pos = t.vault.activateGrant(meme, base, 0, 0, q + q / 50 + 1, 0);
        IPerkLPGrantVault.GrantPosition memory gp = t.vault.position(pos);
        assertLe(gp.quoteDeposited, q + q / 50 + 1);
        vm.warp(block.timestamp + 10 minutes + 1);
        uint256 balBefore = stock.balanceOf(holder);
        vm.prank(holder);
        (uint256 toUser,,, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);
        assertLe(toUser, gp.quoteDeposited);
        assertGt(burned, 0);
        assertGe(stock.balanceOf(holder) - balBefore, toUser);
    }

    /**
     * The testnet templates divide the quote-denominated curve numbers by TEST_CURVE_SCALE_DIV (10,000) to make
     * launches cheap to graduate. On a six-decimal quote that leaves a virtual quote reserve in the tens of
     * thousands against a meme reserve of ~1e26, and `_sqrtPriceX96` used to form `vMeme * 2^192 / vQuote` — about
     * 1e80 — before taking the root. That overflowed uint256, so graduation reverted with an arithmetic panic and
     * left the launch stuck at FUNDED with its bonding curve already drained. Two tAAPL launches died that way on
     * testnet. The square root itself, ~1e40, was always inside the tick range.
     */
    function test_graduate_sixDecimalQuote_scaledCurve_doesNotOverflow() public {
        PerkTemplates.Numbers memory n = PerkTemplates.forQuote(PerkTemplates.defaultNumbers(), quote, 6);
        n.virtualQuoteReserve = n.virtualQuoteReserve / 10_000;
        n.graduationQuoteThreshold = n.graduationQuoteThreshold / 10_000;
        n.minLpSeconds = 10 minutes;
        n.grantWindowSeconds = 2 hours;
        bytes32 scaledId = keccak256("TEST_FAST_V1_TAAPL_SCALED");
        t.templateRegistry.registerTemplate(scaledId, PerkTemplates.perkGrantV1(n));
        assertEq(n.graduationQuoteThreshold, 8500); // 0.0085 tAAPL, as configured on testnet

        PerkTypes.CreateLaunchParams memory p = _params(scaledId, quote, 0);
        p.salt = keccak256("scaled-six");
        vm.prank(creator);
        (address predicted,,, bytes32 configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (address meme,) = t.factory.createLaunch(p);

        vm.prank(buyer);
        t.curve.buy(meme, 20_000, 0, buyer); // straight past the 8,500 threshold
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));

        IPerkBondingCurve.CurveState memory cs0 = t.curve.curveState(meme);
        emit log_named_uint("vQuote at graduation", cs0.virtualQuote);
        emit log_named_uint("vMeme  at graduation", cs0.virtualMeme);

        t.graduation.graduate(meme);
        // graduate() swallows a failing stage; call the stage directly so the revert is visible
        if (uint256(t.graduation.graduationOf(meme).stage) != uint256(IPerkGraduationManager.Stage.DONE)) {
            vm.prank(address(t.graduation));
            t.graduation.executeStage(meme);
        }

        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        emit log_named_address("quote", Currency.unwrap(quote));
        emit log_named_address("meme ", meme);
        emit log_named_string(
            "quote is currency0",
            Currency.unwrap(quote) == Currency.unwrap(g.key.currency0) ? "YES (overflow path)" : "no"
        );
        IPerkBondingCurve.CurveState memory cs1 = t.curve.curveState(meme);
        emit log_named_uint("vQuote AFTER stageFunded", cs1.virtualQuote);
        emit log_named_uint("vMeme  AFTER stageFunded", cs1.virtualMeme);
        emit log_named_uint("sqrtPriceX96", g.sqrtPriceX96);
        assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.DONE));
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        // a real, in-range price rather than a clamp to the tick bound
        assertGt(g.sqrtPriceX96, TickMath.MIN_SQRT_PRICE + 1);
        assertLt(g.sqrtPriceX96, TickMath.MAX_SQRT_PRICE - 1);
        assertGt(g.liquidity, 0);
        // and the grant campaign exists, which is what the stuck launches never got
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.AWAITING_ROOT));
    }

    function _params(bytes32 templateId, Currency q, uint256 devBuy)
        internal
        pure
        returns (PerkTypes.CreateLaunchParams memory p)
    {
        p.templateId = templateId;
        p.quote = q;
        p.metadata = PerkTypes.TokenMetadata({name: "Stock Frog", symbol: "SFROG", uri: "ipfs://sfrog"});
        p.devBuyQuote = devBuy;
        p.salt = keccak256("six");
    }

    function _preview(bytes32 templateId, Currency q)
        internal
        returns (address predicted, uint256 bitmap, bytes32 configHash)
    {
        vm.prank(creator);
        (predicted,, bitmap, configHash) = t.factory.previewLaunch(_params(templateId, q, 0));
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
