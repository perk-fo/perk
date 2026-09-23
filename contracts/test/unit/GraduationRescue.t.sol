// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

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

    /// @dev Graduate with the next stage's external call failing, so the launch stops at `at`.
    function _stall(address meme, IPerkGraduationManager.Stage at) internal {
        if (at == IPerkGraduationManager.Stage.FUNDED) {
            vm.mockCallRevert(address(manager), abi.encodeWithSelector(IPoolManager.initialize.selector), "STALL");
        } else if (at == IPerkGraduationManager.Stage.POOL_INITIALIZED) {
            vm.mockCallRevert(
                address(t.positionManager), abi.encodeWithSelector(IPositionManager.modifyLiquidities.selector), "STALL"
            );
        } else if (at == IPerkGraduationManager.Stage.LIQUIDITY_ADDED) {
            vm.mockCallRevert(
                address(t.vault), abi.encodeWithSelector(IPerkLPGrantVault.initCampaign.selector), "STALL"
            );
        }
        t.graduation.graduate(meme);
        vm.clearMockedCalls();
        assertEq(uint256(t.graduation.graduationOf(meme).stage), uint256(at));
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

    function test_rescue_fromEveryStuckStage_refundsHoldersProRata() public {
        IPerkGraduationManager.Stage[3] memory stages = [
            IPerkGraduationManager.Stage.NONE,
            IPerkGraduationManager.Stage.FUNDED,
            IPerkGraduationManager.Stage.POOL_INITIALIZED
        ];
        for (uint256 s; s < stages.length; ++s) {
            address meme = _pending(t.erc20Quote, keccak256(abi.encode("stuck", s)));
            if (stages[s] != IPerkGraduationManager.Stage.NONE) _stall(meme, stages[s]);

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
        _stall(meme, IPerkGraduationManager.Stage.POOL_INITIALIZED);
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
        _stall(meme, IPerkGraduationManager.Stage.POOL_INITIALIZED);
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

    /// @dev Only launches with nowhere to sell qualify: from LIQUIDITY_ADDED on the pool is live.
    function test_rescue_onlyForLaunchesStuckBeforeTheirPool() public {
        address active = _createLaunch(PerkConstants.TEMPLATE_PERK_GRANT_V1, t.erc20Quote, keccak256("active"));
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.proposeRescue(active);

        address done = _graduated(t.erc20Quote, keccak256("done"));
        vm.expectRevert(IPerkGraduationManager.NotGraduationPending.selector);
        t.graduation.proposeRescue(done);

        address live = _pending(t.erc20Quote, keccak256("live"));
        _stall(live, IPerkGraduationManager.Stage.LIQUIDITY_ADDED);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPerkGraduationManager.NotRescuable.selector, IPerkGraduationManager.Stage.LIQUIDITY_ADDED
            )
        );
        t.graduation.proposeRescue(live);
    }

    /// @dev A proposal made while funds sat in the curve still works if graduation moved them in the meantime.
    function test_rescue_proposedAtNone_executesAfterAPartialGraduation() public {
        address meme = _pending(t.erc20Quote, keccak256("moved"));
        t.graduation.proposeRescue(meme);
        _stall(meme, IPerkGraduationManager.Stage.FUNDED);
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
        address parked = _pending(t.erc20Quote, keccak256("parked-other"));
        _stall(parked, IPerkGraduationManager.Stage.POOL_INITIALIZED);
        uint256 parkedQuote = t.graduation.graduationOf(parked).quoteHeld;

        address rescued = _pending(t.erc20Quote, keccak256("rescued"));
        _stall(rescued, IPerkGraduationManager.Stage.FUNDED);
        _rescue(rescued);
        _redeemAll(rescued, t.erc20Quote);

        assertEq(t.graduation.graduationOf(parked).quoteHeld, parkedQuote);
        assertGe(t.erc20Quote.balanceOf(address(t.graduation)), parkedQuote);
        t.graduation.graduate(parked);
        assertEq(uint256(t.factory.getLaunch(parked).status), uint256(PerkTypes.LaunchStatus.GRADUATED));
        assertGt(t.graduation.graduationOf(parked).liquidity, 0);
    }

    /// @dev Pausing everything never blocks the way out: a rescue can still run and holders can still redeem.
    function test_pauseAll_doesNotBlockRescueOrRedeem() public {
        address meme = _pending(t.erc20Quote, keccak256("paused"));
        t.factory.setPaused(PerkConstants.PAUSE_ALL);
        vm.expectRevert(abi.encodeWithSelector(IPerkLaunchFactory.Paused.selector, PerkConstants.PAUSE_GRADUATION));
        t.graduation.graduate(meme);
        _rescue(meme);
        _redeemAll(meme, t.erc20Quote);
    }
}
