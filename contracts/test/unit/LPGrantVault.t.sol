// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {PerkDeployer} from "../utils/PerkDeployer.sol";

/// @dev End-to-end LP Grant flow on a real PoolManager + PositionManager (ADR-007 / ADR-008).
contract LPGrantVaultTest is PerkDeployer, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint256 internal constant BUY_GROSS = 200 ether;
    uint256 internal constant ALICE_BASE = 2_000_000 ether;
    uint256 internal constant BOB_BASE = 1_000_000 ether;
    uint256 internal constant BOB_BOOST = 100_000 ether;
    uint256 internal constant CAROL_BASE = 500_000 ether;

    Topology internal t;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal swapper = makeAddr("swapper");
    address internal alice = makeAddr("alice"); // inviter
    address internal bob = makeAddr("bob"); // invitee
    address internal carol = makeAddr("carol");

    bytes32[4] internal leaves;
    bytes32 internal root;

    function setUp() public {
        deployFreshManagerAndRouters();
        t = deployPerkV1(address(this), address(manager));
        address[6] memory who = [creator, buyer, swapper, alice, bob, carol];
        for (uint256 i; i < who.length; ++i) {
            vm.deal(who[i], 10_000 ether);
            t.quoteToken.mint(who[i], 10_000_000 ether);
            vm.startPrank(who[i]);
            t.quoteToken.approve(address(t.factory), type(uint256).max);
            t.quoteToken.approve(address(t.curve), type(uint256).max);
            t.quoteToken.approve(address(swapRouter), type(uint256).max);
            t.quoteToken.approve(address(t.vault), type(uint256).max);
            vm.stopPrank();
        }
        // bob is invited by alice before any snapshot cutoff
        vm.prank(bob);
        t.referral.bindInviter(alice);

        leaves[0] = _leaf(alice, ALICE_BASE, 0);
        leaves[1] = _leaf(bob, BOB_BASE, BOB_BOOST);
        leaves[2] = _leaf(carol, CAROL_BASE, 0);
        leaves[3] = _leaf(address(0xdead), 0, 0);
        root = _hashPair(_hashPair(leaves[0], leaves[1]), _hashPair(leaves[2], leaves[3]));
    }

    // -------------------------------------------------------------------------
    // Full flow, ERC-20 quote
    // -------------------------------------------------------------------------

    function test_fullFlow_erc20() public {
        address meme = _graduated(t.erc20Quote, keccak256("erc20"));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(uint256(c.status), uint256(IPerkLPGrantVault.CampaignStatus.AWAITING_ROOT));
        assertEq(c.reserve, 150_000_000 ether);
        assertEq(c.basePool, 120_000_000 ether);
        assertEq(c.referralBudget, 30_000_000 ether);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), c.reserve);

        // root: proposal, delay, activation
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, c.status));
        t.vault.activateRoot(meme);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", ALICE_BASE + BOB_BASE + CAROL_BASE, BOB_BOOST);
        vm.expectRevert(); // delay not elapsed
        t.vault.activateRoot(meme);
        vm.warp(block.timestamp + 1 days);
        t.vault.activateRoot(meme);
        c = t.vault.campaign(meme);
        assertEq(uint256(c.status), uint256(IPerkLPGrantVault.CampaignStatus.ACTIVE));
        assertEq(c.endTime - c.startTime, 14 days);
        assertEq(c.referralBudgetUsed, BOB_BOOST);

        // registration
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), _proof(0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), _proof(1));
        vm.expectRevert(IPerkLPGrantVault.InvalidProof.selector);
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE + 1, 0), _proof(2));
        (uint256 aBase,,) = t.vault.grantBreakdown(meme, alice);
        assertEq(aBase, ALICE_BASE);

        // bob activates 600k base + full boost at t0 -> alice earns 60k credit
        uint256 bobPos = _activate(meme, bob, 600_000 ether, BOB_BOOST, 0);
        IPerkLPGrantVault.GrantPosition memory bp = t.vault.position(bobPos);
        assertEq(bp.beneficiary, bob);
        assertGt(bp.liquidity, 0);
        assertGt(bp.quoteDeposited, 0);
        assertApproxEqRel(bp.grantMemeAmount, 700_000 ether, 1e6); // liquidity rounds down by a few wei
        IPerkLPGrantVault.Allocation memory aa = t.vault.allocation(meme, alice);
        assertEq(aa.inviterCreditEarned, 60_000 ether);
        (,, uint256 aCredit) = t.vault.grantBreakdown(meme, alice);
        assertEq(aCredit, 60_000 ether);
        assertEq(t.vault.campaign(meme).referralBudgetUsed, BOB_BOOST + 60_000 ether);

        // halfway: alice's base decayed to 50%; she activates 1M base + her 60k credit
        vm.warp(t.vault.campaign(meme).startTime + 7 days);
        (aBase,,) = t.vault.grantBreakdown(meme, alice);
        assertEq(aBase, ALICE_BASE / 2);
        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.ExceedsClaimable.selector);
        t.vault.activateGrant(meme, ALICE_BASE / 2 + 1, 0, 0, 1 ether, 0);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE / 2, 0, 60_000 ether);
        assertEq(t.vault.position(alicePos).inviterCreditActivated, 60_000 ether);
        // a credit-only activation does not create further credits (no recursion)
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 60_000 ether);

        // trading: buys push price up (quote in), a sell generates meme-side fees
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        bool quoteIs0 = t.erc20Quote == g.key.currency0;
        _swap(g.key, quoteIs0, 30 ether, 0); // buy
        _swap(g.key, quoteIs0, 30 ether, 0); // buy
        _sellMeme(g.key, quoteIs0, meme, 1_000_000 ether); // sell some meme back

        // fees: both sides paid to the beneficiary, nothing burned (ADR-008 §5)
        uint256 supplyBefore = IERC20(meme).totalSupply();
        uint256 bobQuoteBefore = t.quoteToken.balanceOf(bob);
        uint256 bobMemeBefore = IERC20(meme).balanceOf(bob);
        (uint256 qf, uint256 mf,) = t.vault.collectGrantFees(bobPos);
        assertGt(qf, 0);
        assertGt(mf, 0);
        assertEq(t.quoteToken.balanceOf(bob) - bobQuoteBefore, qf);
        assertEq(IERC20(meme).balanceOf(bob) - bobMemeBefore, mf);
        assertEq(supplyBefore, IERC20(meme).totalSupply());

        // alice activated just now: min LP time not elapsed; bob cannot exit her position
        vm.prank(alice);
        vm.expectPartialRevert(IPerkLPGrantVault.MinLpNotElapsed.selector);
        t.vault.exitGrantPosition(alicePos, 0, 0);
        vm.prank(bob);
        vm.expectRevert(IPerkLPGrantVault.NotBeneficiary.selector);
        t.vault.exitGrantPosition(alicePos, 0, 0);

        // bob exits (his min LP time elapsed long ago): principal capped, excess recycled to alice's active liquidity
        supplyBefore = IERC20(meme).totalSupply();
        bobQuoteBefore = t.quoteToken.balanceOf(bob);
        vm.prank(bob);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = t.vault.exitGrantPosition(bobPos, 0, 0);
        assertLe(toUser, bp.quoteDeposited);
        assertGt(excess, 0); // price went up after two buys
        assertGt(burned, 0);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), burned);
        assertGe(t.quoteToken.balanceOf(bob) - bobQuoteBefore, toUser);
        assertTrue(t.vault.position(bobPos).exited);
        c = t.vault.campaign(meme);
        assertEq(c.incentiveBalance, excess);
        assertApproxEqAbs(t.vault.pendingIncentive(alicePos), c.incentiveBalance, 1); // mulDiv floors

        // window over: finalize burns the unactivated reserve; alice can still collect / exit later
        vm.warp(c.endTime + 1);
        uint256 vaultBal = IERC20(meme).balanceOf(address(t.vault));
        uint256 burnedAtFinalize = t.vault.finalizeGrant(meme);
        assertEq(burnedAtFinalize, vaultBal);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.WindowClosed.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, 1 ether, 0);

        uint256 aliceQuoteBefore = t.quoteToken.balanceOf(alice);
        vm.prank(alice);
        (toUser,, excess,) = t.vault.exitGrantPosition(alicePos, 0, 0);
        // alice received principal (capped) + fees + the recycled incentive
        assertGt(t.quoteToken.balanceOf(alice) - aliceQuoteBefore, toUser);
        assertEq(t.vault.campaign(meme).activeLiquidity, 0);
        // alice was the last position: her own excess goes straight to the treasury; at most rounding dust is left
        uint256 dust = t.vault.campaign(meme).incentiveBalance;
        assertLe(dust, 1);
        if (dust > 0) {
            assertEq(t.vault.sweepIncentive(meme), dust);
        }
        vm.expectRevert(IPerkLPGrantVault.NothingToSweep.selector);
        t.vault.sweepIncentive(meme);
        // the vault never keeps meme
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
    }

    // -------------------------------------------------------------------------
    // Native quote
    // -------------------------------------------------------------------------

    function test_fullFlow_native() public {
        address meme = _graduated(t.nativeQuote, keccak256("native"));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", ALICE_BASE + BOB_BASE + CAROL_BASE, BOB_BOOST);
        vm.warp(block.timestamp + 1 days);
        t.vault.activateRoot(meme);
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE, 0), _proof(2));

        (uint256 q,) = t.vault.quoteRequired(meme, CAROL_BASE);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(carol);
        vm.expectRevert(IPerkLPGrantVault.NativeAmountMismatch.selector);
        t.vault.activateGrant{value: quoteMax - 1}(meme, CAROL_BASE, 0, 0, quoteMax, 0);
        uint256 balBefore = carol.balance;
        vm.prank(carol);
        uint256 pos = t.vault.activateGrant{value: quoteMax}(meme, CAROL_BASE, 0, 0, quoteMax, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        assertEq(balBefore - carol.balance, p.quoteDeposited); // unused quote refunded
        assertLe(p.quoteDeposited, quoteMax);

        vm.warp(block.timestamp + 1 days + 1);
        balBefore = carol.balance;
        vm.prank(carol);
        (uint256 toUser,,,) = t.vault.exitGrantPosition(pos, 0, 0);
        assertEq(carol.balance - balBefore, toUser);
        assertLe(toUser, p.quoteDeposited);
    }

    // -------------------------------------------------------------------------
    // Cancel path
    // -------------------------------------------------------------------------

    function test_cancelCampaign_afterDeadline_burnsReserve() public {
        address meme = _graduated(t.erc20Quote, keccak256("cancel"));
        vm.expectRevert();
        t.vault.cancelCampaign(meme);
        vm.warp(block.timestamp + 14 days + 1);
        uint256 supplyBefore = IERC20(meme).totalSupply();
        t.vault.cancelCampaign(meme);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), 150_000_000 ether);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.CANCELLED));
    }

    function test_standardLaunch_hasNoCampaign() public {
        address meme = _createLaunch(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("std"));
        _buyToGraduation(meme, t.erc20Quote);
        t.graduation.graduate(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.NONE));
    }

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------

    function _graduated(Currency quote, bytes32 salt) internal returns (address meme) {
        meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, salt);
        _buyToGraduation(meme, quote);
        t.graduation.graduate(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
    }

    function _createLaunch(bytes32 templateId, Currency quote, bytes32 salt) internal returns (address meme) {
        PerkTypes.CreateLaunchParams memory p;
        p.templateId = templateId;
        p.quote = quote;
        p.metadata = PerkTypes.TokenMetadata({name: "Frog", symbol: "FROG", uri: "ipfs://frog"});
        p.salt = salt;
        vm.prank(creator);
        (,,, bytes32 configHash) = t.factory.previewLaunch(p);
        p.expectedConfigHash = configHash;
        vm.prank(creator);
        (meme,) = t.factory.createLaunch(p);
    }

    function _buyToGraduation(address meme, Currency quote) internal {
        vm.prank(buyer);
        if (quote.isAddressZero()) t.curve.buy{value: BUY_GROSS}(meme, BUY_GROSS, 0, buyer);
        else t.curve.buy(meme, BUY_GROSS, 0, buyer);
    }

    function _activate(address meme, address who, uint256 base, uint256 boost, uint256 credit)
        internal
        returns (uint256 positionId)
    {
        (uint256 q,) = t.vault.quoteRequired(meme, base + boost + credit);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(who);
        positionId = t.vault.activateGrant(meme, base, boost, credit, quoteMax, 0);
    }

    function _swap(PoolKey memory key, bool quoteIs0, uint256 amount, uint256 value) internal {
        vm.prank(swapper);
        swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _sellMeme(PoolKey memory key, bool quoteIs0, address meme, uint256 amount) internal {
        vm.startPrank(swapper);
        IERC20(meme).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !quoteIs0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: !quoteIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
        vm.stopPrank();
    }

    function _leafStruct(address a, uint256 b, uint256 boost)
        internal
        pure
        returns (IPerkLPGrantVault.GrantLeaf memory)
    {
        return IPerkLPGrantVault.GrantLeaf({account: a, baseAllocation: b, inviteeBoost: boost});
    }

    function _leaf(address a, uint256 b, uint256 boost) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, b, boost))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory proof) {
        proof = new bytes32[](2);
        proof[0] = leaves[i ^ 1];
        proof[1] = i < 2 ? _hashPair(leaves[2], leaves[3]) : _hashPair(leaves[0], leaves[1]);
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
