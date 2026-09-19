// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Vm} from "forge-std/Vm.sol";

import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";
import {MerkleTree} from "../utils/MerkleTree.sol";
import {MockERC721} from "../utils/MockERC721.sol";

contract LPGrantVaultEdgeTest is GrantTestBase {
    event GrantRootProposed(
        address indexed meme,
        bytes32 root,
        string uri,
        uint256 totalBase,
        uint256 totalInviteeBoost,
        uint64 activatableAt
    );
    event GrantRootCancelled(address indexed meme, bytes32 root);
    event ReferralCreditCapped(address indexed meme, address indexed inviter, uint256 requested, uint256 granted);
    event Received(Currency indexed quote, address indexed from, uint256 amount, bytes32 indexed ref);
    event IncentiveSwept(address indexed meme, uint256 toTreasury);

    function setUp() public {
        _setUpPerk();
        _bindBobToAlice();
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    function test_initCampaign_reverts_notGraduationManager_and_campaignExists() public {
        address meme = _graduated(t.erc20Quote, keccak256("init"));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);

        vm.expectRevert(IPerkLPGrantVault.NotGraduationManager.selector);
        t.vault.initCampaign(meme, c.key, c.memeIsCurrency0, c.tickLower, c.tickUpper);

        vm.prank(t.graduationManager);
        vm.expectRevert(IPerkLPGrantVault.CampaignExists.selector);
        t.vault.initCampaign(meme, c.key, c.memeIsCurrency0, c.tickLower, c.tickUpper);
    }

    function test_initCampaign_standardTemplate_neverCreatesCampaign() public {
        address meme = _createLaunch(PerkConstants.TEMPLATE_STANDARD_CURVE_V1, t.erc20Quote, keccak256("std"));
        _buyToGraduation(meme, t.erc20Quote);
        t.graduation.graduate(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.NONE));
    }

    function test_proposeRoot_onlyOwner_budget_repropose_cancelRoot() public {
        address meme = _graduated(t.erc20Quote, keccak256("propose"));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);

        vm.expectRevert(IPerkLPGrantVault.RootBudgetExceeded.selector);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", c.basePool + 1, 0);
        vm.expectRevert(IPerkLPGrantVault.RootBudgetExceeded.selector);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", 0, c.referralBudget + 1);

        uint64 firstActivatable = uint64(block.timestamp) + 1 days;
        vm.expectEmit(true, false, false, true, address(t.vault));
        emit GrantRootProposed(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST, firstActivatable);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);

        vm.warp(block.timestamp + 12 hours);
        bytes32 other = keccak256("other-root");
        t.vault.proposeRoot(meme, other, "ipfs://v2", 1, 0);
        c = t.vault.campaign(meme);
        assertEq(c.root, other);
        assertEq(uint256(c.status), uint256(IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED));
        assertEq(c.rootUri, "ipfs://v2");
        uint64 restarted = c.rootProposedAt + 1 days;
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDelayNotElapsed.selector, restarted));
        t.vault.activateRoot(meme);

        vm.expectEmit(true, false, false, true, address(t.vault));
        emit GrantRootCancelled(meme, other);
        t.vault.cancelRoot(meme);
        c = t.vault.campaign(meme);
        assertEq(uint256(c.status), uint256(IPerkLPGrantVault.CampaignStatus.AWAITING_ROOT));
        assertEq(c.root, bytes32(0));
        assertEq(c.rootProposedAt, 0);
        assertEq(c.rootTotalBase, 0);
        assertEq(c.rootTotalInviteeBoost, 0);
        assertEq(bytes(c.rootUri).length, 0);
    }

    function test_activateRoot_beforeDelay_registerDuringProposed_activateDuringProposed() public {
        address meme = _graduated(t.erc20Quote, keccak256("delay"));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        uint64 activatableAt = c.rootProposedAt + 1 days;
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDelayNotElapsed.selector, activatableAt));
        t.vault.activateRoot(meme);

        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        IPerkLPGrantVault.Allocation memory a = t.vault.allocation(meme, alice);
        assertTrue(a.registered);
        assertEq(a.baseAllocation, ALICE_BASE);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.WindowClosed.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, 1 ether, 0);
    }

    function test_cancelCampaign_beforeDeadline_afterBurns_thenProposeReverts() public {
        address meme = _graduated(t.erc20Quote, keccak256("cancel"));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        uint64 deadline = c.graduatedAt + 14 days;
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDeadlineNotReached.selector, deadline));
        t.vault.cancelCampaign(meme);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDeadlineNotReached.selector, deadline));
        t.vault.cancelCampaign(meme);

        vm.warp(deadline + 1);
        uint256 supplyBefore = IERC20(meme).totalSupply();
        uint256 reserve = c.reserve;
        t.vault.cancelCampaign(meme);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), reserve);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.CANCELLED));
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.CANCELLED)
        );
        t.vault.proposeRoot(meme, root, "ipfs://dataset", 1, 0);
    }

    function test_finalizeGrant_and_sweepIncentive_lifecycle() public {
        address meme = _activeDefault(keccak256("finalize"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 bobPos = _activate(meme, bob, BOB_BASE, 0, 0);

        vm.expectRevert(IPerkLPGrantVault.WindowClosed.selector);
        t.vault.finalizeGrant(meme);

        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        vm.warp(c.endTime);
        uint256 vaultBal = IERC20(meme).balanceOf(address(t.vault));
        uint256 burnedAtFinalize = t.vault.finalizeGrant(meme);
        assertEq(burnedAtFinalize, vaultBal);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.EXPIRED));

        vm.expectRevert(
            abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.EXPIRED)
        );
        t.vault.finalizeGrant(meme);

        vm.expectRevert(IPerkLPGrantVault.NothingToSweep.selector);
        t.vault.sweepIncentive(meme);

        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        vm.warp(block.timestamp + 1 hours); // positions close only once the price has held; see PriceUnstable

        vm.prank(alice);
        t.vault.exitGrantPosition(alicePos, 0, 0);
        vm.prank(bob);
        t.vault.exitGrantPosition(bobPos, 0, 0);

        c = t.vault.campaign(meme);
        uint256 leftover = c.incentiveBalance;
        if (leftover > 0) {
            bytes32 launchRef = keccak256(abi.encode(block.chainid, address(t.factory), meme));
            vm.expectEmit(true, true, true, true, address(t.treasury));
            emit Received(t.erc20Quote, address(t.vault), leftover, launchRef);
            vm.expectEmit(true, false, false, true, address(t.vault));
            emit IncentiveSwept(meme, leftover);
            assertEq(t.vault.sweepIncentive(meme), leftover);
            assertEq(t.vault.campaign(meme).incentiveBalance, 0);
        }
        vm.expectRevert(IPerkLPGrantVault.NothingToSweep.selector);
        t.vault.sweepIncentive(meme);
    }

    // -------------------------------------------------------------------------
    // Allocations and decay
    // -------------------------------------------------------------------------

    function test_registerAllocation_reverts_alreadyRegistered_and_invalidProof() public {
        address meme = _activeDefault(keccak256("reg"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        vm.expectRevert(IPerkLPGrantVault.AlreadyRegistered.selector);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        vm.expectRevert(IPerkLPGrantVault.InvalidProof.selector);
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE + 1, 0), MerkleTree.proof(leaves, 2));
    }

    function test_grantBreakdown_boostDecaysWithBase() public {
        address meme = _activeDefault(keccak256("boost-decay"));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        (uint256 b0, uint256 g0,) = t.vault.grantBreakdown(meme, bob);
        assertEq(b0, BOB_BASE);
        assertEq(g0, BOB_BOOST);

        vm.warp(t.vault.campaign(meme).startTime + 7 days);
        (uint256 b1, uint256 g1,) = t.vault.grantBreakdown(meme, bob);
        assertEq(b1, BOB_BASE / 2);
        assertEq(g1, BOB_BOOST / 2);
    }

    function test_decayFactorX18_and_grantBreakdown_zeros() public {
        address meme = _activeDefault(keccak256("decay"));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(t.vault.decayFactorX18(meme), 1e18);
        vm.warp(c.startTime + 7 days);
        assertEq(t.vault.decayFactorX18(meme), 5e17);
        vm.warp(c.endTime);
        assertEq(t.vault.decayFactorX18(meme), 0);
        vm.warp(c.endTime + 1);
        assertEq(t.vault.decayFactorX18(meme), 0);

        (uint256 b, uint256 g, uint256 cr) = t.vault.grantBreakdown(meme, alice);
        assertEq(b, 0);
        assertEq(g, 0);
        assertEq(cr, 0);

        vm.warp(c.startTime);
        (b, g, cr) = t.vault.grantBreakdown(meme, dave);
        assertEq(b, 0);
        assertEq(g, 0);
        assertEq(cr, 0);
    }

    function test_activateGrant_exactClaimable_plusOneWeiReverts() public {
        address meme = _activeDefault(keccak256("exact"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        vm.warp(t.vault.campaign(meme).startTime + 7 days);
        (uint256 claimable,,) = t.vault.grantBreakdown(meme, alice);
        assertEq(claimable, ALICE_BASE / 2);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.ExceedsClaimable.selector);
        t.vault.activateGrant(meme, claimable + 1, 0, 0, 1 ether, 0);

        uint256 pos = _activate(meme, alice, claimable, 0, 0);
        assertEq(t.vault.position(pos).baseMemeActivated, claimable);
    }

    /// forge-config: default.fuzz.runs = 24
    function testFuzz_activateGrant_ceilRoundingNeverExceedsAllocation(uint256 seed) public {
        address meme = _activeDefault(keccak256(abi.encode("ceil", seed)));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);

        uint256 sum;
        uint256 steps = bound(seed, 2, 6);
        for (uint256 i; i < steps; ++i) {
            uint256 tWarp = bound(uint256(keccak256(abi.encode(seed, i, "t"))), c.startTime, c.endTime - 1);
            vm.warp(tWarp);
            (uint256 claimable,,) = t.vault.grantBreakdown(meme, alice);
            if (claimable < 1 ether) break;
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i, "a"))), 1 ether, claimable);
            _activate(meme, alice, amt, 0, 0);
            sum += amt;
        }
        assertLe(sum, ALICE_BASE);
    }

    function test_activateGrant_reverts_belowMin_zero_quoteMax_minLiquidity() public {
        address meme = _activeDefault(keccak256("mins"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.BelowMinimumActivation.selector);
        t.vault.activateGrant(meme, 1 ether - 1, 0, 0, 1 ether, 0);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.ZeroAmount.selector);
        t.vault.activateGrant(meme, 0, 0, 0, 1 ether, 0);

        (uint256 required, uint128 liq) = t.vault.quoteRequired(meme, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.QuoteExceedsMax.selector, required, required - 1));
        t.vault.activateGrant(meme, 1 ether, 0, 0, required - 1, 0);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.InsufficientLiquidity.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, required + required / 100 + 1, liq + 1);
    }

    function test_activateGrant_unregisteredBase_and_creditOnly() public {
        address meme = _activeDefault(keccak256("credit-only"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));

        vm.prank(stranger);
        vm.expectRevert(IPerkLPGrantVault.NotRegistered.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, 1 ether, 0);

        _activate(meme, bob, 600_000 ether, 0, 0);
        uint256 credit = t.vault.allocation(meme, alice).inviterCreditEarned;
        assertEq(credit, 60_000 ether);

        uint256 pos = _activate(meme, alice, 0, 0, credit);
        assertEq(t.vault.position(pos).inviterCreditActivated, credit);
        assertEq(t.vault.position(pos).baseMemeActivated, 0);
        assertEq(t.vault.position(pos).inviteeBoostActivated, 0);
    }

    // -------------------------------------------------------------------------
    // Referral credits
    // -------------------------------------------------------------------------

    function test_inviterCredit_tenPercentOfInviteeBaseOnly() public {
        address meme = _activeDefault(keccak256("credit-base"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));

        _activate(meme, bob, 0, BOB_BOOST, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 0);

        _activate(meme, bob, 600_000 ether, 0, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 60_000 ether);

        uint256 credit = 60_000 ether;
        _activate(meme, alice, 0, 0, credit);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, credit);
    }

    function test_inviterCredit_capEmitsReferralCreditCapped() public {
        uint256 aliceBase = 1000 ether;
        uint256 bobBase = 10_000 ether;
        bytes32[] memory custom = new bytes32[](4);
        custom[0] = MerkleTree.leaf(alice, aliceBase, 0);
        custom[1] = MerkleTree.leaf(bob, bobBase, 0);
        custom[2] = MerkleTree.leaf(carol, 1 ether, 0);
        custom[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        bytes32 r = MerkleTree.root(custom);

        address meme = _graduated(t.erc20Quote, keccak256("cap"));
        _proposeAndActivateRoot(meme, r, aliceBase + bobBase + 1 ether, 0);
        t.vault.registerAllocation(meme, _leafStruct(alice, aliceBase, 0), MerkleTree.proof(custom, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, bobBase, 0), MerkleTree.proof(custom, 1));

        uint256 requested = bobBase / 10;
        uint256 granted = aliceBase / 2;
        vm.expectEmit(true, true, false, true, address(t.vault));
        emit ReferralCreditCapped(meme, alice, requested, granted);
        _activate(meme, bob, bobBase, 0, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, granted);
        assertLe(granted, aliceBase / 2);
    }

    function test_inviterCredit_budgetClip_neverExceedsReferralBudget() public {
        address meme = _graduated(t.erc20Quote, keccak256("budget"));
        uint256 room = 100 ether;
        uint256 totalBoost = t.vault.campaign(meme).referralBudget - room;
        _proposeAndActivateRoot(meme, root, _defaultTotalBase(), totalBoost);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));

        uint256 requested = 600_000 ether / 10;
        vm.expectEmit(true, true, false, true, address(t.vault));
        emit ReferralCreditCapped(meme, alice, requested, room);
        _activate(meme, bob, 600_000 ether, 0, 0);

        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, room);
        assertEq(c.referralBudgetUsed, c.referralBudget);
        assertLe(c.referralBudgetUsed, c.referralBudget);
    }

    function test_inviterCredit_bindAfterGraduation_earnsNothing() public {
        bytes32[] memory custom = new bytes32[](4);
        custom[0] = MerkleTree.leaf(eve, ALICE_BASE, 0);
        custom[1] = MerkleTree.leaf(dave, BOB_BASE, 0);
        custom[2] = MerkleTree.leaf(carol, CAROL_BASE, 0);
        custom[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        bytes32 r = MerkleTree.root(custom);

        address meme = _graduated(t.erc20Quote, keccak256("late-bind"));
        uint64 gradBlock = t.vault.campaign(meme).graduatedAtBlock;
        vm.roll(uint256(gradBlock) + 10);
        vm.prank(dave);
        t.referral.bindInviter(eve);
        assertFalse(t.referral.isBoundBy(dave, eve, gradBlock));

        _proposeAndActivateRoot(meme, r, ALICE_BASE + BOB_BASE + CAROL_BASE, 0);
        t.vault.registerAllocation(meme, _leafStruct(eve, ALICE_BASE, 0), MerkleTree.proof(custom, 0));
        t.vault.registerAllocation(meme, _leafStruct(dave, BOB_BASE, 0), MerkleTree.proof(custom, 1));
        _activate(meme, dave, BOB_BASE, 0, 0);
        assertEq(t.vault.allocation(meme, eve).inviterCreditEarned, 0);
    }

    function test_inviterCredit_unregisteredAtActivation_earnsNothing() public {
        address meme = _activeDefault(keccak256("late-reg"));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        _activate(meme, bob, 600_000 ether, 0, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 0);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 0);
    }

    // -------------------------------------------------------------------------
    // Positions, fees, exits
    // -------------------------------------------------------------------------

    function test_positionNft_ownedByVault_refusesStrangerNft() public {
        address meme = _activeDefault(keccak256("nft"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 tokenId = t.vault.position(pos).tokenId;
        assertEq(IERC721(address(t.positionManager)).ownerOf(tokenId), address(t.vault));

        MockERC721 nft = new MockERC721();
        nft.mint(address(this), 1);
        vm.expectRevert(IPerkLPGrantVault.NotPositionManager.selector);
        nft.safeTransferFrom(address(this), address(t.vault), 1);
    }

    function test_collectGrantFees_anyone_quoteToBeneficiary_revertsAfterExit() public {
        address meme = _activeDefault(keccak256("fees"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 20 ether, 0);
        _sellMeme(key, _quoteIs0(meme), meme, 500_000 ether);

        uint256 aliceBefore = t.quoteToken.balanceOf(alice);
        vm.prank(stranger);
        (uint256 qf,,) = t.vault.collectGrantFees(pos);
        assertGt(qf, 0);
        assertEq(t.quoteToken.balanceOf(alice) - aliceBefore, qf);
        assertEq(t.quoteToken.balanceOf(stranger), 10_000_000 ether);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        vm.expectRevert(IPerkLPGrantVault.AlreadyExited.selector);
        t.vault.collectGrantFees(pos);
    }

    function test_exitGrantPosition_reverts_minLp_notBeneficiary_twice_slippage() public {
        address meme = _activeDefault(keccak256("exit-rev"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        uint64 exitableAt = p.activatedAt + t.vault.campaign(meme).minLpSeconds;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.MinLpNotElapsed.selector, exitableAt));
        t.vault.exitGrantPosition(pos, 0, 0);

        vm.warp(exitableAt);
        vm.prank(bob);
        vm.expectRevert(IPerkLPGrantVault.NotBeneficiary.selector);
        t.vault.exitGrantPosition(pos, 0, 0);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.SlippageExceeded.selector);
        t.vault.exitGrantPosition(pos, type(uint256).max, 0);

        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.AlreadyExited.selector);
        t.vault.exitGrantPosition(pos, 0, 0);
    }

    /// @dev Price up: the deposit is paid entirely in quote, the whole meme side is burned, the rest is protocol upside.
    function test_exitGrantPosition_priceUp_paysDepositInQuote_memeAllBurned() public {
        address meme = _activeDefault(keccak256("price-up"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 deposited = t.vault.position(pos).quoteDeposited;
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        vm.warp(block.timestamp + 1 days + 1);
        uint256 memeBefore = IERC20(meme).balanceOf(alice);
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);
        assertEq(toUser, deposited); // capped at the original deposit
        assertEq(memeToUser, 0); // quote covered it, so no meme principal is paid out
        assertEq(IERC20(meme).balanceOf(alice), memeBefore); // only fees would move meme, and none were earned
        assertGt(excess, 0);
        assertGt(burned, 0);
    }

    /// @dev Price down: quote alone no longer covers the deposit, so the grant meme tops the user back up to it.
    function test_exitGrantPosition_priceDown_grantMemeCoversShortfall() public {
        address meme = _activeDefault(keccak256("price-down"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        uint256 deposited = p.quoteDeposited;
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, 20_000_000 ether);
        _sellMeme(key, _quoteIs0(meme), meme, 20_000_000 ether);
        vm.warp(block.timestamp + 1 days + 1);
        t.vault.collectGrantFees(pos); // settle fees first: the assertions below are about principal only
        uint256 memeBefore = IERC20(meme).balanceOf(alice);
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);
        assertLt(toUser, deposited); // the pool no longer holds the whole deposit in quote
        assertGt(memeToUser, 0); // ... so the grant meme covers the shortfall
        assertEq(IERC20(meme).balanceOf(alice) - memeBefore, memeToUser);
        assertEq(excess, 0); // nothing above the deposit is left over
        assertGt(burned, 0); // the protocol's remaining share is still burned

        // q = sqrt(P_exit / P_entry) = quote side now / quote side at entry, for a full-range position
        uint256 q = (toUser * 1e18) / deposited;
        // the top-up is G(1-q)/q meme, out of G/q withdrawn
        assertApproxEqRel(memeToUser, (p.grantMemeAmount * (1e18 - q)) / q, 1e12);
        // at the exit price the beneficiary holds D(1 - (1-q)^2): most of the deposit, never more than it
        uint256 held = toUser + _memeValueInQuote(meme, memeToUser);
        assertApproxEqRel(held, deposited - (deposited * (1e18 - q) ** 2) / 1e36, 1e12);
        assertLt(held, deposited);
        assertGt(held, (deposited * 95) / 100); // this fall costs an unprotected LP far more: see toUser
    }

    /// @dev A deep collapse: the quote side is nearly gone, the grant meme covers most of the deposit at the
    ///      geometric-mean price, and the beneficiary is still better off than the quote side alone.
    function test_exitGrantPosition_priceCollapse_userKeepsGeometricShare() public {
        address meme = _activeDefault(keccak256("collapse"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        uint256 deposited = p.quoteDeposited;
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        uint256 bal = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, bal);
        _sellMeme(key, _quoteIs0(meme), meme, (bal * 99) / 100);
        vm.warp(block.timestamp + 1 days + 1);
        t.vault.collectGrantFees(pos); // settle fees first: the assertions below are about principal only
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);
        assertEq(excess, 0);
        uint256 q = (toUser * 1e18) / deposited;
        assertLt(q, 0.5e18); // beyond the point where the whole position is worth less than the deposit
        assertApproxEqRel(memeToUser, (p.grantMemeAmount * (1e18 - q)) / q, 1e12);
        assertGt(memeToUser, p.grantMemeAmount); // more meme than the grant put in, because the pool bought meme
        assertGt(burned, 0); // and still never the whole meme side: G/q was withdrawn, G(1-q)/q paid
        uint256 held = toUser + _memeValueInQuote(meme, memeToUser);
        assertApproxEqRel(held, deposited - (deposited * (1e18 - q) ** 2) / 1e36, 1e12);
        assertGt(held, toUser + (toUser * 40) / 100); // the top-up adds (1-q) of the quote side again
    }

    /// @dev Security: the grant meme is paired at the pool price, so activation refuses a price that has only just
    ///      appeared. Crashing the pool to pair the grant with a fraction of the quote, then buying the meme back
    ///      from the new position on the way up, is the attack; it clears for honest users once the price has held.
    function test_activateGrant_reverts_whilePriceIsOffReference_thenClears() public {
        address meme = _activeDefault(keccak256("guard-activate"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);

        (uint256 honestQuote,) = t.vault.quoteRequired(meme, ALICE_BASE);
        _sellMeme(key, _quoteIs0(meme), meme, inventory / 4);
        (uint256 crashedQuote,) = t.vault.quoteRequired(meme, ALICE_BASE);
        assertLt(crashedQuote, (honestQuote * 80) / 100); // what the attacker was after: the same grant for less

        vm.prank(alice);
        vm.expectPartialRevert(IPerkLPGrantVault.PriceUnstable.selector);
        t.vault.activateGrant(meme, ALICE_BASE, 0, 0, honestQuote, 0);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12); // the next block is no better
        vm.prank(alice);
        vm.expectPartialRevert(IPerkLPGrantVault.PriceUnstable.selector);
        t.vault.activateGrant(meme, ALICE_BASE, 0, 0, honestQuote, 0);

        vm.warp(block.timestamp + 1 hours); // a price that has held is a price
        (uint256 claimable,,) = t.vault.grantBreakdown(meme, alice); // decayed a little in the meantime
        _activate(meme, alice, claimable, 0, 0);
    }

    /// @dev Security: the excess quote an exit routes to the incentive pool is whatever the position holds above
    ///      the deposit, so a pump around one's own exit would mint "excess" for a second position to collect.
    function test_exitGrantPosition_reverts_whilePriceIsOffReference_thenClears() public {
        address meme = _activeDefault(keccak256("guard-exit"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        _activate(meme, bob, BOB_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        vm.warp(block.timestamp + 1 days + 1);

        _swap(key, _quoteIs0(meme), 40 ether, 0);
        vm.prank(alice);
        vm.expectPartialRevert(IPerkLPGrantVault.PriceUnstable.selector);
        t.vault.exitGrantPosition(alicePos, 0, 0);
        assertEq(t.vault.campaign(meme).incentiveBalance, 0);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        t.vault.exitGrantPosition(alicePos, 0, 0);
    }

    /// @dev Small moves pass: the guard is a band around the reference, not a freeze on trading.
    function test_activateGrant_allowsOrdinaryTradingInTheSameBlock() public {
        address meme = _activeDefault(keccak256("guard-band"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 0.5 ether, 0);
        _activate(meme, alice, ALICE_BASE, 0, 0);
    }

    /// @dev Whatever the market did between entry and exit, the settlement stays inside its bounds: never more
    ///      quote than was deposited, never more value than was deposited, never less than the position's own quote
    ///      side, meme only when quote fell short, and excess only when it did not.
    function testFuzz_exitGrantPosition_settlementBounds(uint256 seed) public {
        address meme = _activeDefault(keccak256(abi.encode("fuzz-exit", seed)));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 deposited = t.vault.position(pos).quoteDeposited;
        PoolKey memory key = t.graduation.graduationOf(meme).key;

        if (seed % 2 == 0) {
            uint256 inventory = IERC20(meme).balanceOf(buyer);
            vm.prank(buyer);
            IERC20(meme).transfer(swapper, inventory);
            _sellMeme(key, _quoteIs0(meme), meme, bound(seed >> 8, 1 ether, inventory));
        } else {
            _swap(key, _quoteIs0(meme), bound(seed >> 8, 0.001 ether, 200 ether), 0);
        }
        vm.warp(block.timestamp + 2 days);
        t.vault.collectGrantFees(pos);

        uint256 supplyBefore = IERC20(meme).totalSupply();
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 excess, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);

        assertLe(toUser, deposited);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), burned);
        if (toUser < deposited) {
            assertEq(excess, 0);
            assertGt(memeToUser, 0);
            assertGt(burned, 0); // the top-up is always a strict part of the meme withdrawn
            assertLe(toUser + _memeValueInQuote(meme, memeToUser), deposited + 1e6);
        } else {
            assertEq(memeToUser, 0);
        }
    }

    /// @dev The meme leg has its own slippage bound, so a user expecting a top-up is not silently paid in quote only.
    function test_exitGrantPosition_reverts_minMemeOut() public {
        address meme = _activeDefault(keccak256("min-meme"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.SlippageExceeded.selector);
        t.vault.exitGrantPosition(pos, 0, type(uint256).max);
    }

    function test_incentiveAccounting_splitCollectAndCap() public {
        address meme = _activeDefault(keccak256("inc"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 bobPos = _activate(meme, bob, BOB_BASE, 0, 0);
        uint256 carolPos = _activate(meme, carol, CAROL_BASE, 0, 0);
        uint128 l1 = t.vault.position(alicePos).liquidity;
        uint128 l2 = t.vault.position(bobPos).liquidity;

        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(carol);
        (,, uint256 excess,) = t.vault.exitGrantPosition(carolPos, 0, 0);
        assertGt(excess, 0);
        uint256 pool = t.vault.campaign(meme).incentiveBalance;
        uint256 pendingA = t.vault.pendingIncentive(alicePos);
        uint256 pendingB = t.vault.pendingIncentive(bobPos);
        assertApproxEqAbs(pendingA, (pool * l1) / (uint256(l1) + uint256(l2)), 1);
        assertApproxEqAbs(pendingB, (pool * l2) / (uint256(l1) + uint256(l2)), 1);
        assertApproxEqAbs(pendingA + pendingB, pool, 1);

        (,, uint256 paidA) = t.vault.collectGrantFees(alicePos);
        assertEq(t.vault.pendingIncentive(alicePos), 0);
        assertEq(t.vault.pendingIncentive(bobPos), pendingB);
        (,, uint256 paidB) = t.vault.collectGrantFees(bobPos);
        assertEq(t.vault.pendingIncentive(bobPos), 0);
        assertLe(paidA + paidB, pool);
        assertLe(paidA + paidB, t.vault.campaign(meme).incentiveBalance + paidA + paidB);
    }

    function test_activateGrant_native_refundsUnused_and_msgValueMismatch() public {
        address meme = _graduated(t.nativeQuote, keccak256("native"));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        vm.warp(block.timestamp + 1 days);
        t.vault.activateRoot(meme);
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE, 0), MerkleTree.proof(leaves, 2));

        (uint256 q,) = t.vault.quoteRequired(meme, CAROL_BASE);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(carol);
        vm.expectRevert(IPerkLPGrantVault.NativeAmountMismatch.selector);
        t.vault.activateGrant{value: quoteMax - 1}(meme, CAROL_BASE, 0, 0, quoteMax, 0);
        vm.prank(carol);
        vm.expectRevert(IPerkLPGrantVault.NativeAmountMismatch.selector);
        t.vault.activateGrant{value: quoteMax + 1}(meme, CAROL_BASE, 0, 0, quoteMax, 0);

        uint256 balBefore = carol.balance;
        vm.prank(carol);
        uint256 pos = t.vault.activateGrant{value: quoteMax}(meme, CAROL_BASE, 0, 0, quoteMax, 0);
        IPerkLPGrantVault.GrantPosition memory p = t.vault.position(pos);
        assertEq(balBefore - carol.balance, p.quoteDeposited);
        assertLe(p.quoteDeposited, quoteMax);
    }

    function test_gas_hotPaths_erc20() public {
        address meme = _activeDefault(keccak256("gas"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        (uint256 q,) = t.vault.quoteRequired(meme, ALICE_BASE);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(alice);
        uint256 pos = t.vault.activateGrant(meme, ALICE_BASE, 0, 0, quoteMax, 0);
        uint256 gActivate = vm.snapshotGasLastFrame("activateGrant");

        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 20 ether, 0);
        t.vault.collectGrantFees(pos);
        uint256 gCollect = vm.snapshotGasLastFrame("collectGrantFees");

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        uint256 gExit = vm.snapshotGasLastFrame("exitGrantPosition");

        emit log_named_uint("gas_activateGrant", gActivate);
        emit log_named_uint("gas_collectGrantFees", gCollect);
        emit log_named_uint("gas_exitGrantPosition", gExit);
    }
}

/// @dev Separate topology so `excessToIncentiveBps = 5_000` is set at construction (no `vm.store`).
contract LPGrantVaultHalfIncentiveTest is GrantTestBase {
    function setUp() public {
        _setUpPerk(5000);
        _bindBobToAlice();
    }

    function test_exitGrantPosition_excessToIncentiveBps_splitsHalf() public {
        address meme = _activeDefault(keccak256("half"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 bobPos = _activate(meme, bob, BOB_BASE, 0, 0);

        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        vm.warp(block.timestamp + 1 days + 1);

        uint256 treBefore = t.quoteToken.balanceOf(address(t.treasury));
        vm.prank(bob);
        (,, uint256 excess,) = t.vault.exitGrantPosition(bobPos, 0, 0);
        assertGt(excess, 0);
        uint256 toPool = (excess * 5000) / PerkConstants.BPS;
        uint256 toTreasury = excess - toPool;
        assertEq(t.vault.campaign(meme).incentiveBalance, toPool);
        assertEq(t.quoteToken.balanceOf(address(t.treasury)) - treBefore, toTreasury);
    }
}

/// @dev The exit settlement has to be indifferent to price manipulation by itself, not because a guard happens to
///      stand in front of it. This topology switches the vault's price guard off and attacks the settlement directly.
contract LPGrantVaultExitManipulationTest is GrantTestBase {
    function setUp() public {
        _setUpPerk(10_000, type(uint24).max);
        _bindBobToAlice();
    }

    /// @dev Security: an exiting LP must not profit from moving the pool price around their own exit. The attacker
    ///      owns the position and the account that trades: they push the price, exit into it, then trade the price
    ///      back, ending with the meme inventory they started with. Their wealth (quote plus meme at the restored
    ///      price) is compared with exiting honestly from the same state. Swept over both directions and a range of
    ///      sizes, and repeated after the market has genuinely moved either way since the position was opened,
    ///      because each of the two earlier pricing rules was safe in one direction and exploitable in the other.
    function test_exitGrantPosition_priceManipulation_isNotProfitable() public {
        _assertExitManipulationUnprofitable(keccak256("manip-flat"), 0);
    }

    function test_exitGrantPosition_priceManipulation_afterPriceFell_isNotProfitable() public {
        _assertExitManipulationUnprofitable(keccak256("manip-fell"), -1);
    }

    function test_exitGrantPosition_priceManipulation_afterPriceRose_isNotProfitable() public {
        _assertExitManipulationUnprofitable(keccak256("manip-rose"), 1);
    }

    function _assertExitManipulationUnprofitable(bytes32 salt, int8 drift) internal {
        address meme = _activeDefault(salt);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool q0 = _quoteIs0(meme);

        // the attacker's trading account holds a meme inventory bought on the curve
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);

        // a genuine market move since entry, which stays
        if (drift < 0) _sellMeme(key, q0, meme, inventory / 5);
        if (drift > 0) _swap(key, q0, 40 ether, 0);
        vm.warp(block.timestamp + 1 days + 1);
        t.vault.collectGrantFees(pos); // fees are the beneficiary's either way; keep them out of the comparison

        // one price values every outcome: the market's, before anyone touches it. Restoring the inventory leaves
        // the pool a hair off that price (the position's liquidity is gone), which must not leak into the result.
        uint160 truePrice = _sqrtPriceOf(meme);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        uint256 honest = _attackerWealth(meme, truePrice);
        vm.revertToState(snap);

        uint256[6] memory sizeBps = [uint256(100), 500, 1500, 3000, 5000, 8000];
        for (uint256 i; i < sizeBps.length; ++i) {
            for (uint256 up; up < 2; ++up) {
                snap = vm.snapshotState();
                if (up == 1) _pumpExitRestore(meme, key, q0, pos, (60 ether * sizeBps[i]) / 10_000);
                else _dumpExitRestore(meme, key, q0, pos, ((inventory / 2) * sizeBps[i]) / 10_000);
                uint256 attacked = _attackerWealth(meme, truePrice);
                emit log_named_int(
                    string.concat(up == 1 ? "pump" : "dump", " bps ", vm.toString(sizeBps[i]), " profit"),
                    // forge-lint: disable-next-line(unsafe-typecast)
                    int256(attacked) - int256(honest)
                );
                assertLe(attacked, honest, "moving the price around an exit must not pay");
                vm.revertToState(snap);
            }
        }
    }

    function _attackerWealth(address meme, uint160 sqrtP) internal view returns (uint256) {
        uint256 quote = t.quoteToken.balanceOf(alice) + t.quoteToken.balanceOf(swapper);
        uint256 memeHeld = IERC20(meme).balanceOf(alice) + IERC20(meme).balanceOf(swapper);
        return quote + _memeValueInQuoteAt(meme, memeHeld, sqrtP);
    }

    function _dumpExitRestore(address meme, PoolKey memory key, bool q0, uint256 pos, uint256 dump) internal {
        _sellMeme(key, q0, meme, dump);
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        // buy back exactly what was dumped (exact output), so the inventory ends where it began
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: q0,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: int256(dump),
                sqrtPriceLimitX96: q0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _pumpExitRestore(address meme, PoolKey memory key, bool q0, uint256 pos, uint256 quoteIn) internal {
        uint256 memeBefore = IERC20(meme).balanceOf(swapper);
        _swap(key, q0, quoteIn, 0);
        uint256 bought = IERC20(meme).balanceOf(swapper) - memeBefore;
        vm.prank(alice);
        t.vault.exitGrantPosition(pos, 0, 0);
        _sellMeme(key, q0, meme, bought); // sell exactly what was bought
    }
}

contract GrantHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IPerkLPGrantVault public immutable vault;
    IERC20 public immutable memeToken;
    PoolSwapTest public immutable swapRouter;
    address public immutable swapper;
    address public immutable meme;
    address[3] public actors;
    bool public immutable quoteIs0;
    uint64 public immutable minLp;
    PoolKey internal key;

    uint256 public ghostQuoteDeposited;
    uint256 public ghostQuoteToUserOnExit;
    uint256 public ghostFeesPaid;
    uint256 public ghostIncentivesPaid;
    uint256 public ghostExcess;

    constructor(
        IPerkLPGrantVault vault_,
        address meme_,
        address[3] memory actors_,
        PoolSwapTest swapRouter_,
        address swapper_,
        IERC20 memeToken_
    ) {
        vault = vault_;
        meme = meme_;
        actors = actors_;
        swapRouter = swapRouter_;
        swapper = swapper_;
        memeToken = memeToken_;
        IPerkLPGrantVault.Campaign memory c = vault_.campaign(meme_);
        key = c.key;
        quoteIs0 = !c.memeIsCurrency0;
        minLp = c.minLpSeconds;
    }

    function activate(uint256 actorSeed, uint256 baseRaw, uint256 boostRaw, uint256 creditRaw) external {
        address who = actors[actorSeed % 3];
        (uint256 b, uint256 g, uint256 cr) = vault.grantBreakdown(meme, who);
        uint256 baseAmt = b == 0 ? 0 : _clamp(baseRaw, 0, b);
        uint256 boostAmt = g == 0 ? 0 : _clamp(boostRaw, 0, g);
        uint256 creditAmt = cr == 0 ? 0 : _clamp(creditRaw, 0, cr);
        uint256 total = baseAmt + boostAmt + creditAmt;
        if (total < 1 ether) {
            if (b >= 1 ether) {
                baseAmt = 1 ether;
                boostAmt = 0;
                creditAmt = 0;
                total = 1 ether;
            } else {
                return;
            }
        }
        (uint256 q,) = vault.quoteRequired(meme, total);
        uint256 quoteMax = q + q / 100 + 1;
        vm.prank(who);
        try vault.activateGrant(meme, baseAmt, boostAmt, creditAmt, quoteMax, 0) returns (uint256 posId) {
            ghostQuoteDeposited += vault.position(posId).quoteDeposited;
        } catch {}
    }

    function collect(uint256 actorSeed, uint256 posSeed) external {
        uint256[] memory ids = vault.positionsOf(actors[actorSeed % 3]);
        if (ids.length == 0) return;
        uint256 pos = ids[posSeed % ids.length];
        try vault.collectGrantFees(pos) returns (uint256 qf, uint256, uint256 inc) {
            ghostFeesPaid += qf;
            ghostIncentivesPaid += inc;
        } catch {}
    }

    function exitPos(uint256 actorSeed, uint256 posSeed) external {
        address who = actors[actorSeed % 3];
        uint256[] memory ids = vault.positionsOf(who);
        if (ids.length == 0) return;
        uint256 pos = ids[posSeed % ids.length];
        IPerkLPGrantVault.GrantPosition memory p = vault.position(pos);
        if (p.exited) return;
        if (block.timestamp < p.activatedAt + minLp) {
            vm.warp(p.activatedAt + minLp);
        }
        try vault.collectGrantFees(pos) returns (uint256 qf, uint256, uint256 inc) {
            ghostFeesPaid += qf;
            ghostIncentivesPaid += inc;
        } catch {}
        vm.prank(who);
        try vault.exitGrantPosition(pos, 0, 0) returns (uint256 toUser, uint256, uint256 excess, uint256) {
            ghostQuoteToUserOnExit += toUser;
            ghostExcess += excess;
        } catch {}
    }

    function warpTime(uint256 dt) external {
        vm.warp(block.timestamp + _clamp(dt, 1, 1 days));
    }

    function buy(uint256 amount) external {
        uint256 amt = _clamp(amount, 0.01 ether, 5 ether);
        vm.prank(swapper);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: quoteIs0,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: quoteIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        ) {}
            catch {}
    }

    function sell(uint256 amount) external {
        uint256 bal = memeToken.balanceOf(swapper);
        if (bal < 1 ether) return;
        uint256 amt = _clamp(amount, 1 ether, bal);
        vm.startPrank(swapper);
        memeToken.approve(address(swapRouter), type(uint256).max);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !quoteIs0,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: !quoteIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        ) {}
            catch {}
        vm.stopPrank();
    }

    function _clamp(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (lo > hi) return lo;
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }
}

/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 8
/// forge-config: default.invariant.fail_on_revert = false
contract LPGrantVaultInvariantTest is GrantTestBase {
    GrantHandler internal handler;
    address internal meme;

    function setUp() public {
        _setUpPerk();
        _bindBobToAlice();
        meme = _activeDefault(keccak256("invariant"));
        _registerDefault(meme);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, 30_000_000 ether);
        address[3] memory actors = [alice, bob, carol];
        handler = new GrantHandler(t.vault, meme, actors, swapRouter, swapper, IERC20(meme));
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = GrantHandler.activate.selector;
        sels[1] = GrantHandler.collect.selector;
        sels[2] = GrantHandler.exitPos.selector;
        sels[3] = GrantHandler.warpTime.selector;
        sels[4] = GrantHandler.buy.selector;
        sels[5] = GrantHandler.sell.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_memeBalanceAccountsForReserve() public view {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        uint256 sumMeme;
        uint256 n;
        address[3] memory who = [alice, bob, carol];
        for (uint256 a; a < 3; ++a) {
            uint256[] memory ids = t.vault.positionsOf(who[a]);
            for (uint256 i; i < ids.length; ++i) {
                IPerkLPGrantVault.GrantPosition memory p = t.vault.position(ids[i]);
                ++n;
                sumMeme += p.grantMemeAmount;
            }
        }
        uint256 vaultBal = IERC20(meme).balanceOf(address(t.vault));
        uint256 accounted = vaultBal + sumMeme + c.burned;
        if (accounted >= c.reserve) assertLe(accounted - c.reserve, n * 2);
        else assertLe(c.reserve - accounted, n * 2);
    }

    function invariant_quotePaidNeverExceedsDepositsFeesIncentives() public view {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertLe(
            handler.ghostQuoteToUserOnExit(),
            handler.ghostQuoteDeposited() + handler.ghostFeesPaid() + handler.ghostIncentivesPaid()
        );
        assertLe(c.incentiveBalance, handler.ghostExcess());
    }

    function invariant_referralBudgetAndPositionCaps() public view {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertLe(c.referralBudgetUsed, c.referralBudget);
        address[3] memory who = [alice, bob, carol];
        for (uint256 a; a < 3; ++a) {
            uint256[] memory ids = t.vault.positionsOf(who[a]);
            uint256 sum;
            for (uint256 i; i < ids.length; ++i) {
                IPerkLPGrantVault.GrantPosition memory p = t.vault.position(ids[i]);
                sum += p.baseMemeActivated + p.inviteeBoostActivated + p.inviterCreditActivated;
            }
            IPerkLPGrantVault.Allocation memory alloc = t.vault.allocation(meme, who[a]);
            assertLe(sum, alloc.baseAllocation + alloc.inviteeBoost + alloc.inviterCreditEarned);
        }
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
