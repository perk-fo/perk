// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferralRegistry} from "../../src/referral/ReferralRegistry.sol";
import {IPerkReferralRegistry} from "../../src/interfaces/IPerkReferralRegistry.sol";

contract ReferralRegistryTest is Test {
    ReferralRegistry internal reg;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event InviterBound(address indexed invitee, address indexed inviter, uint64 blockNumber);
    event OptedIn(address indexed account, uint64 blockNumber);

    function setUp() public {
        reg = new ReferralRegistry();
    }

    function test_bindInviter_reverts_zeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.ZeroAddress.selector);
        reg.bindInviter(address(0));
    }

    function test_bindInviter_reverts_selfReferral() public {
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.SelfReferral.selector);
        reg.bindInviter(alice);
    }

    function test_bindInviter_reverts_alreadyBound() public {
        vm.prank(alice);
        reg.bindInviter(bob);
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.AlreadyBound.selector);
        reg.bindInviter(bob);
    }

    function test_bindInviter_reverts_mutualReferral() public {
        vm.prank(alice);
        reg.bindInviter(bob);
        vm.prank(bob);
        vm.expectRevert(IPerkReferralRegistry.MutualReferral.selector);
        reg.bindInviter(alice);
    }

    function test_bindInviter_emitsWithBlock_isBoundByCutoff() public {
        vm.roll(100);
        vm.expectEmit(true, true, false, true, address(reg));
        emit InviterBound(alice, bob, 100);
        vm.prank(alice);
        reg.bindInviter(bob);

        assertEq(reg.inviterOf(alice), bob);
        assertEq(reg.boundAtBlock(alice), 100);
        assertTrue(reg.isBoundBy(alice, bob, 100));
        assertTrue(reg.isBoundBy(alice, bob, 101));
        assertFalse(reg.isBoundBy(alice, bob, 99));
        assertFalse(reg.isBoundBy(alice, bob, 0));
        assertFalse(reg.isBoundBy(alice, alice, 100));
        assertFalse(reg.isBoundBy(bob, alice, 100));
    }

    function test_optIn_firstCallRecordsAndEmits_secondIsNoOp() public {
        vm.roll(50);
        vm.expectEmit(true, false, false, true, address(reg));
        emit OptedIn(alice, 50);
        vm.prank(alice);
        reg.optIn();
        assertEq(reg.optInBlock(alice), 50);

        vm.roll(80);
        vm.recordLogs();
        vm.prank(alice);
        reg.optIn();
        assertEq(reg.optInBlock(alice), 50);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ---- optInWithInviter (invite-link flow: one transaction) ----

    function test_optInWithInviter_bindsAndOptsIn() public {
        vm.roll(77);
        vm.expectEmit(true, true, false, true);
        emit InviterBound(alice, bob, 77);
        vm.expectEmit(true, false, false, true);
        emit OptedIn(alice, 77);
        vm.prank(alice);
        reg.optInWithInviter(bob);
        assertEq(reg.inviterOf(alice), bob);
        assertEq(reg.boundAtBlock(alice), 77);
        assertEq(reg.optInBlock(alice), 77);
    }

    function test_optInWithInviter_keepsEarlierOptIn() public {
        vm.roll(10);
        vm.prank(alice);
        reg.optIn();
        vm.roll(20);
        vm.prank(alice);
        reg.optInWithInviter(bob);
        assertEq(reg.optInBlock(alice), 10);
        assertEq(reg.boundAtBlock(alice), 20);
    }

    function test_optInWithInviter_reverts_selfReferral_noOptIn() public {
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.SelfReferral.selector);
        reg.optInWithInviter(alice);
        assertEq(reg.optInBlock(alice), 0);
    }

    function test_optInWithInviter_reverts_zeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.ZeroAddress.selector);
        reg.optInWithInviter(address(0));
    }

    function test_optInWithInviter_reverts_alreadyBound_noOptInChange() public {
        address carol = makeAddr("carol");
        vm.prank(alice);
        reg.bindInviter(bob);
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.AlreadyBound.selector);
        reg.optInWithInviter(carol);
        assertEq(reg.inviterOf(alice), bob);
        assertEq(reg.optInBlock(alice), 0);
    }

    function test_optInWithInviter_reverts_mutualReferral() public {
        vm.prank(bob);
        reg.bindInviter(alice);
        vm.prank(alice);
        vm.expectRevert(IPerkReferralRegistry.MutualReferral.selector);
        reg.optInWithInviter(bob);
    }
}
