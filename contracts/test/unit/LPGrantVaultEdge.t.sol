// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
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
        vm.expectRevert(IPerkLPGrantVault.NotPublisher.selector);
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

    /// @dev A root under review is not yet the root: nothing can be registered or activated against it.
    function test_activateRoot_beforeDelay_reverts_andNothingRegistersUnderAProposedRoot() public {
        address meme = _graduated(t.erc20Quote, keccak256("delay"));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        uint64 activatableAt = c.rootProposedAt + 1 days;
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDelayNotElapsed.selector, activatableAt));
        t.vault.activateRoot(meme);

        vm.expectRevert(
            abi.encodeWithSelector(
                IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED
            )
        );
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        assertFalse(t.vault.allocation(meme, alice).registered);

        vm.prank(alice);
        vm.expectRevert(IPerkLPGrantVault.WindowClosed.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, 1 ether, 0);

        vm.warp(activatableAt);
        t.vault.activateRoot(meme);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        assertEq(t.vault.allocation(meme, alice).baseAllocation, ALICE_BASE);
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

    /// @dev finalizeGrant burns exactly what never became liquidity, reserve - totalActivated; positions opened before
    ///      it still exit afterwards, and each exit's protocol quote reaches the treasury.
    function test_finalizeGrant_burnsReserveMinusActivated_andPositionsStillExit() public {
        address meme = _activeDefault(keccak256("finalize"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint256 bobPos = _activate(meme, bob, BOB_BASE, 0, 0);

        vm.expectRevert(IPerkLPGrantVault.WindowClosed.selector);
        t.vault.finalizeGrant(meme);

        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        vm.warp(c.endTime);
        uint256 supplyBefore = IERC20(meme).totalSupply();
        uint256 burnedAtFinalize = t.vault.finalizeGrant(meme);
        assertEq(burnedAtFinalize, c.reserve - c.totalActivated);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), burnedAtFinalize);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.EXPIRED));
        assertEq(t.vault.campaign(meme).burned, burnedAtFinalize);
        assertEq(t.vault.inventoryRemaining(meme), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.EXPIRED)
        );
        t.vault.finalizeGrant(meme);

        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        _swap(key, _quoteIs0(meme), 30 ether, 0);
        vm.warp(block.timestamp + 1 hours); // the reference catches up with the pool

        vm.prank(alice);
        t.vault.exitGrantPosition(alicePos, 0, 0);
        (,, uint256 toTreasury,) = t.vault.exitPreview(bobPos);
        uint256 treasuryBefore = t.quoteToken.balanceOf(address(t.treasury));
        if (toTreasury > 0) {
            bytes32 launchRef = keccak256(abi.encode(block.chainid, address(t.factory), meme));
            vm.expectEmit(true, true, true, true, address(t.treasury));
            emit Received(t.erc20Quote, address(t.vault), toTreasury, launchRef);
        }
        vm.prank(bob);
        (,, uint256 paid,) = t.vault.exitGrantPosition(bobPos, 0, 0);
        assertEq(paid, toTreasury);
        assertEq(t.quoteToken.balanceOf(address(t.treasury)) - treasuryBefore, toTreasury);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        assertEq(t.quoteToken.balanceOf(address(t.vault)), 0);
    }

    // -------------------------------------------------------------------------
    // Root deadline order
    // -------------------------------------------------------------------------

    /// @dev After the deadline no root can be proposed. A root cancelled after it leaves the campaign with no root
    ///      pending, and anyone can then cancel the campaign.
    function test_proposeRoot_reverts_afterTheRootDeadline_andCancellingThePendingRootOpensTheBurn() public {
        address meme = _graduated(t.erc20Quote, keccak256("deadline-propose"));
        uint64 deadline = t.vault.campaign(meme).graduatedAt + 14 days;
        vm.warp(deadline); // the deadline itself is still in time
        t.vault.proposeRoot(meme, root, "ipfs://wrong", _defaultTotalBase(), BOB_BOOST);

        vm.warp(deadline + 1);
        t.vault.cancelRoot(meme); // the owner catches a wrong root late
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDeadlinePassed.selector, deadline));
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);

        vm.prank(stranger);
        t.vault.cancelCampaign(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.CANCELLED));
    }

    /// @dev Security: around the deadline nobody races. A root proposed in time blocks the burn and stays
    ///      activatable after its delay, even though that falls after the deadline.
    function test_rootDeadline_aRootProposedInTime_blocksTheBurn_andStillActivates() public {
        address meme = _graduated(t.erc20Quote, keccak256("deadline-race"));
        uint64 deadline = t.vault.campaign(meme).graduatedAt + 14 days;
        vm.warp(deadline - 1 hours);
        t.vault.proposeRoot(meme, root, "ipfs://dataset", _defaultTotalBase(), BOB_BOOST);
        uint64 activatableAt = t.vault.campaign(meme).rootProposedAt + 1 days;

        vm.warp(deadline + 1);
        bytes memory pending = abi.encodeWithSelector(
            IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED
        );
        vm.prank(stranger);
        vm.expectRevert(pending);
        t.vault.cancelCampaign(meme);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDelayNotElapsed.selector, activatableAt));
        t.vault.activateRoot(meme);

        vm.warp(activatableAt);
        vm.prank(stranger);
        vm.expectRevert(pending);
        t.vault.cancelCampaign(meme); // same block as the activation: the order does not matter
        vm.prank(stranger);
        t.vault.activateRoot(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.ACTIVE));
        vm.expectRevert(
            abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.ACTIVE)
        );
        t.vault.cancelCampaign(meme);
    }

    /// @dev Security: a publisher key that keeps replacing its root restarts each review, but never the deadline.
    ///      Re-proposal stops at the deadline, so the last root proposed is activatable at most one delay after it.
    function test_rootDeadline_reproposingCannotRunItOut() public {
        address publisherKey = makeAddr("publisher");
        t.vault.setPublisher(publisherKey);
        address meme = _graduated(t.erc20Quote, keccak256("deadline-stall"));
        uint64 graduatedAt = t.vault.campaign(meme).graduatedAt;
        uint64 deadline = graduatedAt + 14 days;

        for (uint256 i; i < 28; ++i) {
            vm.warp(graduatedAt + i * 12 hours);
            vm.prank(publisherKey);
            t.vault.proposeRoot(meme, keccak256(abi.encode("stall", i)), "ipfs://again", 1, 0);
        }
        uint64 lastProposedAt = t.vault.campaign(meme).rootProposedAt;
        assertLe(lastProposedAt, deadline);

        vm.warp(deadline + 1);
        vm.prank(publisherKey);
        vm.expectRevert(abi.encodeWithSelector(IPerkLPGrantVault.RootDeadlinePassed.selector, deadline));
        t.vault.proposeRoot(meme, root, "ipfs://again", _defaultTotalBase(), BOB_BOOST);

        vm.warp(lastProposedAt + 1 days);
        assertLe(lastProposedAt + 1 days, deadline + 1 days);
        vm.prank(stranger);
        t.vault.activateRoot(meme);
        assertEq(uint256(t.vault.campaign(meme).status), uint256(IPerkLPGrantVault.CampaignStatus.ACTIVE));
    }

    // -------------------------------------------------------------------------
    // Registration is tied to the active root
    // -------------------------------------------------------------------------

    /// @dev Security: a wrong root (a publisher bug or a compromised publisher key) gives eve the whole base pool.
    ///      Registering her leaf while the root is under review used to survive the owner's cancellation, and she then
    ///      activated the entire base pool under the corrected root she is not part of. Nothing registers under a
    ///      proposed root now, so the cancelled root leaves nothing behind.
    function test_registerAllocation_underACancelledRoot_leavesNothingBehind() public {
        _assertWrongRootLeavesNothing(keccak256("stale-cancel"), true);
    }

    /// @dev The same when the wrong root is replaced by re-proposal instead of cancelled.
    function test_registerAllocation_underAReplacedRoot_leavesNothingBehind() public {
        _assertWrongRootLeavesNothing(keccak256("stale-replace"), false);
    }

    function _assertWrongRootLeavesNothing(bytes32 salt, bool cancelFirst) internal {
        address meme = _graduated(t.erc20Quote, salt);
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);

        bytes32[] memory bad = new bytes32[](2);
        bad[0] = MerkleTree.leaf(eve, c.basePool, 0);
        bad[1] = MerkleTree.leaf(address(0xdead), 0, 0);
        t.vault.proposeRoot(meme, MerkleTree.root(bad), "ipfs://bad", c.basePool, 0);
        vm.prank(stranger); // the same block as the proposal
        vm.expectRevert(
            abi.encodeWithSelector(
                IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.ROOT_PROPOSED
            )
        );
        t.vault.registerAllocation(meme, _leafStruct(eve, c.basePool, 0), MerkleTree.proof(bad, 0));

        if (cancelFirst) t.vault.cancelRoot(meme);
        bytes32[] memory good = new bytes32[](4);
        good[0] = MerkleTree.leaf(alice, 100_000_000 ether, 0);
        good[1] = MerkleTree.leaf(bob, 10_000_000 ether, 0);
        good[2] = MerkleTree.leaf(carol, 5_000_000 ether, 0);
        good[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        _proposeAndActivateRoot(meme, MerkleTree.root(good), 115_000_000 ether, 0);

        assertFalse(t.vault.allocation(meme, eve).registered);
        vm.expectRevert(IPerkLPGrantVault.InvalidProof.selector);
        t.vault.registerAllocation(meme, _leafStruct(eve, c.basePool, 0), MerkleTree.proof(bad, 0));
        vm.prank(eve);
        vm.expectRevert(IPerkLPGrantVault.NotRegistered.selector);
        t.vault.activateGrant(meme, 1 ether, 0, 0, 1 ether, 0);

        // the legitimate top allocation is served in full
        t.vault.registerAllocation(meme, _leafStruct(alice, 100_000_000 ether, 0), MerkleTree.proof(good, 0));
        uint256 pos = _activate(meme, alice, 100_000_000 ether, 0, 0);
        assertApproxEqRel(t.vault.position(pos).grantMemeAmount, 100_000_000 ether, 1e6);
    }

    /// @dev A tree whose leaves add up to more than the totals it declared cannot hand out more than it declared.
    function test_registerAllocation_reverts_whenLeavesExceedTheDeclaredBaseTotal() public {
        address meme = _graduated(t.erc20Quote, keccak256("over-base"));
        _proposeAndActivateRoot(meme, root, ALICE_BASE + CAROL_BASE, BOB_BOOST); // the leaves hold 3.5M base
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        vm.expectRevert(IPerkLPGrantVault.RootBudgetExceeded.selector);
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        t.vault.registerAllocation(meme, _leafStruct(carol, CAROL_BASE, 0), MerkleTree.proof(leaves, 2));
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(c.registeredBase, ALICE_BASE + CAROL_BASE);
        assertEq(c.registeredBase, c.rootTotalBase);
        assertFalse(t.vault.allocation(meme, bob).registered);
    }

    function test_registerAllocation_reverts_whenLeavesExceedTheDeclaredBoostTotal() public {
        bytes32[] memory custom = new bytes32[](4);
        custom[0] = MerkleTree.leaf(alice, 1000 ether, 0);
        custom[1] = MerkleTree.leaf(bob, 0, 60_000 ether);
        custom[2] = MerkleTree.leaf(carol, 0, 50_000 ether);
        custom[3] = MerkleTree.leaf(address(0xdead), 0, 0);
        address meme = _graduated(t.erc20Quote, keccak256("over-boost"));
        _proposeAndActivateRoot(meme, MerkleTree.root(custom), 1000 ether, 100_000 ether);
        t.vault.registerAllocation(meme, _leafStruct(bob, 0, 60_000 ether), MerkleTree.proof(custom, 1));
        vm.expectRevert(IPerkLPGrantVault.RootBudgetExceeded.selector);
        t.vault.registerAllocation(meme, _leafStruct(carol, 0, 50_000 ether), MerkleTree.proof(custom, 2));
        assertEq(t.vault.campaign(meme).registeredInviteeBoost, 60_000 ether);
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

    /// @dev The invitee boost is earned only as base is activated (10% of it, up to the leaf's boost) and does not
    ///      decay once earned.
    function test_grantBreakdown_boostEarnedByBaseActivation_doesNotDecay() public {
        address meme = _activeDefault(keccak256("boost-earned"));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        (uint256 b0, uint256 g0,) = t.vault.grantBreakdown(meme, bob);
        assertEq(b0, BOB_BASE);
        assertEq(g0, 0);

        _activate(meme, bob, 200_000 ether, 0, 0);
        (, uint256 g1,) = t.vault.grantBreakdown(meme, bob);
        assertEq(g1, 20_000 ether);

        vm.warp(t.vault.campaign(meme).startTime + 7 days);
        (uint256 b2, uint256 g2,) = t.vault.grantBreakdown(meme, bob);
        assertEq(b2, (BOB_BASE - 200_000 ether) / 2);
        assertEq(g2, 20_000 ether, "an earned boost does not decay");
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

        vm.prank(bob);
        vm.expectRevert(IPerkLPGrantVault.ExceedsClaimable.selector); // no boost before any base is activated
        t.vault.activateGrant(meme, 0, 1 ether, 0, 1 ether, 0);

        _activate(meme, bob, 600_000 ether, 0, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 60_000 ether);
        _activate(meme, bob, 0, 60_000 ether, 0); // boost activation earns nobody anything
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 60_000 ether);
        assertEq(t.vault.allocation(meme, bob).boostEarned, 60_000 ether);

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

    /// @dev Credits are nominal: the referral budget sizes the snapshot's boosts but no longer gates credits.
    function test_inviterCredit_notGatedByReferralBudget() public {
        address meme = _graduated(t.erc20Quote, keccak256("budget"));
        uint256 totalBoost = t.vault.campaign(meme).referralBudget - 100 ether; // boosts declared up to the budget
        _proposeAndActivateRoot(meme, root, _defaultTotalBase(), totalBoost);
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, BOB_BASE, BOB_BOOST), MerkleTree.proof(leaves, 1));
        _activate(meme, bob, 600_000 ether, 0, 0);
        assertEq(t.vault.allocation(meme, alice).inviterCreditEarned, 60_000 ether);
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
        (uint256 qf,) = t.vault.collectGrantFees(pos);
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

    /// @dev Exits are never blocked by price. Far above the hook's reference (a pump in the same block), the exit goes
    ///      through, valued at the reference: the quote the pump pushed into the position beyond the beneficiary's
    ///      share goes to the treasury, and the whole meme side is burned.
    function test_exitGrantPosition_farAboveReference_succeeds_andTheMoveGoesToTheTreasury() public {
        address meme = _activeDefault(keccak256("guard-exit"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);

        _swap(key, _quoteIs0(meme), 40 ether, 0);
        (int24 spot, int24 ref) = t.hook.referencePrice(t.graduation.graduationOf(meme).poolId);
        int256 gap = int256(spot) - int256(ref);
        assertGt(gap < 0 ? -gap : gap, 500, "well outside the activation guard");

        uint256 treasuryBefore = t.quoteToken.balanceOf(address(t.treasury));
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 toTreasury, uint256 burned) =
            t.vault.exitGrantPosition(alicePos, 0, 0);
        assertGt(toUser, t.vault.position(alicePos).quoteDeposited);
        assertEq(memeToUser, 0);
        assertGt(toTreasury, 0);
        assertGt(burned, 0);
        assertEq(t.quoteToken.balanceOf(address(t.treasury)) - treasuryBefore, toTreasury);
    }

    /// @dev ... and far below it (a crash), the exit goes through too: all the position's quote goes to the
    ///      beneficiary and meme at the reference price makes up the rest of their share.
    function test_exitGrantPosition_farBelowReference_succeeds() public {
        address meme = _activeDefault(keccak256("crash-exit"));
        _registerDefault(meme);
        uint256 alicePos = _activate(meme, alice, ALICE_BASE, 0, 0);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 inventory = IERC20(meme).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(meme).transfer(swapper, inventory);
        _sellMeme(key, _quoteIs0(meme), meme, inventory / 2);
        (int24 spot, int24 ref) = t.hook.referencePrice(t.graduation.graduationOf(meme).poolId);
        int256 gap = int256(spot) - int256(ref);
        assertGt(gap < 0 ? -gap : gap, 5000, "a crash of thousands of ticks");

        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 toTreasury, uint256 burned) =
            t.vault.exitGrantPosition(alicePos, 0, 0);
        assertLt(toUser, t.vault.position(alicePos).quoteDeposited);
        assertGt(memeToUser, 0);
        assertEq(toTreasury, 0);
        assertGt(burned, 0);
        assertTrue(t.vault.position(alicePos).exited);
    }

    /// @dev Small moves pass: the guard is a band around the reference, not a freeze on trading.
    function test_activateGrant_allowsOrdinaryTradingInTheSameBlock() public {
        address meme = _activeDefault(keccak256("guard-band"));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        _swap(key, _quoteIs0(meme), 0.5 ether, 0);
        _activate(meme, alice, ALICE_BASE, 0, 0);
    }

    /// @dev Whatever the market did between entry and exit, the settlement is the co-ownership split at the reference
    ///      price: the beneficiary holds (1 - g) of the principal's value, quote first, the treasury receives quote
    ///      only when no meme is paid, and the exit pays exactly what exitPreview showed in the same block.
    function testFuzz_exitGrantPosition_settlementBounds(uint256 seed) public {
        address meme = _activeDefault(keccak256(abi.encode("fuzz-exit", seed)));
        t.vault.registerAllocation(meme, _leafStruct(alice, ALICE_BASE, 0), MerkleTree.proof(leaves, 0));
        uint256 pos = _activate(meme, alice, ALICE_BASE, 0, 0);
        uint64 g = t.vault.position(pos).protocolShareWad;
        PoolKey memory key = t.graduation.graduationOf(meme).key;

        if (seed % 2 == 0) {
            uint256 inventory = IERC20(meme).balanceOf(buyer);
            vm.prank(buyer);
            IERC20(meme).transfer(swapper, inventory);
            _sellMeme(key, _quoteIs0(meme), meme, bound(seed >> 8, 1 ether, inventory));
        } else {
            _swap(key, _quoteIs0(meme), bound(seed >> 8, 0.001 ether, 200 ether), 0);
        }
        vm.warp(block.timestamp + 2 days); // the reference has caught up: spot and reference share a tick
        t.vault.collectGrantFees(pos);

        (uint256 pq, uint256 pm, uint256 pt, uint256 pb) = t.vault.exitPreview(pos);
        uint256 supplyBefore = IERC20(meme).totalSupply();
        vm.prank(alice);
        (uint256 toUser, uint256 memeToUser, uint256 toTreasury, uint256 burned) = t.vault.exitGrantPosition(pos, 0, 0);
        assertEq(toUser, pq);
        assertEq(memeToUser, pm);
        assertEq(toTreasury, pt);
        assertEq(burned, pb);
        assertEq(supplyBefore - IERC20(meme).totalSupply(), burned);
        if (memeToUser > 0) assertEq(toTreasury, 0, "quote is paid first");

        (, int24 refTick) = t.hook.referencePrice(t.graduation.graduationOf(meme).poolId);
        uint160 sqrtRef = TickMath.getSqrtPriceAtTick(refTick);
        uint256 principal = toUser + toTreasury + _memeValueInQuoteAt(meme, memeToUser + burned, sqrtRef);
        uint256 held = toUser + _memeValueInQuoteAt(meme, memeToUser, sqrtRef);
        assertApproxEqRel(held, (principal * (1e18 - g)) / 1e18, 1e12);
        assertLe(held, (principal * (1e18 - g)) / 1e18 + 1);
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

/// @dev The exit settlement has to be indifferent to price manipulation by itself, not because a guard happens to
///      stand in front of it. This topology switches the vault's price guard off and attacks the settlement directly.
contract LPGrantVaultExitManipulationTest is GrantTestBase {
    function setUp() public {
        _setUpPerk(type(uint24).max);
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

/// @dev Two positions and the deployed guard value (500 ticks). An LP holding both pumps the price, exits one position
///      into the pump and trades the price back before exiting the other. Valued at the spot price the pumped exit
///      would have extracted grant meme; valued at the hook's reference price it only costs the attacker, inside the
///      guard band and far outside it.
contract LPGrantVaultPumpExitTest is GrantTestBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant A_BASE = 50_000_000 ether;
    uint256 internal constant B_BASE = 50_000_000 ether;
    uint256 internal constant C_BASE = 10_000_000 ether;
    bytes32[] internal big;

    function setUp() public {
        _setUpPerk(); // maxPriceDeviationTicks 500: the deployed value
        big = new bytes32[](4);
        big[0] = MerkleTree.leaf(alice, A_BASE, 0);
        big[1] = MerkleTree.leaf(bob, B_BASE, 0);
        big[2] = MerkleTree.leaf(carol, C_BASE, 0);
        big[3] = MerkleTree.leaf(address(0xdead), 0, 0);
    }

    function test_pumpExitCollect_withTwoPositions_insideTheGuard_isNotProfitable() public {
        _assertPumpExitCollectUnprofitable(keccak256("pump-inside"), 490);
    }

    function test_pumpExitCollect_withTwoPositions_farOutsideTheGuard_isNotProfitable() public {
        _assertPumpExitCollectUnprofitable(keccak256("pump-outside"), 3000);
    }

    function _assertPumpExitCollectUnprofitable(bytes32 salt, int24 pumpTicks) internal {
        address meme = _graduated(t.erc20Quote, salt);
        _proposeAndActivateRoot(meme, MerkleTree.root(big), A_BASE + B_BASE + C_BASE, 0);
        t.vault.registerAllocation(meme, _leafStruct(alice, A_BASE, 0), MerkleTree.proof(big, 0));
        t.vault.registerAllocation(meme, _leafStruct(bob, B_BASE, 0), MerkleTree.proof(big, 1));
        uint256 posA = _activate(meme, alice, A_BASE, 0, 0);
        uint256 posB = _activate(meme, bob, B_BASE, 0, 0);

        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        PoolKey memory key = t.graduation.graduationOf(meme).key;
        bool q0 = _quoteIs0(meme);
        uint160 p0 = _sqrtPriceOf(meme);
        (, int24 tick0,,) = StateLibrary.getSlot0(manager, key.toId());
        vm.prank(swapper); // the attacker's trading account holds quote only
        IERC20(meme).approve(address(swapRouter), type(uint256).max);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        t.vault.exitGrantPosition(posA, 0, 0);
        vm.prank(bob);
        t.vault.exitGrantPosition(posB, 0, 0);
        uint256 honest = _wealth(meme, p0);
        vm.revertToState(snap);

        uint160 pumped =
            q0 ? TickMath.getSqrtPriceAtTick(tick0 - pumpTicks) : TickMath.getSqrtPriceAtTick(tick0 + pumpTicks);
        _buyMemeUpTo(key, q0, pumped);
        (, int24 tickPumped,,) = StateLibrary.getSlot0(manager, key.toId());
        int256 moved = int256(tickPumped) - int256(tick0);
        assertGt(moved < 0 ? -moved : moved, int256(pumpTicks) - 20, "the pump reached its target");

        vm.prank(alice);
        (,, uint256 toTreasury,) = t.vault.exitGrantPosition(posA, 0, 0); // never refused, whatever the price
        _swapTo(key, !q0, -int256(1_000_000_000 ether), p0); // meme back in, down to the starting price exactly
        assertEq(_sqrtPriceOf(meme), p0);
        vm.prank(bob);
        t.vault.exitGrantPosition(posB, 0, 0);
        uint256 attacked = _wealth(meme, p0);

        emit log_named_uint("pumped quote retired to the treasury", toTreasury);
        emit log_named_int("attacker profit vs honest (quote wei)", int256(attacked) - int256(honest));
        assertGt(toTreasury, 0);
        assertLt(attacked, honest, "pump-exit-restore does not pay");
    }

    function _wealth(address meme, uint160 sqrtP) internal view returns (uint256) {
        uint256 q = t.quoteToken.balanceOf(alice) + t.quoteToken.balanceOf(bob) + t.quoteToken.balanceOf(swapper);
        uint256 m = IERC20(meme).balanceOf(alice) + IERC20(meme).balanceOf(bob) + IERC20(meme).balanceOf(swapper);
        return q + _memeValueInQuoteAt(meme, m, sqrtP);
    }

    function _swapTo(PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 limit) internal {
        vm.prank(swapper);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _trySwap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (bool ok) {
        vm.prank(swapper);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        ) {
            ok = true;
        } catch {}
    }

    /// @dev Exact-input quote swap sized by binary search so the price gets as close to `target` as possible without
    ///      crossing it. Sized rather than price-limited: the hook charges its fee on the whole specified amount.
    function _buyMemeUpTo(PoolKey memory key, bool q0, uint160 target) internal returns (uint256 amountIn) {
        uint256 lo;
        uint256 hi = 1_000_000 ether;
        for (uint256 i; i < 90 && lo < hi; ++i) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 snap = vm.snapshotState();
            bool ok = _trySwap(key, q0, mid);
            (uint160 p,,,) = StateLibrary.getSlot0(manager, key.toId());
            vm.revertToState(snap);
            bool crossed = q0 ? p < target : p > target;
            if (ok && !crossed) lo = mid;
            else hi = mid - 1;
        }
        amountIn = lo;
        if (amountIn > 0) assertTrue(_trySwap(key, q0, amountIn));
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
    uint256 public ghostToTreasury;

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
        try vault.collectGrantFees(pos) returns (uint256 qf, uint256) {
            ghostFeesPaid += qf;
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
        try vault.collectGrantFees(pos) returns (uint256 qf, uint256) {
            ghostFeesPaid += qf;
        } catch {}
        vm.prank(who);
        try vault.exitGrantPosition(pos, 0, 0) returns (uint256 toUser, uint256, uint256 toTreasury, uint256) {
            ghostQuoteToUserOnExit += toUser;
            ghostToTreasury += toTreasury;
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

    /// @dev The vault never keeps quote (unused quote is refunded, exits pay it all out) and never turns more meme into
    ///      liquidity than the reserve holds.
    function invariant_noQuoteKept_inventoryNeverOverdrawn() public view {
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(t.quoteToken.balanceOf(address(t.vault)), 0);
        assertLe(c.totalActivated, c.reserve);
        assertEq(t.vault.inventoryRemaining(meme), c.reserve - c.totalActivated);
    }

    function invariant_allocationCaps() public view {
        address[3] memory who = [alice, bob, carol];
        for (uint256 a; a < 3; ++a) {
            uint256[] memory ids = t.vault.positionsOf(who[a]);
            uint256 sum;
            uint256 boostSum;
            for (uint256 i; i < ids.length; ++i) {
                IPerkLPGrantVault.GrantPosition memory p = t.vault.position(ids[i]);
                sum += p.baseMemeActivated + p.inviteeBoostActivated + p.inviterCreditActivated;
                boostSum += p.inviteeBoostActivated;
            }
            IPerkLPGrantVault.Allocation memory alloc = t.vault.allocation(meme, who[a]);
            assertLe(sum, alloc.baseAllocation + alloc.inviteeBoost + alloc.inviterCreditEarned);
            assertEq(boostSum, alloc.boostActivated);
            assertLe(alloc.boostActivated, alloc.boostEarned);
            assertLe(alloc.boostEarned, alloc.inviteeBoost);
            assertLe(alloc.boostEarned, alloc.baseActivated / 10);
            assertLe(alloc.inviterCreditEarned, alloc.baseAllocation / 2);
            assertLe(alloc.inviterCreditActivated, alloc.inviterCreditEarned);
        }
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
