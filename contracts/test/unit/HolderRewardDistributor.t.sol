// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PerkMemeToken} from "../../src/token/PerkMemeToken.sol";
import {HolderRewardDistributor} from "../../src/rewards/HolderRewardDistributor.sol";
import {IPerkHolderRewardDistributor} from "../../src/interfaces/IPerkHolderRewardDistributor.sol";
import {PerkConstants} from "../../src/libraries/PerkConstants.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {MockFeeRouter} from "../utils/MockFeeRouter.sol";

contract RevertingNativeReceiver {
    error Nope();

    receive() external payable {
        revert Nope();
    }
}

contract HolderRewardDistributorTest is Test {
    uint256 internal constant TOTAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MIN_ELIGIBLE = 1;
    string internal constant URI = "ipfs://perk-meme";

    HolderRewardDistributor internal distributor;
    MockFeeRouter internal feeRouter;
    PerkMemeToken internal token;
    address internal vault;
    address internal alice;
    address internal bob;
    address internal carol;

    event MemeRegistered(address indexed meme, Currency indexed quote, address feeRouter, uint256 minEligibleBalance);
    event RewardEligibilityUpdated(address indexed meme, address indexed account, bool excluded);
    event QuoteRewardsAccrued(
        address indexed meme, uint256 quoteAmount, uint256 eligibleSupply, uint256 accQuotePerShare
    );
    event QuoteRewardsHeld(address indexed meme, uint256 quoteAmount);
    event QuoteRewardsClaimed(address indexed meme, address indexed account, uint256 quoteAmount);

    function setUp() public {
        vault = makeAddr("vault");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        distributor = new HolderRewardDistributor(address(this));
        feeRouter = new MockFeeRouter(distributor);
        token = _deployRegisteredMeme(Currency.wrap(address(0)), MIN_ELIGIBLE, vault);
    }

    function test_registerMeme_onlyFactory() public {
        address meme = makeAddr("unauthMeme");
        address[] memory excluded = new address[](1);
        excluded[0] = address(this);

        vm.prank(alice);
        vm.expectRevert(IPerkHolderRewardDistributor.NotFactory.selector);
        distributor.registerMeme(meme, Currency.wrap(address(0)), address(feeRouter), MIN_ELIGIBLE, excluded);
    }

    function test_registerMeme_reverts_alreadyRegistered() public {
        address[] memory excluded = new address[](0);
        vm.expectRevert(IPerkHolderRewardDistributor.AlreadyRegistered.selector);
        distributor.registerMeme(address(token), Currency.wrap(address(0)), address(feeRouter), MIN_ELIGIBLE, excluded);
    }

    function test_registerMeme_setsExcludedAndEmits() public {
        address meme = makeAddr("freshMeme");
        address extra = makeAddr("locker");
        address[] memory excluded = new address[](2);
        excluded[0] = address(this);
        excluded[1] = extra;

        vm.expectEmit(true, true, false, true, address(distributor));
        emit MemeRegistered(meme, Currency.wrap(address(0)), address(feeRouter), 10);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, address(this), true);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, extra, true);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, address(0), true);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, PerkConstants.DEAD_ADDRESS, true);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, address(distributor), true);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardEligibilityUpdated(meme, meme, true);

        distributor.registerMeme(meme, Currency.wrap(address(0)), address(feeRouter), 10, excluded);

        assertTrue(distributor.isExcluded(meme, extra));
        assertTrue(distributor.isExcluded(meme, address(0)));
        assertTrue(distributor.isExcluded(meme, PerkConstants.DEAD_ADDRESS));
        assertTrue(distributor.isExcluded(meme, address(distributor)));
        assertTrue(distributor.isExcluded(meme, meme));
        assertTrue(distributor.isExcluded(meme, address(this)));
        assertTrue(distributor.rewardState(meme).registered);
        assertEq(distributor.factory(), address(this));
    }

    function test_onBalanceChange_unregisteredCaller_noStateChange() public {
        uint256 supplyBefore = distributor.rewardState(address(token)).eligibleSupply;
        distributor.onBalanceChange(alice, 0, 100 ether);
        assertEq(distributor.rewardState(address(token)).eligibleSupply, supplyBefore);
        assertEq(distributor.eligibleBalanceOf(address(this), alice), 0);
        assertFalse(distributor.rewardState(address(this)).registered);
    }

    function test_onBalanceChange_eligibilityFloor_crossesUpAndDown() public {
        PerkMemeToken floored = _deployRegisteredMeme(Currency.wrap(address(0)), 100 ether, vault);

        floored.transfer(alice, 99 ether);
        assertEq(distributor.eligibleBalanceOf(address(floored), alice), 0);
        assertEq(distributor.rewardState(address(floored)).eligibleSupply, 0);

        floored.transfer(alice, 1 ether);
        assertEq(floored.balanceOf(alice), 100 ether);
        assertEq(distributor.eligibleBalanceOf(address(floored), alice), 100 ether);
        assertEq(distributor.rewardState(address(floored)).eligibleSupply, 100 ether);

        vm.prank(alice);
        floored.transfer(bob, 1 ether);
        assertEq(floored.balanceOf(alice), 99 ether);
        assertEq(distributor.eligibleBalanceOf(address(floored), alice), 0);
        assertEq(distributor.eligibleBalanceOf(address(floored), bob), 0);
        assertEq(distributor.rewardState(address(floored)).eligibleSupply, 0);

        vm.prank(alice);
        floored.transfer(bob, 99 ether);
        assertEq(distributor.eligibleBalanceOf(address(floored), bob), 100 ether);
        assertEq(distributor.rewardState(address(floored)).eligibleSupply, 100 ether);
    }

    function test_onBalanceChange_excludedRecipient_doesNotChangeEligibleSupply() public {
        token.transfer(alice, 1000 ether);
        assertEq(distributor.rewardState(address(token)).eligibleSupply, 1000 ether);

        vm.prank(alice);
        token.transfer(vault, 1000 ether);

        assertEq(distributor.rewardState(address(token)).eligibleSupply, 0);
        assertEq(distributor.eligibleBalanceOf(address(token), vault), 0);
        assertEq(distributor.eligibleBalanceOf(address(token), alice), 0);
    }

    function test_accrueQuoteRewards_zeroEligibleSupply_holdsThenDistributes() public {
        vm.expectEmit(true, false, false, true, address(distributor));
        emit QuoteRewardsHeld(address(token), 100 ether);
        feeRouter.accrue{value: 100 ether}(address(token), 100 ether);
        assertEq(distributor.rewardState(address(token)).pendingUndistributed, 100 ether);

        token.transfer(alice, 50 ether);
        token.transfer(bob, 50 ether);

        vm.expectEmit(true, false, false, true, address(distributor));
        emit QuoteRewardsAccrued(address(token), 150 ether, 100 ether, _expectedAcc(150 ether, 100 ether, 0));
        feeRouter.accrue{value: 50 ether}(address(token), 50 ether);

        assertEq(distributor.rewardState(address(token)).pendingUndistributed, 0);
        (, uint256 aliceClaimable) = distributor.claimableQuoteRewards(address(token), alice);
        (, uint256 bobClaimable) = distributor.claimableQuoteRewards(address(token), bob);
        assertApproxEqAbs(aliceClaimable, 75 ether, 1);
        assertApproxEqAbs(bobClaimable, 75 ether, 1);
    }

    function test_accrueQuoteRewards_reverts_nativeAmountMismatch() public {
        vm.expectRevert(IPerkHolderRewardDistributor.NativeAmountMismatch.selector);
        feeRouter.accrue{value: 1 ether}(address(token), 2 ether);
    }

    function test_accrueQuoteRewards_reverts_erc20MsgValue() public {
        MockERC20 quote = new MockERC20("Quote", "Q", 6);
        PerkMemeToken erc20Meme = _deployRegisteredMeme(Currency.wrap(address(quote)), MIN_ELIGIBLE, vault);
        quote.mint(address(feeRouter), 1000e6);
        feeRouter.approveQuote(quote, 1000e6);

        vm.expectRevert(IPerkHolderRewardDistributor.NativeAmountMismatch.selector);
        feeRouter.accrue{value: 1}(address(erc20Meme), 100e6);
    }

    function test_accrueQuoteRewards_reverts_notFeeRouter() public {
        vm.expectRevert(IPerkHolderRewardDistributor.NotFeeRouter.selector);
        distributor.accrueQuoteRewards{value: 1 ether}(address(token), 1 ether);
    }

    function test_accrueQuoteRewards_erc20_pullsAndPaysClaims() public {
        MockERC20 quote = new MockERC20("Quote", "Q", 6);
        PerkMemeToken erc20Meme = _deployRegisteredMeme(Currency.wrap(address(quote)), MIN_ELIGIBLE, vault);
        erc20Meme.transfer(alice, 75 ether);
        erc20Meme.transfer(bob, 25 ether);

        quote.mint(address(feeRouter), 1000e6);
        feeRouter.approveQuote(quote, 1000e6);
        feeRouter.accrue(address(erc20Meme), 1000e6);

        (, uint256 aliceClaimable) = distributor.claimableQuoteRewards(address(erc20Meme), alice);
        (, uint256 bobClaimable) = distributor.claimableQuoteRewards(address(erc20Meme), bob);
        assertApproxEqAbs(aliceClaimable, 750e6, 1);
        assertApproxEqAbs(bobClaimable, 250e6, 1);

        vm.prank(alice);
        (, uint256 paid) = distributor.claimQuoteRewards(address(erc20Meme));
        assertEq(paid, aliceClaimable);
        assertEq(quote.balanceOf(alice), paid);
    }

    function test_claimQuoteRewards_twoHolders75_25() public {
        token.transfer(alice, 75 ether);
        token.transfer(bob, 25 ether);

        feeRouter.accrue{value: 1000 ether}(address(token), 1000 ether);

        (, uint256 aliceClaimable) = distributor.claimableQuoteRewards(address(token), alice);
        (, uint256 bobClaimable) = distributor.claimableQuoteRewards(address(token), bob);
        assertApproxEqAbs(aliceClaimable, 750 ether, 1);
        assertApproxEqAbs(bobClaimable, 250 ether, 1);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit QuoteRewardsClaimed(address(token), alice, aliceClaimable);
        (Currency quote, uint256 paid) = distributor.claimQuoteRewards(address(token));
        assertEq(Currency.unwrap(quote), address(0));
        assertEq(paid, aliceClaimable);
        assertEq(alice.balance, aliceBefore + paid);

        (, uint256 aliceAfter) = distributor.claimableQuoteRewards(address(token), alice);
        assertEq(aliceAfter, 0);

        vm.prank(alice);
        (, uint256 second) = distributor.claimQuoteRewards(address(token));
        assertEq(second, 0);

        vm.prank(bob);
        (, uint256 bobPaid) = distributor.claimQuoteRewards(address(token));
        assertApproxEqAbs(bobPaid, 250 ether, 1);
        assertEq(bob.balance, bobPaid);
    }

    function test_transfer_afterAccrue_senderKeepsReceiverGetsNone() public {
        token.transfer(alice, 75 ether);
        token.transfer(bob, 25 ether);
        feeRouter.accrue{value: 1000 ether}(address(token), 1000 ether);

        vm.prank(alice);
        token.transfer(carol, 75 ether);

        (, uint256 aliceClaimable) = distributor.claimableQuoteRewards(address(token), alice);
        (, uint256 carolClaimable) = distributor.claimableQuoteRewards(address(token), carol);
        (, uint256 bobClaimable) = distributor.claimableQuoteRewards(address(token), bob);

        assertApproxEqAbs(aliceClaimable, 750 ether, 1);
        assertEq(carolClaimable, 0);
        assertApproxEqAbs(bobClaimable, 250 ether, 1);
    }

    function test_claimQuoteRewards_sellEverything_stillClaimsAccrued() public {
        token.transfer(alice, 40 ether);
        token.transfer(bob, 60 ether);
        feeRouter.accrue{value: 1000 ether}(address(token), 1000 ether);

        (, uint256 aliceAccrued) = distributor.claimableQuoteRewards(address(token), alice);

        vm.prank(alice);
        token.transfer(bob, 40 ether);
        assertEq(token.balanceOf(alice), 0);
        assertEq(distributor.eligibleBalanceOf(address(token), alice), 0);

        vm.prank(alice);
        (, uint256 paid) = distributor.claimQuoteRewards(address(token));
        assertEq(paid, aliceAccrued);
        assertApproxEqAbs(paid, 400 ether, 1);
        assertEq(alice.balance, paid);
    }

    function test_accrueQuoteRewards_carryDustConservation() public {
        token.transfer(alice, 2 ether);
        token.transfer(bob, 1 ether);

        uint256 totalAccrued = 1 ether + 7 + 13;
        feeRouter.accrue{value: 1 ether}(address(token), 1 ether);
        feeRouter.accrue{value: 7}(address(token), 7);
        feeRouter.accrue{value: 13}(address(token), 13);

        (, uint256 aliceClaimable) = distributor.claimableQuoteRewards(address(token), alice);
        (, uint256 bobClaimable) = distributor.claimableQuoteRewards(address(token), bob);
        IPerkHolderRewardDistributor.MemeRewardState memory state_ = distributor.rewardState(address(token));

        uint256 accounted = aliceClaimable + bobClaimable + state_.carry / PerkConstants.REWARD_PRECISION;
        assertLe(accounted, totalAccrued);
        assertLe(totalAccrued, accounted + 2);
    }

    function test_claimQuoteRewardsFor_paysAccountNotCaller() public {
        token.transfer(alice, 10 ether);
        feeRouter.accrue{value: 50 ether}(address(token), 50 ether);

        uint256 aliceBefore = alice.balance;
        uint256 callerBefore = address(this).balance;
        (, uint256 expected) = distributor.claimableQuoteRewards(address(token), alice);

        vm.expectEmit(true, true, false, true, address(distributor));
        emit QuoteRewardsClaimed(address(token), alice, expected);
        (Currency quote, uint256 paid) = distributor.claimQuoteRewardsFor(address(token), alice);

        assertEq(Currency.unwrap(quote), address(0));
        assertEq(paid, expected);
        assertEq(alice.balance, aliceBefore + paid);
        assertEq(address(this).balance, callerBefore);
    }

    function test_claimQuoteRewards_revertingRecipient_blocksOnlyItself() public {
        RevertingNativeReceiver receiver = new RevertingNativeReceiver();
        token.transfer(address(receiver), 50 ether);
        token.transfer(alice, 50 ether);
        feeRouter.accrue{value: 100 ether}(address(token), 100 ether);

        vm.expectRevert();
        distributor.claimQuoteRewardsFor(address(token), address(receiver));

        vm.prank(alice);
        (, uint256 paid) = distributor.claimQuoteRewards(address(token));
        assertApproxEqAbs(paid, 50 ether, 1);
        assertEq(alice.balance, paid);
    }

    function testFuzz_transfersAndAccruals_invariants(uint256[24] memory actions) public {
        token.transfer(alice, 1000 ether);
        token.transfer(bob, 1000 ether);
        token.transfer(carol, 1000 ether);

        address[3] memory holders = [alice, bob, carol];
        uint256 totalAccrued;
        uint256 checkpoints;

        for (uint256 i; i < actions.length; ++i) {
            uint256 action = actions[i];
            if (action % 4 == 0) {
                uint256 amount = bound(action >> 2, 1, 20 ether);
                feeRouter.accrue{value: amount}(address(token), amount);
                totalAccrued += amount;
            } else {
                address from = holders[action % 3];
                address to = holders[(action >> 3) % 3];
                uint256 fromBal = token.balanceOf(from);
                if (fromBal <= MIN_ELIGIBLE) continue;
                uint256 amount = bound(action >> 5, 1, fromBal - MIN_ELIGIBLE);
                vm.prank(from);
                token.transfer(to, amount);
                checkpoints += from == to ? 1 : 2;
            }
        }

        uint256 sumClaimable;
        uint256 sumEligible;
        for (uint256 i; i < holders.length; ++i) {
            (, uint256 claimable) = distributor.claimableQuoteRewards(address(token), holders[i]);
            sumClaimable += claimable;
            uint256 bal = token.balanceOf(holders[i]);
            uint256 eligible = distributor.eligibleBalanceOf(address(token), holders[i]);
            if (bal >= MIN_ELIGIBLE) {
                assertEq(eligible, bal);
                sumEligible += bal;
            } else {
                assertEq(eligible, 0);
            }
        }

        IPerkHolderRewardDistributor.MemeRewardState memory state_ = distributor.rewardState(address(token));
        assertEq(state_.eligibleSupply, sumEligible);
        // Floor identities after checkpoints can leak 1 wei per holder in either direction.
        uint256 dustBound = 3 * (checkpoints + 1);
        assertLe(sumClaimable, totalAccrued + dustBound);
        assertLe(totalAccrued, sumClaimable + state_.pendingUndistributed + dustBound);
    }

    function test_gas_transfer_withCheckpoints() public {
        token.transfer(alice, 1000 ether);
        token.transfer(bob, 1000 ether);

        uint256 gasBefore = gasleft();
        vm.prank(alice);
        token.transfer(bob, 1 ether);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas_transfer_with_checkpoints", gasUsed);
    }

    function test_gas_accrueQuoteRewards() public {
        token.transfer(alice, 1000 ether);
        uint256 amount = 1 ether;
        uint256 gasBefore = gasleft();
        feeRouter.accrue{value: amount}(address(token), amount);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas_accrueQuoteRewards", gasUsed);
    }

    function _deployRegisteredMeme(Currency quote, uint256 minEligible, address extraExcluded)
        internal
        returns (PerkMemeToken deployed)
    {
        deployed = new PerkMemeToken("Perk Meme", "PERK", URI, TOTAL_SUPPLY, address(distributor));
        address[] memory excluded = new address[](3);
        excluded[0] = address(this);
        excluded[1] = extraExcluded;
        excluded[2] = address(feeRouter);
        distributor.registerMeme(address(deployed), quote, address(feeRouter), minEligible, excluded);
    }

    function _expectedAcc(uint256 total, uint256 supply, uint256 carry) private pure returns (uint256) {
        uint256 scaled = total * PerkConstants.REWARD_PRECISION + carry;
        return scaled / supply;
    }
}
