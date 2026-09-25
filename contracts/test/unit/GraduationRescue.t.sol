// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

// forge-lint: disable-start(environment-read-across-mutation)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

import {IPerkGraduationManager} from "../../src/interfaces/IPerkGraduationManager.sol";
import {IPerkLaunchFactory} from "../../src/interfaces/IPerkLaunchFactory.sol";
import {IPerkLPGrantVault} from "../../src/interfaces/IPerkLPGrantVault.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {PerkTypes} from "../../src/libraries/PerkTypes.sol";
import {GrantTestBase} from "../utils/GrantTestBase.sol";

/// @dev Tries to take a second redemption from inside the first one's native payout.
contract ReentrantRedeemer {
    IPerkGraduationManager internal immutable graduation;
    address internal meme;
    bool internal reenter;

    constructor(IPerkGraduationManager graduation_) {
        graduation = graduation_;
    }

    function attack(address meme_, uint256 amount, bool reenter_) external returns (uint256) {
        meme = meme_;
        reenter = reenter_;
        IERC20(meme_).approve(address(graduation), type(uint256).max);
        return graduation.redeem(meme_, amount);
    }

    receive() external payable {
        if (reenter) graduation.redeem(meme, IERC20(meme).balanceOf(address(this)));
    }
}

/// @notice Rescue of a launch whose graduation stalled before any liquidity reached its pool, and the pro-rata
///         redemption that follows. The property that matters most: the owner can start a rescue but no party other
///         than the token's holders can ever receive any of the launch's money.
contract GraduationRescueTest is GrantTestBase {
    using CurrencyLibrary for Currency;

    address[4] internal holders;

    function setUp() public {
        _setUpPerk();
        holders = [alice, bob, carol, buyer];
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Three small buys, then `buyer` crosses the threshold: four holders, launch GRADUATION_PENDING at stage NONE.
    function _pending(Currency quote, bytes32 salt) internal returns (address meme) {
        meme = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, quote, salt);
        _buy(meme, quote, alice, 10 ether);
        _buy(meme, quote, bob, 20 ether);
        _buy(meme, quote, carol, 5 ether);
        _buy(meme, quote, buyer, BUY_GROSS);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATION_PENDING));
    }

    function _buy(address meme, Currency quote, address who, uint256 amount) internal {
        vm.prank(who);
        if (quote.isAddressZero()) t.curve.buy{value: amount}(meme, amount, 0, who);
        else t.curve.buy(meme, amount, 0, who);
    }

    /// @dev Attempts a graduation whose `step`-th external call fails (0: pool initialisation, 1: seeding,
    ///      2: the grant campaign). Graduation is atomic, so the attempt reverts and the launch is left at NONE with
    ///      its money still in the curve.
    function _failGraduation(address meme, uint256 step) internal {
        if (step == 0) {
            vm.mockCallRevert(address(manager), abi.encodeWithSelector(IPoolManager.initialize.selector), "STALL");
        } else if (step == 1) {
            vm.mockCallRevert(
                address(t.positionManager), abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector), "STALL"
            );
        } else {
            vm.mockCallRevert(
                address(t.vault), abi.encodeWithSelector(IPerkLPGrantVault.initCampaign.selector), "STALL"
            );
        }
        vm.expectRevert(bytes("STALL"));
        t.graduation.graduate(meme);
        vm.clearMockedCalls();
        assertEq(uint256(t.graduation.graduationOf(meme).stage), uint256(IPerkGraduationManager.Stage.NONE));
        assertFalse(t.curve.curveState(meme).finalized);
    }

    function _rescue(address meme) internal {
        t.graduation.proposeRescue(meme);
        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.prank(stranger); // executing is permissionless
        t.graduation.executeRescue(meme);
    }

    function _outstanding(address meme) internal view returns (uint256) {
        IERC20 token = IERC20(meme);
        return token.totalSupply() - token.balanceOf(address(t.graduation)) - token.balanceOf(address(t.vault));
    }

    function _approveAll(address meme) internal {
        for (uint256 i; i < holders.length; ++i) {
            vm.prank(holders[i]);
            IERC20(meme).approve(address(t.graduation), type(uint256).max);
        }
    }

    /// @dev Everyone redeems everything; returns what each was paid. Asserts the whole refund went to holders.
    function _redeemAll(address meme, Currency quote) internal returns (uint256[4] memory paid) {
        uint256 pool = t.graduation.graduationOf(meme).quoteHeld;
        uint256 managerBefore = quote.balanceOf(address(t.graduation));
        _approveAll(meme);
        for (uint256 i; i < holders.length; ++i) {
            uint256 bal = IERC20(meme).balanceOf(holders[i]);
            uint256 before = quote.balanceOf(holders[i]);
            vm.prank(holders[i]);
            t.graduation.redeem(meme, bal);
            paid[i] = quote.balanceOf(holders[i]) - before;
        }
        assertEq(paid[0] + paid[1] + paid[2] + paid[3], pool, "every unit of the refund goes to holders");
        assertEq(t.graduation.graduationOf(meme).quoteHeld, 0);
        assertEq(managerBefore - quote.balanceOf(address(t.graduation)), pool, "nothing else left the manager");
        assertEq(_outstanding(meme), 0);
    }

    // ------------------------------------------------------------------ happy paths

    /// @dev Whichever step of graduation keeps failing, the launch stays whole at NONE and the rescue refunds it.
    function test_rescue_ofALaunchWhoseGraduationKeepsFailing_refundsHoldersProRata() public {
        for (uint256 s; s < 4; ++s) {
            address meme = _pending(t.erc20Quote, keccak256(abi.encode("stuck", s)));
            if (s > 0) _failGraduation(meme, s - 1);

            uint256[4] memory bal;
            uint256 sumBal;
            for (uint256 i; i < holders.length; ++i) {
                bal[i] = IERC20(meme).balanceOf(holders[i]);
                sumBal += bal[i];
            }
            _rescue(meme);

            IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
            assertEq(uint256(g.stage), uint256(IPerkGraduationManager.Stage.REFUNDING));
            assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.REFUNDING));
            assertGt(g.quoteHeld, 0);
            assertEq(g.quoteHeld, g.quoteReceived, "the whole of the launch's quote is up for redemption");
            assertEq(IERC20(meme).balanceOf(address(t.graduation)), 0, "unsold and pool-reserve tokens burned");
            assertEq(_outstanding(meme), sumBal, "only the four holders share the refund");

            uint256 pool = g.quoteHeld;
            uint256[4] memory paid = _redeemAll(meme, t.erc20Quote);
            for (uint256 i; i < holders.length; ++i) {
                assertApproxEqAbs(paid[i], (pool * bal[i]) / sumBal, 2, "pro-rata to holdings");
            }
        }
    }

    function test_rescue_nativeQuote() public {
        address meme = _pending(t.nativeQuote, keccak256("native"));
        _failGraduation(meme, 1);
        _rescue(meme);
        _redeemAll(meme, t.nativeQuote);
    }

    // ------------------------------------------------------------------ who can do what

    function test_rescue_onlyOwnerProposesAndCancels_anyoneExecutes() public {
        address meme = _pending(t.erc20Quote, keccak256("auth"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        t.graduation.proposeRescue(meme);

        t.graduation.proposeRescue(meme);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        t.graduation.cancelRescue(meme);

        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.prank(stranger);
        t.graduation.executeRescue(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.REFUNDING));
    }

    /// @dev The owner can trigger a rescue but gains nothing from it: it holds no tokens, so it can redeem nothing,
    ///      and every unit of quote that leaves the manager goes to a holder (asserted in _redeemAll).
    function test_rescue_ownerCannotTakeAnything() public {
        address meme = _pending(t.erc20Quote, keccak256("owner"));
        uint256 ownerQuote = t.erc20Quote.balanceOf(address(this));
        uint256 ownerNative = address(this).balance;
        _rescue(meme);
        assertEq(t.erc20Quote.balanceOf(address(this)), ownerQuote);
        assertEq(address(this).balance, ownerNative);

        vm.expectRevert(IPerkGraduationManager.NothingToRedeem.selector);
        t.graduation.redeem(meme, 0);
        vm.expectRevert(); // no tokens to hand in
        t.graduation.redeem(meme, 1 ether);

        _redeemAll(meme, t.erc20Quote);
        assertEq(t.erc20Quote.balanceOf(address(this)), ownerQuote);
    }

    // ------------------------------------------------------------------ timing and state

    function test_rescue_waitsOutTheDelay_andRunsOnce() public {
        address meme = _pending(t.erc20Quote, keccak256("delay"));
        vm.expectEmit(true, false, false, true, address(t.graduation));
        emit IPerkGraduationManager.RescueProposed(meme, uint64(block.timestamp) + RESCUE_DELAY);
        t.graduation.proposeRescue(meme);
        vm.expectRevert(IPerkGraduationManager.RescueAlreadyProposed.selector);
        t.graduation.proposeRescue(meme);

        uint64 at = t.graduation.graduationOf(meme).rescueExecutableAt;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IPerkGraduationManager.RescueNotReady.selector, at));
        t.graduation.executeRescue(meme);

        vm.warp(at);
        t.graduation.executeRescue(meme);
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.executeRescue(meme);
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.graduate(meme);
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.proposeRescue(meme);
        vm.expectRevert(
            abi.encodeWithSelector(IPerkGraduationManager.NotRescuable.selector, IPerkGraduationManager.Stage.REFUNDING)
        );
        t.graduation.cancelRescue(meme);
    }

    function test_rescue_cancelled_thenProposedAgain() public {
        address meme = _pending(t.erc20Quote, keccak256("cancel"));
        vm.expectRevert(IPerkGraduationManager.RescueNotProposed.selector);
        t.graduation.cancelRescue(meme);
        t.graduation.proposeRescue(meme);
        vm.expectEmit(true, false, false, false, address(t.graduation));
        emit IPerkGraduationManager.RescueCancelled(meme);
        t.graduation.cancelRescue(meme);
        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.expectRevert(IPerkGraduationManager.RescueNotProposed.selector);
        t.graduation.executeRescue(meme);
        _rescue(meme);
    }

    /// @dev The delay is the chance for the launch to graduate after all; if it does, the rescue is void.
    function test_rescue_voidedWhenTheLaunchGraduatesDuringTheDelay() public {
        address meme = _pending(t.erc20Quote, keccak256("late"));
        _failGraduation(meme, 1);
        t.graduation.proposeRescue(meme);

        vm.expectEmit(true, false, false, false, address(t.graduation));
        emit IPerkGraduationManager.RescueCancelled(meme);
        vm.prank(stranger);
        t.graduation.graduate(meme); // the stall has cleared
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertEq(t.graduation.graduationOf(meme).rescueExecutableAt, 0);

        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.expectRevert(IPerkGraduationManager.RescueNotProposed.selector);
        t.graduation.executeRescue(meme);
    }

    /// @dev Only launches with nowhere to sell qualify: a launch still on its curve or already graduated does not.
    function test_rescue_onlyForLaunchesStuckBeforeTheirPool() public {
        address active = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("active"));
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.proposeRescue(active);

        address done = _graduated(t.erc20Quote, keccak256("done"));
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.proposeRescue(done);
    }

    /// @dev A graduation that fails during the delay changes nothing: the rescue executes from the curve as proposed.
    function test_rescue_proposed_thenAFailedGraduation_changesNothing() public {
        address meme = _pending(t.erc20Quote, keccak256("moved"));
        t.graduation.proposeRescue(meme);
        uint64 at = t.graduation.graduationOf(meme).rescueExecutableAt;
        _failGraduation(meme, 2);
        assertEq(t.graduation.graduationOf(meme).rescueExecutableAt, at);
        vm.warp(block.timestamp + RESCUE_DELAY);
        t.graduation.executeRescue(meme);
        IPerkGraduationManager.Graduation memory g = t.graduation.graduationOf(meme);
        assertEq(g.quoteHeld, g.quoteReceived);
        _redeemAll(meme, t.erc20Quote);
    }

    // ------------------------------------------------------------------ redemption

    function test_redeem_rejectsBeforeRefundingAndEmptyAmounts() public {
        address meme = _pending(t.erc20Quote, keccak256("early"));
        vm.prank(alice);
        vm.expectRevert(IPerkGraduationManager.NotRefunding.selector);
        t.graduation.redeem(meme, 1);
        assertEq(t.graduation.previewRedeem(meme, 1 ether), 0);

        _rescue(meme);
        vm.prank(alice);
        vm.expectRevert(IPerkGraduationManager.NothingToRedeem.selector);
        t.graduation.redeem(meme, 0);
        uint256 tooMuch = _outstanding(meme) + 1;
        vm.prank(alice);
        vm.expectRevert(IPerkGraduationManager.NothingToRedeem.selector);
        t.graduation.redeem(meme, tooMuch);
    }

    /// @dev Tokens stranded where they cannot be redeemed (sent to the manager or the vault) drop out of the
    ///      outstanding supply: the sender loses them and everyone else's share rises. Nobody gains by doing it.
    function test_redeem_strandedTokensOnlyRaiseEveryoneElsesShare() public {
        address meme = _pending(t.erc20Quote, keccak256("strand"));
        _rescue(meme);
        uint256 pool = t.graduation.graduationOf(meme).quoteHeld;
        uint256 aliceFair = (pool * IERC20(meme).balanceOf(alice)) / _outstanding(meme);

        uint256 half = IERC20(meme).balanceOf(carol) / 2;
        vm.startPrank(carol);
        IERC20(meme).transfer(address(t.graduation), half / 2);
        IERC20(meme).transfer(address(t.vault), half - half / 2);
        vm.stopPrank();

        uint256 aliceBal = IERC20(meme).balanceOf(alice);
        assertGt(t.graduation.previewRedeem(meme, aliceBal), aliceFair, "stranded tokens raise alice's share");
        _redeemAll(meme, t.erc20Quote);
    }

    /// @dev Pricing each redemption on what is left makes the order irrelevant: random orders and partial
    ///      redemptions all land within rounding of the fair share, and the pool is paid out exactly.
    function testFuzz_redeem_orderAndPartialsDoNotMatter(uint256 seed) public {
        address meme = _pending(t.erc20Quote, keccak256(abi.encode("order", seed)));
        _rescue(meme);
        uint256 pool = t.graduation.graduationOf(meme).quoteHeld;
        uint256 total = _outstanding(meme);
        uint256[4] memory fair;
        uint256[4] memory before;
        for (uint256 i; i < 4; ++i) {
            fair[i] = (pool * IERC20(meme).balanceOf(holders[i])) / total;
            before[i] = t.erc20Quote.balanceOf(holders[i]);
        }
        _approveAll(meme);
        // three rounds of partial redemptions by seed-picked holders, then everyone clears out
        for (uint256 round; round < 3; ++round) {
            for (uint256 k; k < 4; ++k) {
                uint256 i = uint256(keccak256(abi.encode(seed, round, k))) % 4;
                uint256 bal = IERC20(meme).balanceOf(holders[i]);
                if (bal == 0) continue;
                uint256 amount = bound(uint256(keccak256(abi.encode(seed, i, round))), 1, bal);
                if (t.graduation.previewRedeem(meme, amount) == 0) continue;
                vm.prank(holders[i]);
                t.graduation.redeem(meme, amount);
            }
        }
        for (uint256 k; k < 4; ++k) {
            uint256 i = (seed % 4 + k) % 4; // a seed-dependent final order too
            uint256 bal = IERC20(meme).balanceOf(holders[i]);
            if (bal == 0 || t.graduation.previewRedeem(meme, bal) == 0) continue;
            vm.prank(holders[i]);
            t.graduation.redeem(meme, bal);
        }
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            uint256 got = t.erc20Quote.balanceOf(holders[i]) - before[i];
            sum += got;
            assertApproxEqAbs(got, fair[i], 8, "order does not change anyone's share");
        }
        assertLe(sum, pool);
        assertApproxEqAbs(sum, pool, 8);
    }

    /// @dev A holder contract cannot re-enter redeem from its native payout to be paid twice.
    function test_redeem_reentrancyFromNativePayoutFails() public {
        address meme = _pending(t.nativeQuote, keccak256("reenter"));
        _rescue(meme);
        ReentrantRedeemer attacker = new ReentrantRedeemer(t.graduation);
        uint256 amount = IERC20(meme).balanceOf(alice);
        vm.prank(alice);
        IERC20(meme).transfer(address(attacker), amount);

        uint256 poolBefore = t.graduation.graduationOf(meme).quoteHeld;
        vm.expectRevert(); // the inner call hits the reentrancy guard, which fails the payout and the whole redeem
        attacker.attack(meme, amount / 2, true);
        assertEq(t.graduation.graduationOf(meme).quoteHeld, poolBefore);
        assertEq(IERC20(meme).balanceOf(address(attacker)), amount);

        uint256 got = attacker.attack(meme, amount, false); // the honest path still works
        assertGt(got, 0);
        assertEq(address(attacker).balance, got);
    }

    // ------------------------------------------------------------------ isolation and pause

    /// @dev A rescue pays out only its own launch's quote; another launch parked in the same currency is untouched
    ///      and can still graduate with everything it was owed.
    function test_rescue_leavesOtherLaunchesFundsAlone() public {
        address rescued = _pending(t.erc20Quote, keccak256("rescued"));
        _rescue(rescued);
        uint256 rescuedQuote = t.graduation.graduationOf(rescued).quoteHeld;
        assertEq(t.erc20Quote.balanceOf(address(t.graduation)), rescuedQuote);

        // another launch on the same quote graduates while the refund is outstanding
        address other = _pending(t.erc20Quote, keccak256("parked-other"));
        t.graduation.graduate(other);
        assertEq(uint256(t.factory.getLaunch(other).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertGt(t.graduation.graduationOf(other).liquidity, 0);
        assertEq(t.graduation.graduationOf(rescued).quoteHeld, rescuedQuote);
        assertEq(t.erc20Quote.balanceOf(address(t.graduation)), rescuedQuote);

        _redeemAll(rescued, t.erc20Quote);
        assertEq(t.erc20Quote.balanceOf(address(t.graduation)), 0);
    }

    /// @dev Pausing everything never blocks the way out: holders of a refunding launch can still redeem. Executing
    ///      a rescue is not a way out but the end of a launch's chance to graduate, so the pause holds it too.
    function test_pauseAll_blocksRescueExecution_butNeverRedemption() public {
        address meme = _pending(t.erc20Quote, keccak256("paused"));
        address refunding = _pending(t.erc20Quote, keccak256("refunding"));
        _rescue(refunding);
        t.graduation.proposeRescue(meme);
        vm.warp(vm.getBlockTimestamp() + RESCUE_DELAY);

        t.factory.setPaused(PerkConstants.PAUSE_ALL);
        bytes memory paused = abi.encodeWithSelector(IPerkLaunchFactory.Paused.selector, PerkConstants.PAUSE_GRADUATION);
        vm.expectRevert(paused);
        t.graduation.graduate(meme);
        vm.expectRevert(paused);
        t.graduation.executeRescue(meme);
        _redeemAll(refunding, t.erc20Quote);
    }

    /// @dev Security: pause plus rescue must not let the owner force a launch into refunds. The owner proposes a
    ///      rescue for a launch whose curve has just completed, then pauses graduation so that nobody can graduate it
    ///      during the delay. The rescue cannot execute while the pause lasts, and when the pause is lifted it waits
    ///      a whole delay again with graduation open, so unpausing and executing in one go fails too. Anyone
    ///      graduates the launch in that window and the rescue is void.
    function test_pauseAndRescue_cannotForceAPendingLaunchIntoRefunds() public {
        address meme = _pending(t.erc20Quote, keccak256("forced"));
        t.graduation.proposeRescue(meme);
        t.factory.setPaused(PerkConstants.PAUSE_GRADUATION);
        vm.warp(vm.getBlockTimestamp() + RESCUE_DELAY + 1 days);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPerkLaunchFactory.Paused.selector, PerkConstants.PAUSE_GRADUATION));
        t.graduation.executeRescue(meme);

        // lifting the pause and executing at once
        t.factory.setPaused(0);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        assertEq(t.factory.graduationResumedAt(), now_);
        uint64 reopenedUntil = now_ + RESCUE_DELAY;
        vm.expectRevert(abi.encodeWithSelector(IPerkGraduationManager.RescueNotReady.selector, reopenedUntil));
        t.graduation.executeRescue(meme);
        vm.warp(reopenedUntil - 1);
        vm.expectRevert(abi.encodeWithSelector(IPerkGraduationManager.RescueNotReady.selector, reopenedUntil));
        t.graduation.executeRescue(meme);

        // graduation is open the whole time: anyone graduates, and the rescue is void
        vm.prank(stranger);
        t.graduation.graduate(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        vm.warp(reopenedUntil);
        vm.expectRevert(IPerkGraduationManager.RescueNotProposed.selector);
        t.graduation.executeRescue(meme);
    }

    /// @dev A pause lifted long before the proposal does not delay the rescue at all.
    function test_executeRescue_anOldPauseDoesNotDelayIt() public {
        uint256 t0 = vm.getBlockTimestamp();
        t.factory.setPaused(PerkConstants.PAUSE_GRADUATION);
        vm.warp(t0 + 1 days);
        t.factory.setPaused(0);
        vm.warp(t0 + 1 days + RESCUE_DELAY);
        address meme = _pending(t.erc20Quote, keccak256("old-pause"));
        t.graduation.proposeRescue(meme);
        uint64 at = t.graduation.graduationOf(meme).rescueExecutableAt;
        assertEq(at, t0 + 1 days + 2 * uint256(RESCUE_DELAY));
        vm.warp(at);
        t.graduation.executeRescue(meme);
        assertEq(uint256(t.factory.getLaunch(meme).status), uint256(PerkTypes.LaunchStatus.REFUNDING));
    }

    // ------------------------------------------------------------------ the grant reserve of a refunded launch

    /// @dev A refunded Perk launch never gets a grant campaign, so its reserve would sit in the vault for good.
    ///      Anyone can burn it once the launch is REFUNDING, and nobody's refund changes when they do.
    function test_burnRefundedReserve_burnsIt_andRefundsAreUnchanged() public {
        address meme = _pending(t.erc20Quote, keccak256("reserve"));
        _rescue(meme);
        uint256 reserve = IERC20(meme).balanceOf(address(t.vault));
        assertGt(reserve, 0);
        uint256 aliceBal = IERC20(meme).balanceOf(alice);
        uint256 aliceRefund = t.graduation.previewRedeem(meme, aliceBal);
        uint256 supply = IERC20(meme).totalSupply();

        vm.expectEmit(true, false, false, true, address(t.vault));
        emit IPerkLPGrantVault.GrantMemeBurned(meme, reserve, "REFUNDED");
        vm.expectEmit(true, false, false, true, address(t.vault));
        emit IPerkLPGrantVault.CampaignCancelled(meme, reserve);
        vm.prank(stranger);
        assertEq(t.vault.burnRefundedReserve(meme), reserve);

        assertEq(supply - IERC20(meme).totalSupply(), reserve);
        assertEq(IERC20(meme).balanceOf(address(t.vault)), 0);
        IPerkLPGrantVault.Campaign memory c = t.vault.campaign(meme);
        assertEq(uint256(c.status), uint256(IPerkLPGrantVault.CampaignStatus.CANCELLED));
        assertEq(c.burned, reserve);
        assertEq(t.graduation.previewRedeem(meme, aliceBal), aliceRefund, "no holder's refund moves");

        vm.expectRevert(
            abi.encodeWithSelector(IPerkLPGrantVault.InvalidStatus.selector, IPerkLPGrantVault.CampaignStatus.CANCELLED)
        );
        t.vault.burnRefundedReserve(meme);
        _redeemAll(meme, t.erc20Quote);
    }

    /// @dev Only a refunded launch's reserve: a pending launch may still graduate and a graduated one has a campaign.
    function test_burnRefundedReserve_reverts_launchNotRefunding() public {
        address pending = _pending(t.erc20Quote, keccak256("still-pending"));
        vm.expectRevert(IPerkLPGrantVault.LaunchNotRefunding.selector);
        t.vault.burnRefundedReserve(pending);

        address done = _graduated(t.erc20Quote, keccak256("has-campaign"));
        vm.expectRevert(IPerkLPGrantVault.LaunchNotRefunding.selector);
        t.vault.burnRefundedReserve(done);

        vm.expectRevert(IPerkLPGrantVault.LaunchNotRefunding.selector);
        t.vault.burnRefundedReserve(stranger);
    }
}
// forge-lint: disable-end(environment-read-across-mutation)
